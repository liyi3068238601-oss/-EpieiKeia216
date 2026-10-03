// Reused local P01 Native fixture helpers; old test cases are not copied.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const hostRoot = "E:\\Xiadie\\Xiadie";
const profilesRoot = path.join(hostRoot, ".runtime/P02/experiments/u10/native");
await mkdir(profilesRoot, { recursive: true });
const workerProfile = await mkdtemp(path.join(profilesRoot, "native-"));
const workerTemp = path.join(workerProfile, "temp");
const workerHome = path.join(workerProfile, "home");
await mkdir(workerTemp);
await mkdir(workerHome);
Object.assign(process.env, { TEMP: workerTemp, TMP: workerTemp, HOME: workerHome, USERPROFILE: workerHome });
assert.equal(await realpath(os.tmpdir()), await realpath(workerTemp));
const sourceRoot = process.env.P01_U06_ZCODE_SOURCE ?? path.join(hostRoot, ".runtime/P01/desktop-source");
assert.equal(execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), "29628c9acdb81b703bbd4080c207a0e7ce5e276e");
assert.equal(execFileSync("git", ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "");
const tsxApiUrl = pathToFileURL(path.join(sourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href;
const { register: registerTsx } = await import(tsxApiUrl);
registerTsx();
const nativeBootstrapUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "index.js")).href;
const nativeContractsUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "contracts", "dist", "model", "invocation-context.js")).href;
const nativeProviderRegistryUrl = pathToFileURL(path.join(sourceRoot, "packages", "provider", "src", "registry.ts")).href;
const nativeModelRunnerUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "model", "runner.js")).href;
const localFsUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "fs", "index.js")).href;
const hostModuleUrl = pathToFileURL(path.join(testDirectory, "durable-host.mjs")).href;

const native = await import(nativeBootstrapUrl);
const nativeContracts = await import(nativeContractsUrl);
const providerModule = await import(nativeProviderRegistryUrl);
const nativeModelRunner = await import(nativeModelRunnerUrl);
const { createDurableHost: createXiadieZCodeApp } = await import(hostModuleUrl);
const { openEventStore } = await import(pathToFileURL(path.join(repositoryRoot, "dist/packages/storage/events/src/index.js")).href);
const { backupAndMigrateEventStore, restoreEventStoreBackup } = await import(pathToFileURL(path.join(repositoryRoot, "dist/packages/storage/backup/src/index.js")).href);
const { executeOperationOnce } = await import(pathToFileURL(path.join(repositoryRoot, "dist/packages/application/recovery/src/index.js")).href);
const { DatabaseSync } = await import("node:sqlite");

test("actual Native scenario uses scoped durable SQLite and masked source evidence", async (t) => {
  const scenario = process.env.P02_U10_SCENARIO ?? "success-backup-restore";
  const fixture = await createFixture(t, { enabled: true, holdFirstMockResponse: ["cancel", "inflight-close"].includes(scenario) });
  const events = [];
  fixture.host.app.runtime.subscribeEvents({ onSessionEvent: (event) => events.push(event) });
  let blocker;
  const diagnosticCanary = "P02_PRIVATE_PROMPT_CANARY";
  const prompt = `Read allowed.txt and report its marker. ${diagnosticCanary}`;
  if (scenario === "writer-busy") {
    blocker = new DatabaseSync(fixture.host.databasePath);
    blocker.exec("BEGIN IMMEDIATE");
    t.after(() => { try { blocker?.exec("ROLLBACK"); } finally { blocker?.close(); } });
  }
  if (scenario === "tool-failure") await rm(path.join(fixture.workspace, "allowed.txt"));
  if (["cancel", "inflight-close"].includes(scenario)) {
    const controller = new AbortController();
    const admission = await fixture.host.sendInput({ text: prompt }, { abortSignal: controller.signal });
    assert.equal(admission.kind, "started_turn");
    await waitFor(() => fixture.mock.requests.length > 0);
    await assert.rejects(fixture.host.sendInput("overlap"), /DURABLE_HOST_NOT_IDLE/);
    if (scenario === "inflight-close") await fixture.host.close();
    else controller.abort();
    await Promise.allSettled([admission.completion]);
    assert.equal(fixture.host.readDurableRecords()[0].lifecycle, "cancel");
    assert.equal(fixture.host.readDurableRecords()[0].status, "saved");
    if (scenario === "cancel") {
      const next = await fixture.host.sendInput({ text: "Say MOCK_NO_TOOL after cancellation." });
      await next.completion;
      assert.equal(fixture.host.readDurableRecords()[1].lifecycle, "success");
      assert.equal(fixture.host.readDurableRecords()[1].status, "saved");
    } else await assert.rejects(fixture.host.sendInput("after close"), /DURABLE_HOST_NOT_IDLE/);
  } else {
    if (scenario === "native-failure") await fixture.host.submitPrompt(prompt).catch(() => {});
    else await fixture.host.submitPrompt(prompt);
    const record = fixture.host.readDurableRecords()[0];
    assert.ok(record.scope && record.attemptId);
    if (scenario === "writer-busy") {
      assert.equal(record.status, "failed");
      assert.equal(record.lifecycle, "unavailable");
      assert.ok(record.codes.includes("NO_COMMITTED_HISTORY"));
      blocker.exec("ROLLBACK"); blocker.close(); blocker = undefined;
    } else {
      assert.equal(record.status, "saved", JSON.stringify(record));
      assert.equal(record.lifecycle, scenario === "native-failure" ? "failure" : "success");
      if (scenario === "tool-failure") assert.ok(events.some((event) => event.type === "tool_call_error"));
      const diagnostics = await fixture.host.exportDiagnostics(record);
      assert.equal(diagnostics.status, "built");
      assert.ok(diagnostics.report.captures.length > 0);
      assert.equal(diagnostics.report.captures[0].rawSource.currentValidation, "NOT_VERIFIED");
      assert.equal(JSON.stringify(diagnostics).includes(diagnosticCanary), false);
      assert.equal(JSON.stringify(diagnostics).includes(fixture.profile), false);
      assert.equal(JSON.stringify(diagnostics).includes(record.scope.sessionId), false);
      const reader = openEventStore({ path: fixture.host.databasePath, readOnly: true });
      try {
        const observations = reader.readObservations({ scope: record.scope, limit: 256 }).items;
        const capture = observations.find((row) => row.capture)?.capture;
        assert.ok(capture);
        await assert.rejects(readFile(path.join(fixture.temp, capture.origin.temporaryLocator)), { code: "ENOENT" });
        assert.equal(capture.snapshot.messages[0].text, "[REDACTED]");
      } finally { await reader.close(); }
    }
  }
  const databasePath = fixture.host.databasePath;
  const records = fixture.host.readDurableRecords();
  await fixture.host.close();
  let backup;
  if (scenario === "success-backup-restore") {
    const backups = path.join(fixture.profile, "backups"); await mkdir(backups);
    backup = await backupAndMigrateEventStore({ databasePath, backupDirectory: backups });
    const restored = await restoreEventStoreBackup({ backupPath: backup.backupPath, destinationDirectory: path.join(fixture.profile, "restored") });
    assert.deepEqual(restored.verification, backup.sourceVerification);
  }
  if (scenario === "recovery") {
    const reopened = await fixture.reopen(fixture.host.app.sessionId);
    assert.equal(reopened.readRecovery().attempts[0].lifecycle, "success");
    assert.equal(reopened.readRecovery().needsReview, false);
    const before = fixture.mock.requests.length;
    await reopened.resume();
    assert.equal(fixture.mock.requests.length, before);
    await reopened.close();
    const store = openEventStore({ path: databasePath });
    let effects = 0;
    const unknown = await executeOperationOnce(store, { scope: records[0].scope, attemptId: records[0].attemptId,
      intent: { operationId: "owned-unknown-effect", occurredAt: new Date().toISOString(), operation: "synthetic-local-effect", input: { fixture: true } } },
      async () => { effects++; await writeFile(path.join(fixture.profile, "effect.txt"), "OWNED_EFFECT_ONCE\n"); return { status: "unknown", result: null }; });
    assert.equal(unknown.status, "unknown"); assert.equal(effects, 1);
    const retry = await executeOperationOnce(store, { scope: records[0].scope, attemptId: records[0].attemptId,
      intent: { operationId: "owned-unknown-effect", occurredAt: new Date().toISOString(), operation: "synthetic-local-effect", input: { fixture: true } } },
      async () => { effects++; return { status: "success", result: null }; });
    assert.equal(retry.dispatched, false); assert.equal(effects, 1);
    await store.close();
    const blocked = await fixture.reopen(fixture.host.app.sessionId);
    assert.equal(blocked.readRecovery().operations[0].status, "unknown");
    await assert.rejects(blocked.resume(), /RECOVERY_NEEDS_REVIEW/);
  }
  assert.equal(fixture.mock.nonLoopbackRequests, 0);
  assert.ok(events.some((event) => event.type === "turn_started"));
  assert.equal(fixture.execution.hookRuns > 0, true);
  const runtimeInputs = [];
  for (const url of [nativeBootstrapUrl, nativeContractsUrl, nativeProviderRegistryUrl, nativeModelRunnerUrl, localFsUrl]) {
    const file = fileURLToPath(url);
    const bytes = await readFile(file);
    runtimeInputs.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  process.stdout.write(`P02_NATIVE_RESULT ${JSON.stringify({ scenario, profile: fixture.profile, databasePath, records,
    eventTypes: [...new Set(events.map((event) => event.type))], mockRequests: fixture.mock.requests.length,
    ports: fixture.mock.ports, sourcePin: "29628c9acdb81b703bbd4080c207a0e7ce5e276e", runtimeInputs, processTempVerified: true,
    ...(backup ? { backupSha256: backup.backupSha256, content: backup.sourceVerification } : {}) })}\n`);
});


async function createFixture(t, options) {
  await mkdir(profilesRoot, { recursive: true });
  const profile = workerProfile;
  const home = path.join(profile, "home");
  const temp = path.join(profile, "temp");
  const workspace = path.join(profile, "workspace");
  const pluginStorageRoot = path.join(profile, "plugin-storage");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temp, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeFile(path.join(workspace, "AGENTS.md"), "Do not read forbidden.txt. For this test, use only allowed.txt.\n", "utf8");
  await writeFile(path.join(workspace, "allowed.txt"), "MOCK_ALLOWED_FILE\n", "utf8");
  await writeFile(path.join(workspace, "forbidden.txt"), "MUST_NOT_BE_READ\n", "utf8");

  const userConfigPath = path.join(profile, "user.json");
  const projectConfigPath = path.join(profile, "project.json");
  const marketplace = await native.addZCodePluginMarketplace({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: workspace,
    env: safeEnvironment(home, temp),
    source: path.join(repositoryRoot, "plugins", "xiadie", "marketplace.json"),
  });
  await native.installZCodeMarketplacePlugin({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: workspace,
    env: safeEnvironment(home, temp),
    marketplace: marketplace.id,
    pluginName: "xiadie",
  });
  await native.setZCodePluginEnabled({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: workspace,
    env: safeEnvironment(home, temp),
    plugin: `xiadie@${marketplace.id}`,
    enabled: options.pluginEnabled ?? options.enabled,
  });

  let userConfig = {};
  try { userConfig = JSON.parse(await readFile(userConfigPath, "utf8")); } catch {}
  userConfig.storage = { ...(userConfig.storage ?? {}), dir: path.join(profile, "storage") };
  await writeFile(userConfigPath, JSON.stringify(userConfig, null, 2), "utf8");
  const discovered = native.listZCodePlugins({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: workspace,
    env: safeEnvironment(home, temp),
  });
  const plugin = discovered.plugins.find((item) => item.name === "xiadie");
  assert.ok(plugin, "native plugin discovery finds the installed Xiadie plugin");
  assert.equal(plugin.enabled, options.pluginEnabled ?? options.enabled);
  assert.equal(typeof plugin.rootPath, "string", "native runtime metadata supplies the installed plugin root");
  assert.equal(typeof plugin.dataPath, "string", "native runtime metadata supplies the owned plugin data root");
  if (options.fault === "unknown-path") {
    const hookFile = path.join(plugin.rootPath, "hooks", "hooks.json");
    const hookConfig = JSON.parse(await readFile(hookFile, "utf8"));
    await copyFile(path.join(plugin.rootPath, "hooks", "context.mjs"), path.join(plugin.rootPath, "hooks", "alternate-context.mjs"));
    hookConfig.hooks.UserPromptSubmit[0].hooks[0].args = ["${ZCODE_PLUGIN_ROOT}/hooks/alternate-context.mjs"];
    await writeFile(hookFile, JSON.stringify(hookConfig, null, 2), "utf8");
  }

  const mock = await startMockProvider(path.join(workspace, "allowed.txt"), { holdFirstResponse: options.holdFirstMockResponse,
    readOnce: process.env.P02_U10_SCENARIO === "tool-failure", fail: process.env.P02_U10_SCENARIO === "native-failure" });
  let host;
  t.after(async () => {
    await host?.close?.();
    await mock.close();
    // Retain owned profile and exact SQLite/Hook artifacts as integration evidence, including failures.
  });
  const providerRegistry = new providerModule.ProviderRegistry([createProvider(mock.baseUrl)]);
  const execution = createExecutionPort({ fault: options.fault, profile, home, temp, nativeContext: nativeContracts.getCurrentModelInvocationContext });
  const model = createObservedNativeModelAdapter(
    new nativeModelRunner.AiSdkModelAdapter({ env: safeEnvironment(home, temp) }),
    nativeContracts.getCurrentModelInvocationContext,
    () => execution.lastHookContext,
  );
  const assetsRoot = options.invalidAssets ? path.join(profile, "invalid-assets") : path.join(repositoryRoot, "assets", "character");
  if (options.invalidAssets) await mkdir(assetsRoot, { recursive: true });
  const hostOptions = {
    native: {
      createZCodeApp: native.createZCodeApp,
      getCurrentModelInvocationContext: nativeContracts.getCurrentModelInvocationContext,
    },
    appOptions: {
      providerRegistry,
      runtimeConfig: {
        mode: "plan",
        memory: { enabled: false, use: false, extractionEnabled: false },
        dynamicWorkflowEnabled: false,
        modelSelection: { providerId: "u06-mock", modelId: "mock-model", options: { reasoningLevel: "none" } },
        modelStreaming: "off",
        toolAllowlist: ["Read"],
        workingDirectory: workspace,
        maxTurns: 4,
      },
      pluginStorageRoot,
      userConfigPath,
      projectConfigPath,
      workingDirectory: workspace,
      skipUserConfig: false,
      officialPluginRoots: [],
      fileSystemPort: await createBoundedFileSystemPort(),
      env: safeEnvironment(home, temp),
    },
    executionPort: execution.port,
    modelAdapter: model.adapter,
    enabled: options.enabled,
    assetsRoot,
    moduleRoot: path.join(repositoryRoot, "dist"),
    installedPluginRoot: plugin.rootPath,
    dataRoot: plugin.dataPath,
    ownedProfileRoot: profile,
    pluginStorageRoot,
    nodeExecutable: process.execPath,
  };
  host = await createXiadieZCodeApp(hostOptions);
  assert.equal(host.app.runtime.isProjectMemoryEnabled(), false, "the supported fixture profile disables project-memory extraction");
  const fixture = { profile, workspace, home, temp, host, plugin, mock, model, execution };
  fixture.reopen = async (sessionId) => {
    await host.close?.();
    host = await createXiadieZCodeApp({
      ...hostOptions,
      appOptions: { ...hostOptions.appOptions, sessionId, resume: true },
    });
    fixture.host = host;
    assert.equal(host.app.runtime.isProjectMemoryEnabled(), false);
    return host;
  };
  return fixture;
}

function createProvider(baseUrl) {
  return {
    providerId: "u06-mock",
    providerName: "U06 local mock",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "u06-synthetic-only" },
      api: { type: "openai-chat-completions", baseUrl },
      builtinModelIds: ["mock-model"],
      personalModelIds: [],
      modelOrder: ["mock-model"],
      visibility: "visible",
    },
    models: [{
      modelId: "mock-model",
      config: {
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 32768,
          inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
        },
        optionSpecs: {
          reasoningLevel: { values: ["none"], map: "{}" },
          maxOutputTokens: { max: 4096, map: "{}" },
        },
      },
    }],
  };
}

function createObservedNativeModelAdapter(delegate, getContext, getExpectedPacket) {
  const state = { delegateCalls: 0, contexts: [] };
  const observeModel = (model) => {
    const observed = Object.create(model);
    Object.defineProperties(observed, {
      bind: { value: (options) => observeModel(model.bind.call(model, options)) },
      generateText: { value: (request) => {
        observeCall(request);
        return model.generateText.call(model, request);
      } },
      streamText: { value: (request) => {
        observeCall(request);
        return model.streamText.call(model, request);
      } },
    });
    return observed;
  };
  const observeCall = (request) => {
    const context = getContext();
    const expectedPacket = getExpectedPacket();
    state.delegateCalls += 1;
    state.contexts.push({
      operation: context?.modelCall?.operation,
      sessionId: context?.traceContext?.sessionId,
      turnId: context?.traceContext?.turnId,
      operationId: context?.modelCall?.operationId,
      hasCanonicalPacket: typeof expectedPacket === "string" && collectMessageText(request.messages).includes(expectedPacket),
    });
  };
  const adapter = Object.create(delegate);
  Object.defineProperties(adapter, {
    createModel: { value: (options) => observeModel(delegate.createModel.call(delegate, options)) },
    addStatusSink: { value: (sink) => delegate.addStatusSink.call(delegate, sink) },
    setModelIoFullRetentionEnabled: { value: (enabled) => delegate.setModelIoFullRetentionEnabled.call(delegate, enabled) },
  });
  return {
    adapter,
    get delegateCalls() { return state.delegateCalls; },
    contexts: state.contexts,
  };
}

async function startMockProvider(readTarget, mode = {}) {
  const state = { requests: [], readTarget, ports: [], nonLoopbackRequests: 0, abortedResponses: 0 };
  const server = http.createServer(async (request, response) => {
    response.on("close", () => {
      if (!response.writableEnded) state.abortedResponses += 1;
    });
    const remote = request.socket.remoteAddress ?? "";
    if (!(remote === "127.0.0.1" || remote === "::1" || remote.startsWith("::ffff:127.0.0.1"))) {
      state.nonLoopbackRequests += 1;
      response.writeHead(403).end("loopback only");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { response.writeHead(400).end("invalid json"); return; }
    state.requests.push({ method: request.method, path: request.url, body });
    if (mode.fail) { response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "P02_OWNED_HTTP_FAILURE" } })); return; }
    if (mode.holdFirstResponse && state.requests.length === 1) return;
    const serializedMessages = JSON.stringify(body.messages ?? []);
    const hadReadResult = serializedMessages.includes("MOCK_ALLOWED_FILE");
    const readRequested = serializedMessages.includes("Read allowed.txt") && (body.tools ?? []).some((tool) =>
      tool.name === "Read" || tool.function?.name === "Read");
    const callRead = readRequested && !hadReadResult && (!mode.readOnce || state.requests.length === 1);
    const text = hadReadResult ? "MOCK_READ_OK" : mode.readOnce && state.requests.length > 1 ? "MOCK_READ_FAILED: file unavailable" : "MOCK_NO_TOOL";
    const completion = {
      id: `chatcmpl-u06-${state.requests.length}`,
      object: "chat.completion",
      created: 1,
      model: "mock-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: callRead ? null : text,
          ...(callRead ? { tool_calls: [{
            id: `u06-read-${state.requests.length}`,
            type: "function",
            function: { name: "Read", arguments: JSON.stringify({ file_path: state.readTarget }) },
          }] } : {}),
        },
        finish_reason: callRead ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    if ((request.headers.accept ?? "").includes("text/event-stream")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = callRead
        ? { role: "assistant", tool_calls: [{ index: 0, id: `u06-read-${state.requests.length}`, type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: state.readTarget }) } }] }
        : { role: "assistant", content: text };
      response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: callRead ? "tool_calls" : "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(completion));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  state.ports.push(address.port);
  return {
    requests: state.requests,
    ports: state.ports,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get nonLoopbackRequests() { return state.nonLoopbackRequests; },
    get abortedResponses() { return state.abortedResponses; },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the native mock condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createExecutionPort(options) {
  const state = { hookRuns: 0, previousOutput: undefined, lastHookContext: undefined, processRecords: [] };
  const safeEnv = safeEnvironment(options.home, options.temp);
  const run = async (request) => {
    const isUserPromptHook = request.trace?.attributes?.hookEventName === "UserPromptSubmit";
    state.hookRuns += isUserPromptHook ? 1 : 0;
    assert.equal(request.command.mode, "argv", "the hook must be a native argv process");
    const fixtureFault = isUserPromptHook && ["timeout", "bad-json", "nonzero"].includes(options.fault)
      ? options.fault
      : undefined;
    const fixtureMode = fixtureFault === "timeout" ? "hang" : fixtureFault;
    const executedRequest = fixtureFault
      ? {
          ...request,
          command: {
            ...request.command,
            file: process.execPath,
            args: [path.join(testDirectory, "fixtures", "hook-process-fault.mjs"), fixtureMode],
          },
          // Bound the real hanging child for this fault fixture while the pinned native
          // Hook deadline remains unchanged. This exercises a real killed process and
          // a timed_out ExecutionResult without waiting for the full 8-second deadline.
          ...(fixtureFault === "timeout" ? { timeoutMs: Math.min(request.timeoutMs ?? 1000, 250) } : {}),
        }
      : request;
    const real = await runChild(executedRequest, safeEnv, options);
    if (isUserPromptHook) {
      const record = {
        event: "UserPromptSubmit",
        kind: fixtureFault ?? "installed-hook",
        file: executedRequest.command.file,
        args: executedRequest.command.args,
        nativeTimeoutMs: request.timeoutMs,
        childTimeoutMs: executedRequest.timeoutMs,
        startedAtUtc: real.startedAt.toISOString(),
        completedAtUtc: real.completedAt.toISOString(),
        durationMs: real.durationMs,
        status: real.status,
        exitCode: real.exitCode,
        signal: real.signal,
        timedOut: real.timedOut,
        cancelled: real.cancelled,
        stdoutBytes: real.stdout.bytes,
        stdoutSha256: hash(real.stdout.text),
        stderrBytes: real.stderr.bytes,
        stderrSha256: hash(real.stderr.text),
        ...(fixtureFault ? { stdoutText: real.stdout.text, stderrText: real.stderr.text } : {}),
      };
      state.processRecords.push(record);
      process.stdout.write(`P02_NATIVE_HOOK_PROCESS ${JSON.stringify(record)}\n`);
    }
    if (request.trace?.attributes?.hookEventName === "UserPromptSubmit" && real.status === "completed") {
      try {
        const envelope = JSON.parse(real.stdout.text);
        state.lastHookContext = typeof envelope.additionalContext === "string" ? envelope.additionalContext : undefined;
      } catch {
        state.lastHookContext = undefined;
      }
    }
    if (!options.fault) {
      state.previousOutput = real.stdout.text;
      return real;
    }
    const stdoutBytes = (text) => ({ text, bytes: Buffer.byteLength(text), truncated: false });
    switch (options.fault) {
      case "timeout":
      case "nonzero":
      case "bad-json":
        return real;
      case "schema": return { ...real, stdout: stdoutBytes(JSON.stringify({ unexpected: true })) };
      case "missing-receipt": {
        const envelope = JSON.parse(real.stdout.text);
        delete envelope.xiadieReceipt;
        return { ...real, stdout: stdoutBytes(JSON.stringify(envelope)) };
      }
      case "truncated": {
        const envelope = JSON.parse(real.stdout.text);
        envelope.additionalContext = envelope.additionalContext.slice(0, -1);
        return { ...real, stdout: stdoutBytes(JSON.stringify(envelope)) };
      }
      default: return real;
    }
  };
  return {
    port: { run },
    ...state,
    get hookRuns() { return state.hookRuns; },
    get lastHookContext() { return state.lastHookContext; },
  };
}

function collectMessageText(messages) {
  const chunks = [];
  for (const message of messages ?? []) {
    if (typeof message?.content === "string") chunks.push(message.content);
    else if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (typeof block?.text === "string") chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

function errorChainIncludes(error, fragment) {
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error && current.message.includes(fragment)) return true;
    current = typeof current === "object" ? current.cause : undefined;
  }
  return false;
}

async function runChild(request, safeEnv, runOptions = {}) {
  const startedAt = new Date();
  const env = { ...safeEnv, ...(request.env?.set ?? {}) };
  for (const key of request.env?.unset ?? []) delete env[key];
  const child = spawn(request.command.file, [...(request.command.args ?? [])], {
    cwd: request.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  if (request.stdin !== undefined) child.stdin.end(request.stdin);
  else child.stdin.end();
  let timedOut = false;
  let cancelled = false;
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const signal = runOptions?.signal;
  const onAbort = () => {
    cancelled = true;
    child.kill();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (timer !== undefined) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  const completedAt = new Date();
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  return {
    status: exit.error ? "spawn_error" : cancelled ? "cancelled" : timedOut ? "timed_out" : exit.code === 0 ? "completed" : "failed",
    ...(exit.code === null || exit.code === undefined ? {} : { exitCode: exit.code }),
    ...(exit.signal ? { signal: exit.signal } : {}),
    stdout: { text: stdout.toString("utf8"), bytes: stdout.byteLength, truncated: false },
    stderr: { text: stderr.toString("utf8"), bytes: stderr.byteLength, truncated: false },
    durationMs: completedAt.getTime() - startedAt.getTime(),
    timedOut,
    cancelled,
    startedAt,
    completedAt,
    ...(exit.error ? { error: { type: "spawn_error", message: exit.error.message } } : {}),
  };
}

async function createBoundedFileSystemPort() {
  const { NodeFileSystemAdapter } = await import(localFsUrl);
  return new NodeFileSystemAdapter({ textSearchEngine: "javascript" });
}

function safeEnvironment(home, temp) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
    ZCODE_MODEL_RETRY_MAX_RETRIES: "0",
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  return env;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

