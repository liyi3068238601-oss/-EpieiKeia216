import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const profilesRoot = path.join(repositoryRoot, ".runtime", "P01", "u06-mock-profiles");
const sourceRoot = process.env.P01_U06_ZCODE_SOURCE ?? "E:\\Xiadie\\Xiadie\\.runtime\\P00\\zcode\\source";
const tsxApiUrl = pathToFileURL(path.join(sourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href;
const { register: registerTsx } = await import(tsxApiUrl);
registerTsx();
const nativeBootstrapUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "index.js")).href;
const nativeContractsUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "contracts", "dist", "model", "invocation-context.js")).href;
const nativeProviderRegistryUrl = pathToFileURL(path.join(sourceRoot, "packages", "provider", "dist", "registry.js")).href;
const nativeModelRunnerUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "model", "runner.js")).href;
const localFsUrl = pathToFileURL(path.join(sourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "fs", "index.js")).href;
const hostModuleUrl = pathToFileURL(path.join(repositoryRoot, "dist", "packages", "adapters", "zcode", "src", "index.js")).href;

const native = await import(nativeBootstrapUrl);
const nativeContracts = await import(nativeContractsUrl);
const providerModule = await import(nativeProviderRegistryUrl);
const nativeModelRunner = await import(nativeModelRunnerUrl);
const { createXiadieZCodeApp } = await import(hostModuleUrl);

test("native marketplace install/discovery, Hook process, native Read and local mock model", async (t) => {
  const fixture = await createFixture(t, { enabled: true });
  const result = await fixture.host.submitPrompt("Read allowed.txt and report its marker.");

  assert.equal(fixture.execution.hookRuns, 1, "native Loop executes the installed process Hook");
  assert.ok(fixture.model.delegateCalls >= 2, "the native Loop calls the mock model before and after its tool");
  assert.ok(fixture.mock.requests.length >= 2, "model calls reach only the loopback HTTP mock");
  assert.equal(fixture.mock.nonLoopbackRequests, 0, "all mock HTTP requests remain loopback-local");
  assert.ok(JSON.stringify(fixture.mock.requests).includes("MOCK_ALLOWED_FILE"), "native Read result returns to the model");
  assert.ok(JSON.stringify(fixture.mock.requests).includes("Do not read forbidden.txt"), "project AGENTS rule reaches the model");
  assert.ok(fixture.model.contexts.every((context) => context.sessionId === fixture.host.app.sessionId), "model context is bound to this native session");
  assert.ok(fixture.model.contexts.every((context) => context.turnId), "native model calls carry the native turn id");
  assert.ok(fixture.model.contexts.every((context) => context.hasCanonicalPacket), "full current packet reaches every model call");
  assert.equal(result.response, "MOCK_READ_OK");
  assert.equal(fixture.plugin.enabled, true);
  assert.equal(fixture.plugin.version, "0.1.0");
  assert.ok(fixture.plugin.hookDetails.some((hook) => hook.event === "UserPromptSubmit"));
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
});

test("native sendInput returns its TurnResult after an installed Hook and native Read", async (t) => {
  const fixture = await createFixture(t, { enabled: true });
  const events = [];
  const unsubscribe = fixture.host.app.runtime.subscribeEvents({ onSessionEvent: (event) => events.push(event) });
  const admission = await fixture.host.sendInput(
    { text: "Read allowed.txt and report its marker." },
    { inputId: "u06-native-sendinput", requireIdle: false },
  );
  assert.equal(admission.kind, "started_turn");
  assert.ok(admission.turnId);
  const result = await admission.completion;
  unsubscribe();

  assert.equal(result.response, "MOCK_READ_OK");
  assert.ok(result.turnId);
  assert.ok(result.traceId);
  assert.ok(Array.isArray(result.events));
  assert.ok(result.projection);
  assert.equal(fixture.execution.hookRuns, 1);
  assert.equal(fixture.model.contexts.every((context) => context.hasCanonicalPacket), true);
  assert.ok(events.some((event) => event.type === "hook_run_started"), "subscription was active before Hook execution");
  assert.ok(events.some((event) => event.type === "turn_started"));
  assert.ok(JSON.stringify(fixture.mock.requests).includes("MOCK_ALLOWED_FILE"));
  assert.ok(JSON.stringify(fixture.mock.requests).includes("Do not read forbidden.txt"));
  assert.equal(fixture.mock.nonLoopbackRequests, 0);
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
});

test("cancelled native sendInput holds exclusivity through completion and permits a fresh turn afterward", async (t) => {
  const fixture = await createFixture(t, { enabled: true, holdFirstMockResponse: true });
  const controller = new AbortController();
  const admission = await fixture.host.sendInput(
    { text: "Say MOCK_NO_TOOL for a cancellation probe." },
    { abortSignal: controller.signal, inputId: "u06-native-cancel" },
  );
  assert.equal(admission.kind, "started_turn");
  await waitFor(() => fixture.mock.requests.length > 0);
  await assert.rejects(fixture.host.submitPrompt("overlap while sendInput is active"), /sendInput is in flight/);
  await assert.rejects(fixture.host.sendInput("overlap while sendInput is active"), /sendInput is in flight/);
  await assert.rejects(fixture.host.compact(), /sendInput is in flight/);

  controller.abort();
  const cancellation = await admission.completion.then(
    (value) => ({ kind: "resolved", result: value }),
    (error) => ({ kind: "rejected", message: error instanceof Error ? error.message : String(error) }),
  );
  assert.ok(cancellation.kind === "resolved" || cancellation.kind === "rejected");
  await waitFor(() => fixture.mock.abortedResponses > 0);

  const nextAdmission = await fixture.host.sendInput({ text: "Say MOCK_NO_TOOL after cancellation." });
  assert.equal(nextAdmission.kind, "started_turn");
  const nextResult = await nextAdmission.completion;
  assert.equal(nextResult.response, "MOCK_NO_TOOL");
  assert.equal(fixture.execution.hookRuns, 2, "the next turn receives a fresh native Hook receipt");
  assert.equal(fixture.model.contexts.every((context) => context.hasCanonicalPacket), true);
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
});

test("native compact uses a one-session operation ticket and next turn creates a fresh Hook receipt", async (t) => {
  const fixture = await createFixture(t, { enabled: true });
  await fixture.host.submitPrompt("Say MOCK_NO_TOOL for this synthetic check.");
  const beforeCompactCalls = fixture.model.delegateCalls;
  const compactEvents = [];
  const unsubscribe = fixture.host.app.runtime.subscribeEvents({ onSessionEvent: (event) => compactEvents.push(event) });
  let compactResult;
  try {
    compactResult = await fixture.host.compact();
  } catch (error) {
    assert.fail(`native compact failed with session ${fixture.host.app.sessionId}: ${error instanceof Error ? error.message : String(error)}; admissionFailures=${JSON.stringify(fixture.host.readAdmissionFailures())}`);
  } finally {
    unsubscribe();
  }
  const completed = compactEvents.find((event) => event.type === "compact_completed");
  assert.ok(completed, "the native compact-completed event reaches the pre-registered subscriber");
  assert.equal(completed.payload?.status, "completed");
  assert.ok(completed.payload?.boundaryId, "native compact produced a persisted summary boundary");
  assert.ok(compactResult.events.some((event) => event.type === "compact_completed" && event.payload?.status === "completed"));
  assert.ok(fixture.model.contexts.some((context) => context.operation === "context_compaction"));
  const compactCalls = fixture.model.contexts.filter((context) => context.operation === "context_compaction");
  assert.ok(compactCalls.every((context) => context.sessionId === fixture.host.app.sessionId));
  assert.ok(compactCalls.every((context) => context.turnId && context.turnId === compactCalls[0].turnId));
  assert.ok(fixture.model.delegateCalls > beforeCompactCalls, "the compact ticket admits the native summary request");

  const beforeNextTurn = fixture.execution.hookRuns;
  await fixture.host.submitPrompt("Say MOCK_NO_TOOL after compact.");
  assert.equal(fixture.execution.hookRuns, beforeNextTurn + 1, "the next normal turn runs a new Hook");
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
});

test("resume performs a fresh approved preflight and next native turn receives a new Hook receipt", async (t) => {
  const fixture = await createFixture(t, { enabled: true });
  await fixture.host.submitPrompt("Say MOCK_NO_TOOL before resume.");
  const beforeResume = fixture.execution.hookRuns;
  const oldPacket = fixture.execution.lastHookContext;
  const sessionId = fixture.host.app.sessionId;
  await fixture.host.resume();
  assert.equal(fixture.execution.hookRuns, beforeResume, "resume itself does not claim an old Hook receipt");
  await fixture.reopen(sessionId);
  assert.equal(fixture.host.app.sessionId, sessionId, "native resume reuses the same persisted session id");
  const resumeEvents = [];
  const unsubscribe = fixture.host.app.runtime.subscribeEvents({ onSessionEvent: (event) => resumeEvents.push(event) });
  const result = await fixture.host.submitPrompt("Say MOCK_NO_TOOL after process-style resume.");
  unsubscribe();
  const resumedEvent = resumeEvents.find((event) => event.type === "session_resumed");
  assert.ok(resumedEvent, "native resume emitted SessionResumed after loading the saved session");
  assert.ok(resumedEvent.payload?.messageCount > 0, "the native SessionStore hydrated prior messages");
  assert.equal(result.response, "MOCK_NO_TOOL");
  assert.equal(fixture.execution.hookRuns, beforeResume + 1, "the first resumed turn obtains a new native Hook receipt");
  assert.notEqual(fixture.execution.lastHookContext, oldPacket, "old injected packet/receipt is not reused by a resumed turn");
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
});

test("disabled native plugin leaves ordinary native model execution available", async (t) => {
  const fixture = await createFixture(t, { enabled: false });
  const result = await fixture.host.submitPrompt("Say MOCK_NO_TOOL with Xiadie disabled.");
  assert.equal(fixture.execution.hookRuns, 0);
  assert.ok(fixture.model.delegateCalls > 0);
  assert.equal(result.response, "MOCK_NO_TOOL");
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
});

for (const fault of ["timeout", "nonzero", "bad-json", "schema", "missing-receipt", "truncated"]) {
  test(`native UserPromptSubmit blocks ${fault} before any model request`, async (t) => {
    const fixture = await createFixture(t, { enabled: true, fault });
    const result = await fixture.host.submitPrompt("Synthetic fail-closed probe.");
    assert.equal(fixture.execution.hookRuns, 1, "fault is injected after a real Hook process was launched");
    assert.equal(fixture.model.delegateCalls, 0);
    assert.equal(fixture.mock.requests.length, 0);
    assert.ok(fixture.host.readAdmissionFailures().length > 0);
    assert.match(result.response, /Xiadie identity gate rejected this turn before model execution\. hook-receipt/);
    if (fault === "timeout") {
      assert.equal(fixture.execution.processRecords.at(-1)?.status, "timed_out");
      assert.equal(fixture.execution.processRecords.at(-1)?.timedOut, true);
      assert.match(fixture.execution.processRecords.at(-1)?.stdoutText ?? "", /U06_HANG_FIXTURE_STARTED/);
    }
    if (fault === "bad-json") {
      assert.equal(fixture.execution.processRecords.at(-1)?.status, "completed");
      assert.equal(fixture.execution.processRecords.at(-1)?.exitCode, 0);
      assert.equal(fixture.execution.processRecords.at(-1)?.stdoutText, "not-json\n");
    }
  });
}

test("missing native Hook receipt is rejected at model delegate boundary", async (t) => {
  const fixture = await createFixture(t, { enabled: true, pluginEnabled: false });
  await assert.rejects(fixture.host.submitPrompt("Synthetic missing-hook probe."), (error) =>
    errorChainIncludes(error, "identity gate rejected model delegation"));
  assert.equal(fixture.execution.hookRuns, 0);
  assert.equal(fixture.model.delegateCalls, 0);
  assert.equal(fixture.mock.requests.length, 0);
  assert.ok(fixture.host.readAdmissionFailures().some((failure) => failure.reasonCode === "model-receipt"));
});

test("an unknown Hook path cannot create a native model request", async (t) => {
  const fixture = await createFixture(t, { enabled: true, fault: "unknown-path" });
  await assert.rejects(fixture.host.submitPrompt("Synthetic unknown-path probe."));
  assert.equal(fixture.execution.hookRuns, 1);
  assert.equal(fixture.model.delegateCalls, 0);
  assert.equal(fixture.mock.requests.length, 0);
  assert.ok(fixture.host.readAdmissionFailures().some((failure) => failure.reasonCode === "model-receipt"));
});

test("an invalid approved character asset fails before native submit or model work", async (t) => {
  const fixture = await createFixture(t, { enabled: true, invalidAssets: true });
  await assert.rejects(fixture.host.submitPrompt("Synthetic invalid-persona probe."), /Character|asset|approved/i);
  assert.equal(fixture.execution.hookRuns, 0);
  assert.equal(fixture.model.delegateCalls, 0);
  assert.equal(fixture.mock.requests.length, 0);
});

async function createFixture(t, options) {
  await mkdir(profilesRoot, { recursive: true });
  const profile = await mkdtemp(path.join(profilesRoot, "native-int-"));
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

  const mock = await startMockProvider(path.join(workspace, "allowed.txt"), { holdFirstResponse: options.holdFirstMockResponse });
  let host;
  t.after(async () => {
    await host?.close?.();
    await mock.close();
    if (process.env.P01_U06_KEEP_PROFILES !== "1") await rm(profile, { recursive: true, force: true });
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
    if (mode.holdFirstResponse && state.requests.length === 1) return;
    const serializedMessages = JSON.stringify(body.messages ?? []);
    const hadReadResult = serializedMessages.includes("MOCK_ALLOWED_FILE");
    const readRequested = serializedMessages.includes("Read allowed.txt") && (body.tools ?? []).some((tool) =>
      tool.name === "Read" || tool.function?.name === "Read");
    const callRead = readRequested && !hadReadResult;
    const text = hadReadResult ? "MOCK_READ_OK" : "MOCK_NO_TOOL";
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
      process.stdout.write(`U06_HOOK_PROCESS ${JSON.stringify(record)}\n`);
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
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  return env;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
