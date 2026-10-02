import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createTurnEventCollector } from "../../../dist/packages/application/turn-projection.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const sourceRoot = process.env.P01_U07_ZCODE_SOURCE ?? "E:\\Xiadie\\Xiadie\\.runtime\\P00\\zcode\\source";
const sourceUrl = (relativePath) => pathToFileURL(path.join(sourceRoot, relativePath)).href;
const { register } = await import(sourceUrl("node_modules/tsx/dist/esm/api/index.mjs"));
register();
const native = await import(sourceUrl("apps/zcode-cli/packages/bootstrap/dist/index.js"));
const { ProviderRegistry } = await import(sourceUrl("packages/provider/dist/registry.js"));
const { NodeFileSystemAdapter } = await import(sourceUrl("apps/zcode-cli/packages/adapters/dist/fs/index.js"));
let nativeInputSequence = 0;

test("pinned native Loop events project success, failure, cancel, and partial tool samples", async (t) => {
  await mkdir(path.join(repositoryRoot, ".runtime", "P01"), { recursive: true });
  const profile = await mkdtemp(path.join(repositoryRoot, ".runtime", "P01", "u07-native-"));
  const home = path.join(profile, "home");
  const temp = path.join(profile, "temp");
  const workspace = path.join(profile, "workspace");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temp, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeFile(path.join(workspace, "success.txt"), "U07_NATIVE_READ_OK\n", "utf8");
  await writeFile(path.join(workspace, "partial-ok.txt"), "U07_NATIVE_PARTIAL_OK\n", "utf8");
  await writeFile(path.join(workspace, "AGENTS.md"), "Use only files named in the current test input.\n", "utf8");

  const mock = await startMockProvider();
  const env = safeEnvironment(home, temp, path.join(profile, "storage"));
  const userConfigPath = path.join(profile, "user.json");
  const projectConfigPath = path.join(workspace, ".zcode.json");
  await writeFile(userConfigPath, "{}\n", "utf8");
  await writeFile(projectConfigPath, "{}\n", "utf8");
  const providerRegistry = new ProviderRegistry([createProvider(mock.baseUrl)]);
  let app;
  t.after(async () => {
    await app?.close?.();
    await mock.close();
    await native.shutdownZCodeTelemetry();
    await rm(profile, { recursive: true, force: true });
  });
  app = await native.createZCodeApp({
    version: "0.16.9",
    providerRegistry,
    userConfigPath,
    projectConfigPath,
    skipUserConfig: false,
    pluginStorageRoot: path.join(profile, "plugin-storage"),
    workingDirectory: workspace,
    env,
    fileSystemPort: new NodeFileSystemAdapter({ textSearchEngine: "javascript" }),
    officialPluginRoots: [],
    runtimeConfig: {
      mode: "plan",
      memory: { enabled: false, use: false, extractionEnabled: false },
      dynamicWorkflowEnabled: false,
      modelSelection: { providerId: "u07-local", modelId: "fixture-model", options: { reasoningLevel: "none" } },
      modelStreaming: "off",
      toolAllowlist: ["Read"],
      workingDirectory: workspace,
      maxTurns: 4,
    },
  });
  assert.equal(app.runtime.isProjectMemoryEnabled(), false);

  const success = await collectSubmit(app, "U07_READ_SUCCESS read success.txt", ["u07-read-success"]);
  assert.equal(success.projection.lifecycle, "completed");
  assert.equal(success.projection.evidenceStatus, "verified");
  assert.ok(success.projection.toolReceipts.some((receipt) => receipt.toolCallId === "u07-read-success" && receipt.status === "succeeded"));
  emitNativeSample("success", success.events);

  const failure = await collectSubmit(app, "U07_READ_FAILURE read missing.txt", ["u07-read-failure"]);
  assert.equal(failure.projection.lifecycle, "completed");
  assert.equal(failure.projection.evidenceStatus, "failed");
  assert.ok(failure.projection.toolReceipts.some((receipt) => receipt.toolCallId === "u07-read-failure" && receipt.status === "failed"));
  emitNativeSample("failure", failure.events);

  const partial = await collectSubmit(app, "U07_READ_PARTIAL read partial-ok.txt and missing-partial.txt", ["u07-partial-ok", "u07-partial-missing"]);
  assert.equal(partial.projection.lifecycle, "completed");
  assert.equal(partial.projection.evidenceStatus, "partial");
  assert.deepEqual(
    partial.projection.toolReceipts.map((receipt) => [receipt.toolCallId, receipt.status]).sort(([left], [right]) => left.localeCompare(right)),
    [["u07-partial-missing", "failed"], ["u07-partial-ok", "succeeded"]],
  );
  emitNativeSample("partial", partial.events);

  const collector = createTurnEventCollector(app.sessionId);
  const cancelEvents = [];
  const unsubscribe = app.runtime.subscribeEvents({ onSessionEvent(event) {
    collector.onSessionEvent(event);
    cancelEvents.push(event);
  } });
  const controller = new AbortController();
  const admission = await app.sendInput(
    { text: "U07_CANCEL hold until the probe cancels this native turn." },
    { abortSignal: controller.signal, inputId: "u07-native-cancel" },
  );
  assert.equal(admission.kind, "started_turn");
  collector.bindTurn(admission.turnId);
  await waitFor(() => mock.requestsFor("cancel") === 1);
  controller.abort();
  let cancelledResult;
  await admission.completion.then((result) => { cancelledResult = result; }, () => undefined);
  unsubscribe();
  const cancelled = collector.project(cancelledResult, ["u07-cancel-never-issued"]);
  assert.equal(cancelled.lifecycle, "cancelled");
  assert.equal(cancelled.evidenceStatus, "unverified");
  emitNativeSample("cancel", cancelEvents.filter((event) => event.turnId === admission.turnId));
  collector.close();
});

async function collectSubmit(app, prompt, requiredToolCallIds) {
  const collector = createTurnEventCollector(app.sessionId);
  const captured = [];
  const unsubscribe = app.runtime.subscribeEvents({ onSessionEvent(event) {
    collector.onSessionEvent(event);
    captured.push(event);
  } });
  try {
    const admission = await app.sendInput({ text: prompt }, { inputId: `u07-native-input-${++nativeInputSequence}` });
    assert.equal(admission.kind, "started_turn");
    collector.bindTurn(admission.turnId);
    const result = await admission.completion;
    return { projection: collector.project(result, requiredToolCallIds), events: captured.filter((event) => event.turnId === result.turnId) };
  } finally {
    unsubscribe();
    collector.close();
  }
}

function emitNativeSample(name, events) {
  const safeEvents = events.map((event) => {
    const payload = record(event.payload);
    const result = record(payload?.result);
    return {
      type: event.type,
      sequenceNumber: event.sequenceNumber,
      ...(typeof payload?.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
      ...(typeof payload?.toolName === "string" ? { toolName: payload.toolName } : {}),
      ...(typeof result?.success === "boolean" ? { success: result.success } : {}),
      ...(typeof payload?.error === "object" && payload.error !== null ? { terminalError: true } : {}),
      ...(typeof payload?.resultType === "string" ? { resultType: payload.resultType } : {}),
    };
  });
  process.stdout.write(`U07_NATIVE_SAMPLE ${JSON.stringify({ name, events: safeEvents })}\n`);
}

function createProvider(baseUrl) {
  return {
    providerId: "u07-local",
    providerName: "U07 loopback fixture",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "u07-synthetic-only" },
      api: { type: "openai-chat-completions", baseUrl },
      builtinModelIds: ["fixture-model"],
      personalModelIds: [],
      modelOrder: ["fixture-model"],
      visibility: "visible",
    },
    models: [{
      modelId: "fixture-model",
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

async function startMockProvider() {
  const state = { requests: [], caseCounts: new Map(), cancelResponse: undefined, port: undefined };
  const server = http.createServer(async (request, response) => {
    const remote = request.socket.remoteAddress ?? "";
    if (!(remote === "127.0.0.1" || remote === "::1" || remote.startsWith("::ffff:127.0.0.1"))) {
      response.writeHead(403).end("loopback only");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { response.writeHead(400).end("invalid json"); return; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const latestUserText = [...messages].reverse().find((message) => message?.role === "user")?.content ?? "";
    const prompt = typeof latestUserText === "string" ? latestUserText : JSON.stringify(latestUserText);
    const kind = prompt.includes("U07_READ_SUCCESS") ? "success"
      : prompt.includes("U07_READ_FAILURE") ? "failure"
        : prompt.includes("U07_READ_PARTIAL") ? "partial"
          : prompt.includes("U07_CANCEL") ? "cancel" : "other";
    const count = (state.caseCounts.get(kind) ?? 0) + 1;
    state.caseCounts.set(kind, count);
    state.requests.push({ kind, count });

    if (kind === "cancel" && count === 1) {
      state.cancelResponse = response;
      response.on("close", () => { state.cancelResponse = undefined; });
      return;
    }
    const calls = count === 1 && kind !== "cancel" ? callsFor(kind) : [];
    const text = kind === "failure" ? "The requested read failed." : kind === "partial" ? "One read succeeded and one failed." : "The requested read completed.";
    const completion = {
      id: `chatcmpl-u07-${kind}-${count}`,
      object: "chat.completion",
      created: 1,
      model: "fixture-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: calls.length === 0 ? text : null, ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: calls.length === 0 ? "stop" : "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(completion));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  state.port = address.port;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestsFor: (kind) => state.requests.filter((request) => request.kind === kind).length,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function callsFor(kind) {
  if (kind === "success") return [toolCall("u07-read-success", "success.txt")];
  if (kind === "failure") return [toolCall("u07-read-failure", "missing.txt")];
  if (kind === "partial") return [toolCall("u07-partial-ok", "partial-ok.txt"), toolCall("u07-partial-missing", "missing-partial.txt")];
  return [];
}

function toolCall(id, fileName) {
  return {
    id,
    type: "function",
    function: { name: "Read", arguments: JSON.stringify({ file_path: path.join(".", fileName) }) },
  };
}

function safeEnvironment(home, temp, storage) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
    ZCODE_STORAGE_DIR: storage,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  return env;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the native loopback fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
