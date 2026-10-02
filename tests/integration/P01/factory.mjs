import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createReadOnlyWorkspaceFileSystemPort } from "./read-only-workspace.mjs";
import {
  createOwnedExecutionLifecycle,
  createQualifiedModelAdapter,
  resolveGateMode,
  validateLoopbackOrigin,
} from "./factory-policy.mjs";

const GATE_ENV = "P01_U10_GATE_MODE";
const APPROVED_MODEL_ID = "deepseek-flash";
const PLUGIN_NAME = "xiadie";
const SYNTHETIC_ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

function physicalChild(root, candidate, label) {
  const absolute = path.resolve(candidate);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`P01 ${label} must remain inside the owned profile`);
  }
  return absolute;
}

async function resolveOwnedContext(env, profileModule, secretsModule) {
  if (!env || typeof env !== "object") throw new Error("P01 owned environment is missing");
  const storageRoot = env.ZCODE_STORAGE_DIR;
  if (typeof storageRoot !== "string" || !path.isAbsolute(storageRoot)) {
    throw new Error("P01 owned storage directory is missing");
  }
  const root = path.dirname(path.resolve(storageRoot));
  const paths = profileModule.resolveOwnedProfilePaths(root);
  if (paths.storage !== path.resolve(storageRoot) || paths.home !== env.HOME || paths.home !== env.USERPROFILE ||
      paths.home !== env.ZCODE_DESKTOP_HOME_DIR ||
      paths.data !== env.ZCODE_DATA_BASE_DIR || paths.temp !== env.TEMP || paths.temp !== env.TMP ||
      paths.userData !== env.ZCODE_DESKTOP_USER_DATA_DIR || paths.sessionData !== env.ZCODE_DESKTOP_SESSION_DATA_DIR ||
      paths.appData !== env.APPDATA || paths.localAppData !== env.LOCALAPPDATA ||
      env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1" ||
      env.ZCODE_BASE_URL !== validateLoopbackOrigin(env.ZCODE_ENDPOINT_ORIGIN)) {
    throw new Error("P01 child environment does not match its owned profile paths");
  }
  const profileFile = physicalChild(root, paths.profileFile, "profile file");
  if (!(await stat(profileFile)).isFile()) throw new Error("P01 portable profile is missing");
  const profile = profileModule.parseProfileV1(JSON.parse(await readFile(profileFile, "utf8")));
  if (profile.credentialRef !== undefined) throw new Error("P01 candidate profile cannot reference credentials");
  const credentialDecision = secretsModule.authorizeCredentialReference(profile, { kind: "offline" });
  if (credentialDecision.decision !== "no-key") throw new Error("P01 candidate profile must have no credential");
  if (profile.modelId !== APPROVED_MODEL_ID) throw new Error("P01 candidate profile model is not qualified");
  return { root, paths, profile, credentialDecision };
}

async function installIdentityPlugin({ root, paths, env, pluginApi, repositoryRoot }) {
  const pluginStorageRoot = path.join(root, "plugin-storage");
  const userConfigPath = path.join(root, "user.json");
  const projectConfigPath = path.join(root, "project.json");
  const marketplaceSource = path.join(repositoryRoot, "plugins", "xiadie", "marketplace.json");
  await mkdir(pluginStorageRoot, { recursive: true });
  const marketplace = await pluginApi.addZCodePluginMarketplace({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env,
    source: marketplaceSource,
  });
  await pluginApi.installZCodeMarketplacePlugin({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env,
    marketplace: marketplace.id,
    pluginName: PLUGIN_NAME,
  });
  await pluginApi.setZCodePluginEnabled({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env,
    plugin: `${PLUGIN_NAME}@${marketplace.id}`,
    enabled: true,
  });
  let userConfig = {};
  try { userConfig = JSON.parse(await readFile(userConfigPath, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw new Error("P01 isolated user config is invalid"); }
  userConfig.storage = { ...(userConfig.storage ?? {}), dir: paths.storage };
  const currentFeatures = userConfig.features && typeof userConfig.features === "object" && !Array.isArray(userConfig.features)
    ? userConfig.features
    : {};
  const currentSkills = userConfig.skills && typeof userConfig.skills === "object" && !Array.isArray(userConfig.skills)
    ? userConfig.skills
    : {};
  userConfig.features = { ...currentFeatures, mcp: false, skill: false };
  userConfig.skills = { ...currentSkills, enabled: false };
  await writeFile(userConfigPath, `${JSON.stringify(userConfig, null, 2)}\n`, "utf8");
  const discovered = pluginApi.listZCodePlugins({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env,
  });
  const plugin = discovered.plugins.find((item) => item.name === PLUGIN_NAME);
  if (!plugin?.enabled || typeof plugin.rootPath !== "string" || typeof plugin.dataPath !== "string") {
    throw new Error("P01 identity plugin installation failed");
  }
  return { pluginStorageRoot, userConfigPath, projectConfigPath, plugin };
}

function isIdentityHookRequest(request, installedPluginRoot, electronPath) {
  const trace = request?.trace;
  const command = request?.command;
  const expectedHook = path.resolve(installedPluginRoot, "hooks", "context.mjs");
  const normalizePath = (value) => path.resolve(value).replaceAll("/", "\\").toLowerCase();
  const commandFile = typeof command?.file === "string" ? command.file.toLowerCase() : "";
  return command?.mode === "argv" && Array.isArray(command.args) && command.args.length === 1 &&
    typeof command.args[0] === "string" && normalizePath(command.args[0]) === normalizePath(expectedHook) &&
    trace?.attributes?.hookEventName === "UserPromptSubmit" &&
    (commandFile === "node" || commandFile === "node.exe" ||
      (commandFile.length > 0 && normalizePath(command.file) === normalizePath(electronPath)));
}

function pinHookToNode(request, nodeExecutable) {
  const set = { ...(request.env?.set ?? {}) };
  for (const key of Object.keys(set)) {
    if (key.toUpperCase() === SYNTHETIC_ELECTRON_RUN_AS_NODE) delete set[key];
  }
  const unset = [...new Set([...(request.env?.unset ?? []), SYNTHETIC_ELECTRON_RUN_AS_NODE])];
  return {
    ...request,
    command: { ...request.command, file: nodeExecutable },
    env: { ...request.env, set, unset },
  };
}

function pinIdentityHookToNode(executionPort, pluginRoot, electronPath, nodeExecutable) {
  const port = Object.create(executionPort);
  Object.defineProperty(port, "run", {
    value(request, options) {
      if (isIdentityHookRequest(request, pluginRoot, electronPath)) {
        return executionPort.run.call(executionPort, pinHookToNode(request, nodeExecutable), options);
      }
      return executionPort.run.call(executionPort, request, options);
    },
  });
  for (const name of ["start", "getBackgroundTask", "readBackgroundBashOutput", "cancelBackgroundTask", "close"]) {
    const method = executionPort[name];
    if (typeof method === "function") {
      Object.defineProperty(port, name, { value: (...args) => method.apply(executionPort, args) });
    }
  }
  return port;
}

function eventTurnId(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return typeof event?.turnId === "string" ? event.turnId :
    typeof payload.turnId === "string" ? payload.turnId : undefined;
}

function scheduledToolId(event) {
  if (event?.type !== "tool_call_scheduled") return undefined;
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
}

function projectionSidecar(hostApp, root, createTurnEventCollector) {
  const file = path.join(root, "u10-turn-projections.jsonl");
  const pendingCleanups = new Set();
  function wrap(methodName, method) {
    if (typeof method !== "function") return method;
    return async (...args) => {
      const collector = createTurnEventCollector(hostApp.sessionId);
      const scheduled = [];
      let unsubscribe;
      let turnId;
      let subscriptionFailed = false;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        pendingCleanups.delete(cleanup);
        try { unsubscribe?.(); } catch { /* preserve native lifecycle */ }
        collector.close();
      };
      pendingCleanups.add(cleanup);
      try {
        unsubscribe = hostApp.runtime.subscribeEvents({
          onSessionEvent(event) {
            collector.onSessionEvent(event);
            const toolCallId = scheduledToolId(event);
            if (toolCallId) scheduled.push({ turnId: eventTurnId(event), toolCallId });
          },
        });
      } catch {
        subscriptionFailed = true;
      }
      const appendFailure = async (reason) => {
        const row = {
          schemaVersion: 1,
          sessionId: hostApp.sessionId,
          ...(turnId ? { turnId } : {}),
          projectionStatus: "unavailable",
          reason,
        };
        try { await appendFile(file, `${JSON.stringify(row)}\n`, "utf8"); }
        catch { process.stderr.write("P01_PROJECTION_SIDECAR_WRITE_FAILED\n"); }
        cleanup();
      };
      const record = async (id, result) => {
        turnId = id;
        try {
          if (subscriptionFailed) throw new Error("event_subscription_failed");
          if (!turnId) throw new Error("missing_turn_id");
          const requiredToolCallIds = scheduled.filter((item) => item.turnId === turnId).map((item) => item.toolCallId);
          const projection = collector.project(result, requiredToolCallIds);
          const reply = projection.reply.text;
          const row = {
            schemaVersion: 1,
            sessionId: projection.sessionId,
            turnId: projection.turnId,
            projectionStatus: "projected",
            lifecycle: projection.lifecycle,
            resultType: projection.resultType,
            evidenceStatus: projection.evidenceStatus,
            requiredToolCallIds: projection.requiredToolCallIds,
            toolReceipts: projection.toolReceipts,
            hookBlocked: projection.hookBlocked,
            replySource: projection.reply.source,
            replyBytes: Buffer.byteLength(reply, "utf8"),
            replySha256: createHash("sha256").update(reply).digest("hex"),
            capturedAt: new Date().toISOString(),
          };
          await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
        } catch {
          await appendFailure(subscriptionFailed ? "event_subscription_failed" : "projection_failed");
          return;
        }
        cleanup();
      };
      try {
        const result = await method(...args);
        if (methodName === "sendInput" && result?.kind === "started_turn" && result.completion && result.turnId) {
          turnId = result.turnId;
          collector.bindTurn(turnId);
          void Promise.resolve(result.completion).then(
            (completion) => record(turnId, completion),
            () => appendFailure("turn_completion_failed"),
          );
        } else if (methodName === "submitPrompt" && typeof result?.turnId === "string") {
          turnId = result.turnId;
          collector.bindTurn(turnId);
          void record(turnId, result);
        } else {
          cleanup();
        }
        return result;
      } catch (error) {
        cleanup();
        throw error;
      }
    };
  }
  return {
    wrap,
    closePending() { for (const cleanup of [...pendingCleanups]) cleanup(); },
  };
}

function createAppFacade(host, sidecar, executionLifecycle) {
  const app = Object.create(null);
  let current = host.app;
  const descriptors = new Map();
  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (!descriptors.has(key)) descriptors.set(key, Object.getOwnPropertyDescriptor(current, key));
    }
    current = Object.getPrototypeOf(current);
  }
  for (const [key, descriptor] of descriptors) {
    if (key === "constructor" || key === "sendInput" || key === "submitPrompt" || key === "close") continue;
    if (descriptor?.get) {
      Object.defineProperty(app, key, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => Reflect.get(host.app, key, host.app),
      });
    } else {
      const value = Reflect.get(host.app, key, host.app);
      Object.defineProperty(app, key, {
        configurable: true,
        enumerable: descriptor?.enumerable,
        value: typeof value === "function" ? (...args) => value.apply(host.app, args) : value,
      });
    }
  }
  Object.defineProperties(app, {
    sendInput: { configurable: true, value: sidecar.wrap("sendInput", host.sendInput.bind(host)) },
    submitPrompt: { configurable: true, value: sidecar.wrap("submitPrompt", host.submitPrompt.bind(host)) },
    close: {
      configurable: true,
      value: async (...args) => {
        sidecar.closePending();
        try { await host.close?.(...args); }
        finally { await executionLifecycle.close(); }
      },
    },
  });
  return app;
}

export function createU10ProtocolFactory({
  nativeCreateZCodeApp,
  nativeModules,
  repositoryRoot,
  nodeExecutable,
  electronPath,
}) {
  return async function createZCodeApp(appOptions = {}) {
    const env = appOptions.env ?? process.env;
    const mode = resolveGateMode(env[GATE_ENV]);
    if (mode === "disabled") return nativeCreateZCodeApp(appOptions);

    const { root, paths, profile } = await resolveOwnedContext(env, nativeModules.profile, nativeModules.secrets);
    const pluginInfo = await installIdentityPlugin({
      root,
      paths,
      env,
      pluginApi: nativeModules.pluginApi,
      repositoryRoot,
    });

    let executionLifecycle;
    try {
      const baseFileSystem = nativeModules.createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
      const fileSystemPort = createReadOnlyWorkspaceFileSystemPort(
        baseFileSystem,
        paths.workspace,
        nativeModules.createFileSystemError,
      );
  const executionPort = nativeModules.createNodeExecutionAdapter({
        onToolExecResource: appOptions.onToolExecResource,
        outputRootDir: path.join(paths.storage, "cli", "exec"),
        processEnv: env,
      });
      executionLifecycle = createOwnedExecutionLifecycle(executionPort);
      const modelAdapter = createQualifiedModelAdapter(nativeModules.createModelAdapter({
        env,
        modelIoDir: path.join(paths.storage, "model-io"),
        modelIoFullRetentionEnabled: false,
        executionConfig: nativeModules.createRuntimeAiSdkModelExecutionConfig(env, {
          appVersion: appOptions.version,
          sourceTitle: "electron",
        }),
      }), { endpointOrigin: env.ZCODE_ENDPOINT_ORIGIN });
      const runtimeConfig = {
        ...appOptions.runtimeConfig,
        mcp: { ...appOptions.runtimeConfig?.mcp, enabled: false, servers: {} },
        memory: { enabled: false, use: false, extractionEnabled: false },
        dynamicWorkflowEnabled: false,
        toolAllowlist: ["Read"],
        workingDirectory: paths.workspace,
      };
      const wrappedOptions = {
        ...appOptions,
        env,
        sourceTitle: "electron",
        runtimeConfig,
        executionPort: undefined,
        modelAdapter: undefined,
        pluginStorageRoot: pluginInfo.pluginStorageRoot,
        userConfigPath: pluginInfo.userConfigPath,
        projectConfigPath: pluginInfo.projectConfigPath,
        workingDirectory: paths.workspace,
        skipUserConfig: false,
        officialPluginRoots: [],
        fileSystemPort,
        mcpPortFactory: undefined,
        mcpPort: undefined,
        skillPort: undefined,
      };
      const hostExecutionPort = pinIdentityHookToNode(
        executionPort,
        pluginInfo.plugin.rootPath,
        electronPath,
        nodeExecutable,
      );
      const host = await nativeModules.createXiadieZCodeApp({
        native: {
          createZCodeApp: async (nativeOptions) => {
            try {
              // U06 has already wrapped these ports. Keep its wrappers in the
              // native app; the owned adapter only normalizes its exact plugin
              // hook request after U06 has authorized the turn.
              const app = await nativeCreateZCodeApp(nativeOptions);
              return wrapNativeClose(app, () => executionLifecycle.close());
            } catch (error) {
              await executionLifecycle.close();
              throw error;
            }
          },
          getCurrentModelInvocationContext: nativeModules.getCurrentModelInvocationContext,
        },
        appOptions: wrappedOptions,
        executionPort: hostExecutionPort,
        modelAdapter,
        enabled: true,
        assetsRoot: path.join(repositoryRoot, "assets", "character"),
        moduleRoot: path.join(repositoryRoot, "dist"),
        installedPluginRoot: pluginInfo.plugin.rootPath,
        dataRoot: pluginInfo.plugin.dataPath,
        pluginStorageRoot: pluginInfo.pluginStorageRoot,
        ownedProfileRoot: root,
        // The native Desktop originates this request with Electron execPath.
        // U06 uses this value to recognize and authorize that exact hook before
        // the lower adapter pins the spawned process to the bundled Node.
        nodeExecutable: electronPath,
      });
      const sidecar = projectionSidecar(host.app, root, nativeModules.createTurnEventCollector);
      return createAppFacade(host, sidecar, executionLifecycle);
    } catch (error) {
      await executionLifecycle?.close();
      throw error;
    }
  };
}

function wrapNativeClose(app, closeExecutionPort) {
  let closePromise;
  const facade = Object.create(app);
  Object.defineProperty(facade, "close", {
    configurable: true,
    value() {
      closePromise ??= Promise.resolve().then(async () => {
        try { await app.close?.(); }
        finally { await closeExecutionPort(); }
      });
      return closePromise;
    },
  });
  return facade;
}

