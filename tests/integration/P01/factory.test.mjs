import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createTurnEventCollector } from "../../../dist/packages/application/turn-projection.js";
import { createU10ProtocolFactory } from "./factory.mjs";
import {
  assertQualifiedModel,
  createOwnedExecutionLifecycle,
  createQualifiedModelAdapter,
  resolveGateMode,
  validateLoopbackOrigin,
} from "./factory-policy.mjs";

const origin = "http://127.0.0.1:39173";
const pinnedNode = "C:\\P01\\node.exe";
const electronPath = "C:\\P01\\electron.exe";

function modelOptions(overrides = {}) {
  return {
    modelId: "deepseek-flash",
    providerConfig: {
      access: { apiKey: "p01-u09-loopback-only" },
      api: { baseUrl: `${origin}/v1` },
    },
    ...overrides,
  };
}

async function withOwnedFactoryFixture(t, { failNativeCreate = false, subscriptionFailure = false, startTurn = false } = {}) {
  const temp = realpathSync.native(os.tmpdir());
  const root = await mkdtemp(path.join(temp, "p01-u10-factory-"));
  t.after(async () => {
    const resolved = realpathSync.native(root);
    assert.equal(path.dirname(resolved), temp);
    assert.ok(path.basename(resolved).startsWith("p01-u10-factory-"));
    await rm(resolved, { recursive: true, force: true });
  });
  const dirs = {
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    temp: path.join(root, "temp"),
    userData: path.join(root, "userData"),
    sessionData: path.join(root, "sessionData"),
    appData: path.join(root, "home", "AppData", "Roaming"),
    localAppData: path.join(root, "home", "AppData", "Local"),
    storage: path.join(root, "storage"),
    workspace: path.join(root, "workspace"),
    profileFile: path.join(root, "profile.json"),
    projectConfigFile: path.join(root, "project.json"),
  };
  for (const directory of new Set(Object.values(dirs).filter((value) => !value.endsWith(".json")))) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(dirs.profileFile, `${JSON.stringify({
    schemaVersion: 1,
    providerId: "deepseek-official",
    modelId: "deepseek-flash",
    networkMode: "offline",
  })}\n`);
  await writeFile(dirs.projectConfigFile, "{}\n");
  const env = {
    P01_U10_GATE_MODE: "enabled",
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    ZCODE_DESKTOP_HOME_DIR: dirs.home,
    APPDATA: dirs.appData,
    LOCALAPPDATA: dirs.localAppData,
    TEMP: dirs.temp,
    TMP: dirs.temp,
    ZCODE_STORAGE_DIR: dirs.storage,
    ZCODE_DATA_BASE_DIR: dirs.data,
    ZCODE_DESKTOP_USER_DATA_DIR: dirs.userData,
    ZCODE_DESKTOP_SESSION_DATA_DIR: dirs.sessionData,
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ZCODE_ENDPOINT_ORIGIN: origin,
    ZCODE_BASE_URL: origin,
  };
  let nativeAppCloseCount = 0;
  let executionCloseCount = 0;
  let nativeOptions;
  let gateExecution;
  let gateModel;
  let gateRequest;
  let sessionEventHandler;
  const pluginRoot = path.join(root, "plugin-storage", "plugins", "xiadie");
  const nativeModules = {
    createNodeFileSystemAdapter: () => ({ async readTextFile() {}, async readBinaryFile() {}, async stat() {} }),
    createFileSystemError: ({ code, message }) => Object.assign(new Error(message), { code }),
    createNodeExecutionAdapter: () => ({
      async run(request) { nativeModules.lastExecutionRequest = request; return { status: "completed" }; },
      async close() { executionCloseCount += 1; },
    }),
    createModelAdapter: () => ({
      createModel: () => ({ generateText: async () => ({ text: "unused" }), streamText: () => ({ textStream: [] }), bind() { return this; } }),
      addStatusSink() {},
      setModelIoFullRetentionEnabled() {},
    }),
    createRuntimeAiSdkModelExecutionConfig: () => ({}),
    createTurnEventCollector,
    profile: {
      resolveOwnedProfilePaths: (candidateRoot) => ({
        home: dirs.home,
        data: dirs.data,
        temp: dirs.temp,
        userData: dirs.userData,
        sessionData: dirs.sessionData,
        appData: dirs.appData,
        localAppData: dirs.localAppData,
        storage: dirs.storage,
        workspace: dirs.workspace,
        profileFile: path.join(candidateRoot, "profile.json"),
      }),
      parseProfileV1: (value) => value,
    },
    secrets: { authorizeCredentialReference: () => ({ decision: "no-key" }) },
    pluginApi: {
      async addZCodePluginMarketplace() { return { id: "p01-fixture" }; },
      async installZCodeMarketplacePlugin() {},
      async setZCodePluginEnabled() {},
      listZCodePlugins() { return { plugins: [{ name: "xiadie", enabled: true, rootPath: pluginRoot, dataPath: path.join(pluginRoot, "data") }] }; },
    },
    createXiadieZCodeApp: async (input) => {
      gateExecution = {
        async run(request, options) {
          gateRequest = request;
          return input.executionPort.run.call(input.executionPort, request, options);
        },
        async close() { return input.executionPort.close?.(); },
      };
      gateModel = { marker: "U06-gated-model" };
      const app = await input.native.createZCodeApp({
        ...input.appOptions,
        executionPort: gateExecution,
        modelAdapter: gateModel,
      });
      return {
        app,
        sendInput: (...args) => app.sendInput(...args),
        submitPrompt: (...args) => app.submitPrompt(...args),
        async close() { await app.close?.(); },
      };
    },
  };
  const nativeCreateZCodeApp = async (options) => {
    nativeOptions = options;
    if (failNativeCreate) throw new Error("native fixture construction failed");
    return {
      sessionId: "fixture-session",
      runtime: {
        subscribeEvents({ onSessionEvent }) {
          if (subscriptionFailure) throw new Error("raw subscription error must not escape");
          sessionEventHandler = onSessionEvent;
          return () => { sessionEventHandler = undefined; };
        },
      },
      async sendInput() {
        if (!startTurn) return { kind: "busy" };
        for (const [sequenceNumber, type, payload] of [
          [1, "tool_call_scheduled", { toolCallId: "tool-fixture", toolName: "Read" }],
          [2, "tool_call_result", { toolCallId: "tool-fixture", toolName: "Read", result: { success: true } }],
          [3, "turn_complete", { resultType: "success", response: "fixture reply should only be hashed" }],
        ]) sessionEventHandler?.({ sessionId: "fixture-session", turnId: "fixture-turn", sequenceNumber, type, payload });
        return {
          kind: "started_turn",
          turnId: "fixture-turn",
          completion: Promise.resolve({ turnId: "fixture-turn", response: "fixture reply should only be hashed" }),
        };
      },
      async submitPrompt() { return { turnId: "fixture-turn" }; },
      async close() { nativeAppCloseCount += 1; },
    };
  };
  const create = createU10ProtocolFactory({ nativeCreateZCodeApp, nativeModules, repositoryRoot: root, nodeExecutable: pinnedNode, electronPath });
  return {
    create,
    env,
    root,
    pluginRoot,
    nativeModules,
    get nativeOptions() { return nativeOptions; },
    get gateExecution() { return gateExecution; },
    get gateModel() { return gateModel; },
    get gateRequest() { return gateRequest; },
    set gateExecution(value) { gateExecution = value; },
    set gateModel(value) { gateModel = value; },
    get nativeAppCloseCount() { return nativeAppCloseCount; },
    get executionCloseCount() { return executionCloseCount; },
  };
}

test("candidate gate defaults on and accepts only its explicit modes", () => {
  assert.equal(resolveGateMode(undefined), "enabled");
  assert.equal(resolveGateMode(""), "enabled");
  assert.equal(resolveGateMode("enabled"), "enabled");
  assert.equal(resolveGateMode("disabled"), "disabled");
  for (const value of ["Disabled", "off", "true", " enabled "]) {
    assert.throws(() => resolveGateMode(value), /must be enabled or disabled/);
  }
});

test("unknown gate configuration fails before native app construction; disabled is a pass-through", async () => {
  let nativeCalls = 0;
  const nativeCreateZCodeApp = async (options) => {
    nativeCalls += 1;
    return options;
  };
  const create = createU10ProtocolFactory({ nativeCreateZCodeApp });
  await assert.rejects(create({ env: { P01_U10_GATE_MODE: "typo" } }), /must be enabled or disabled/);
  assert.equal(nativeCalls, 0);

  const options = { env: { P01_U10_GATE_MODE: "disabled" }, sentinel: true };
  assert.equal(await create(options), options);
  assert.equal(nativeCalls, 1);
});

test("model warmup remains available while Pro is denied before inference", async () => {
  let constructions = 0;
  let inferences = 0;
  const delegate = {
    createModel() {
      constructions += 1;
      return {
        async generateText() { inferences += 1; return { text: "unreachable" }; },
        async streamText() { inferences += 1; return { textStream: [] }; },
        bind() { return this; },
      };
    },
    addStatusSink() {},
    setModelIoFullRetentionEnabled() {},
  };
  const adapter = createQualifiedModelAdapter(delegate, { endpointOrigin: origin });
  const model = adapter.createModel(modelOptions({ modelId: "deepseek-v4-pro" }));
  assert.equal(constructions, 1);
  await assert.rejects(async () => model.generateText({ prompt: "test" }), /not qualified/);
  await assert.rejects(async () => model.bind().streamText({ prompt: "test" }), /not qualified/);
  assert.equal(inferences, 0);
});

test("only the approved model, synthetic key, and exact assigned loopback API qualify", () => {
  assert.equal(validateLoopbackOrigin(origin), origin);
  assert.doesNotThrow(() => assertQualifiedModel(modelOptions(), { endpointOrigin: origin }));
  const invalid = [
    [modelOptions({ modelId: "deepseek-v4-pro" }), origin],
    [modelOptions({ providerConfig: { access: { apiKey: "real-looking-key" }, api: { baseUrl: `${origin}/v1` } } }), origin],
    [modelOptions({ providerConfig: { access: { apiKey: "p01-u09-loopback-only" }, api: { baseUrl: "https://api.deepseek.com/v1" } } }), origin],
    [modelOptions({ requestDependencies: { requestAuth: async () => ({ Authorization: "Bearer x" }) } }), origin],
  ];
  for (const [options, endpointOrigin] of invalid) {
    assert.throws(() => assertQualifiedModel(options, { endpointOrigin }));
  }
  for (const endpoint of ["https://127.0.0.1:39173", "http://8.8.8.8:39173", "http://127.0.0.1:9229"]) {
    assert.throws(() => validateLoopbackOrigin(endpoint), /assigned loopback/);
  }
});

test("owned execution adapter closes exactly once across duplicate close calls", async () => {
  let closes = 0;
  const lifecycle = createOwnedExecutionLifecycle({ async close() { closes += 1; } });
  await Promise.all([lifecycle.close(), lifecycle.close(), lifecycle.close()]);
  assert.equal(lifecycle.closed, true);
  assert.equal(closes, 1);
});

test("enabled factory preserves U06 injected ports and pins only its exact identity hook to Node", async (t) => {
  const f = await withOwnedFactoryFixture(t);
  const baseCreateExecutionAdapter = f.nativeModules.createNodeExecutionAdapter;
  f.nativeModules.createNodeExecutionAdapter = (...args) => {
    const port = baseCreateExecutionAdapter(...args);
    f.nativeModules.baseExecution = port;
    return port;
  };
  const app = await f.create({ env: f.env });
  assert.equal(f.nativeOptions.executionPort, f.gateExecution);
  assert.equal(f.nativeOptions.modelAdapter, f.gateModel);
  assert.equal(f.nativeOptions.sourceTitle, "electron");
  assert.equal(f.nativeOptions.runtimeConfig.memory.enabled, false);
  assert.equal(f.nativeOptions.runtimeConfig.mcp.enabled, false);
  assert.deepEqual(f.nativeOptions.runtimeConfig.mcp.servers, {});
  assert.equal(f.nativeOptions.fileSystemPort.readTextFile instanceof Function, true);

  const source = process.env.P01_U10_ZCODE_SOURCE ?? "E:/Xiadie/Xiadie/.runtime/P01/desktop-source";
  const loadNative = (relative) => import(pathToFileURL(path.join(source, relative)).href);
  const { register } = await loadNative("node_modules/tsx/dist/esm/api/index.mjs");
  register();
  const { createConfig } = await loadNative("apps/zcode-cli/packages/adapters/dist/config/index.js");
  const config = createConfig({
    env: f.env,
    userConfigPath: path.join(f.root, "user.json"),
    projectConfigPath: path.join(f.root, "project.json"),
    workingDirectory: path.join(f.root, "workspace"),
  });
  assert.deepEqual(config.sources.user.diagnostics, []);
  assert.equal(config.config.features.mcp, false);
  assert.equal(config.config.features.skill, false);
  assert.equal(config.config.skills.enabled, false);
  const persistedUserConfig = JSON.parse(await readFile(path.join(f.root, "user.json"), "utf8"));
  assert.equal(persistedUserConfig.features.mcp, false);
  assert.equal(persistedUserConfig.features.skill, false);
  assert.equal(persistedUserConfig.skills.enabled, false);

  const request = {
    command: { mode: "argv", file: electronPath, args: [path.join(f.pluginRoot, "hooks", "context.mjs")] },
    env: { set: { ELECTRON_RUN_AS_NODE: "1", keep: "yes" }, unset: [] },
    trace: { attributes: { hookEventName: "UserPromptSubmit" } },
  };
  await f.nativeOptions.executionPort.run(request);
  assert.equal(f.gateRequest.command.file, electronPath);
  assert.equal(f.nativeModules.lastExecutionRequest.command.file, pinnedNode);
  assert.deepEqual(f.nativeModules.lastExecutionRequest.env.set, { keep: "yes" });
  assert.ok(f.nativeModules.lastExecutionRequest.env.unset.includes("ELECTRON_RUN_AS_NODE"));
  const caseVariant = {
    ...request,
    command: {
      ...request.command,
      file: electronPath.toUpperCase(),
      args: [request.command.args[0].toUpperCase()],
    },
  };
  await f.nativeOptions.executionPort.run(caseVariant);
  assert.equal(f.nativeModules.lastExecutionRequest.command.file, pinnedNode);
  await app.close();
  assert.equal(f.nativeAppCloseCount, 1);
  assert.equal(f.executionCloseCount, 1);
});

test("enabled factory closes its owned adapter if native app construction fails", async (t) => {
  const f = await withOwnedFactoryFixture(t, { failNativeCreate: true });
  const baseCreateExecutionAdapter = f.nativeModules.createNodeExecutionAdapter;
  f.nativeModules.createNodeExecutionAdapter = (...args) => {
    const port = baseCreateExecutionAdapter(...args);
    f.nativeModules.baseExecution = port;
    return port;
  };
  await assert.rejects(f.create({ env: f.env }), /native fixture construction failed/);
  assert.equal(f.executionCloseCount, 1);
});

test("projection sidecar records correlated tool evidence and hashes reply text", async (t) => {
  const f = await withOwnedFactoryFixture(t, { startTurn: true });
  const baseCreateExecutionAdapter = f.nativeModules.createNodeExecutionAdapter;
  f.nativeModules.createNodeExecutionAdapter = (...args) => {
    const port = baseCreateExecutionAdapter(...args);
    f.nativeModules.baseExecution = port;
    return port;
  };
  const app = await f.create({ env: f.env });
  const result = await app.sendInput("fixture prompt");
  await result.completion;
  const sidecarPath = path.join(f.root, "u10-turn-projections.jsonl");
  let contents;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { contents = await readFile(sidecarPath, "utf8"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal(typeof contents, "string");
  const row = JSON.parse(contents.trim());
  assert.equal(row.sessionId, "fixture-session");
  assert.equal(row.turnId, "fixture-turn");
  assert.equal(row.projectionStatus, "projected");
  assert.deepEqual(row.requiredToolCallIds, ["tool-fixture"]);
  assert.deepEqual(row.toolReceipts, [{ toolCallId: "tool-fixture", toolName: "Read", status: "succeeded" }]);
  assert.equal(row.evidenceStatus, "verified");
  assert.equal(row.replyBytes, Buffer.byteLength("fixture reply should only be hashed", "utf8"));
  assert.equal(contents.includes("fixture reply should only be hashed"), false);
  await app.close();
});

test("projection subscription failure is recorded as unavailable without exposing the error", async (t) => {
  const f = await withOwnedFactoryFixture(t, { startTurn: true, subscriptionFailure: true });
  const baseCreateExecutionAdapter = f.nativeModules.createNodeExecutionAdapter;
  f.nativeModules.createNodeExecutionAdapter = (...args) => {
    const port = baseCreateExecutionAdapter(...args);
    f.nativeModules.baseExecution = port;
    return port;
  };
  const app = await f.create({ env: f.env });
  const result = await app.sendInput("fixture prompt");
  await result.completion;
  const sidecarPath = path.join(f.root, "u10-turn-projections.jsonl");
  let contents;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { contents = await readFile(sidecarPath, "utf8"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal(typeof contents, "string");
  const row = JSON.parse(contents.trim());
  assert.equal(row.projectionStatus, "unavailable");
  assert.equal(row.reason, "event_subscription_failed");
  assert.equal(contents.includes("raw subscription error"), false);
  await app.close();
});
