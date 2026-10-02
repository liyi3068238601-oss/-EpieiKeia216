import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync as fsSyncMkdtemp, readFileSync, realpathSync, rmSync as fsSyncRm, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createLocalProvider,
  createNativeEventObserver,
  createObservedNativeModelAdapter,
  createReadOnlyWorkspaceFileSystemPort,
  validateNativeSpec,
} from "./native.mjs";
import { createProfileBridgePayload } from "./profile-bridge.mjs";

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const canary = "P01_U09_SYNTHETIC_SECRET_CANARY";

function tempRoot(t) {
  const prefix = "p01-u09-unit-";
  const root = fsSyncMkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => {
    const resolvedRoot = realpathSync.native(path.resolve(root));
    const resolvedTemp = realpathSync.native(path.resolve(os.tmpdir()));
    const resolvedParent = realpathSync.native(path.dirname(resolvedRoot));
    if (resolvedParent.toLowerCase() !== resolvedTemp.toLowerCase() ||
        !path.basename(resolvedRoot).toLowerCase().startsWith(prefix)) {
      throw new Error("test temporary cleanup path rejected");
    }
    fsSyncRm(resolvedRoot, { recursive: true, force: true });
  });
  return root;
}

function makeSpec(root, scenario = cases.scenarios[0]) {
  return {
    mode: "mock",
    model: "deepseek-flash",
    scenario: {
      id: scenario.id,
      prompt: scenario.prompt,
      max_requests: scenario.max_requests,
      ...(scenario.target ? { target: scenario.target } : {}),
    },
    profile_root: path.join(root, "profile"),
    relay_origin: "http://127.0.0.1:41321",
    output_dir: path.join(root, "out"),
    system_env: {
      PATH: "C:\\P01-fixed-node;C:\\Windows\\System32",
      SYSTEMROOT: "C:\\Windows",
      WINDIR: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
  };
}

function runNodeChild(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("case manifest follows the preflight five scenarios and bounded two-route budget", () => {
  assert.deepEqual(cases.scenarios.map(({ id }) => id), [
    "daily", "disagreement", "technical_read", "refusal_secret", "failure_read",
  ]);
  assert.deepEqual(cases.scenarios.map(({ max_requests }) => max_requests), [1, 1, 2, 1, 2]);
  assert.equal(cases.request_budget.max_new_requests, 14);
  assert.equal(cases.request_budget.existing_attempts + cases.request_budget.max_new_requests, cases.request_budget.initial_limit);
  assert.equal(cases.runtime_persona.sha256, "a688c669c4f556495131ac69cdc868a5b2ee93614eff814fc0793b1690c99bb4");
  assert.equal(cases.runtime_persona.manifest_sha256, "3bedae784adae2182f3396cccbc3c91663fe96a58d18373481fbb7155d888f62");
  assert.match(cases.runtime_persona.source_provenance_only.mofox_core_toml_sha256, /^300a28/);
  assert.equal(cases.scenarios[2].fixture.expected_marker, "orchid-42");
  assert.match(cases.scenarios[3].prompt, /API Key/);
  assert.equal(cases.scenarios[4].target, "missing.txt");
  assert.equal(cases.human_review.initial_status, "not_reviewed");
  assert.equal(cases.human_review.record_values.includes("agent_review"), false);
  assert.equal(JSON.stringify(cases).includes("4/6"), false);
});

test("native spec is bound to an exact frozen case and loopback origin", (t) => {
  const root = tempRoot(t);
  const spec = makeSpec(root);
  assert.equal(validateNativeSpec(spec).relay_origin, "http://127.0.0.1:41321");
  assert.throws(() => validateNativeSpec({ ...spec, relay_origin: `${spec.relay_origin}/v1` }), /invalid_relay_origin/);
  assert.throws(() => validateNativeSpec({ ...spec, scenario: { ...spec.scenario, prompt: "changed" } }), /scenario_does_not_match_cases/);
  assert.throws(() => validateNativeSpec({ ...spec, system_env: { ...spec.system_env, OPENAI_API_KEY: canary } }), /invalid_system_environment/);
});

test("Node network guard allows the bound live loopback and denies other ports and hosts", async (t) => {
  const root = tempRoot(t);
  const guardPath = fileURLToPath(new URL("./network-guard.cjs", import.meta.url));
  const logPath = path.join(root, "network.jsonl");
  writeFileSync(logPath, "", { flag: "wx" });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("u09-loopback-ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const allowedPort = server.address().port;
  const deniedPort = allowedPort === 65535 ? allowedPort - 1 : allowedPort + 1;
  const allowedOrigin = `http://127.0.0.1:${allowedPort}`;
  const deniedUrl = `http://127.0.0.1:${deniedPort}/blocked`;
  const script = String.raw`
    const net = require("node:net");
    (async () => {
      const response = await fetch(new Request(process.env.P01_TEST_ALLOWED_URL));
      if (response.status !== 200 || await response.text() !== "u09-loopback-ok") throw new Error("allowed_fetch_failed");
      const socket = net.connect({ host: "127.0.0.1", port: Number(process.env.P01_TEST_ALLOWED_PORT) });
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.once("connect", resolve);
      });
      socket.end();
      let deniedFetch = false;
      try { await fetch(process.env.P01_TEST_DENIED_URL); }
      catch (error) { deniedFetch = error.code === "P01_EGRESS_DENIED"; }
      if (!deniedFetch) throw new Error("unlisted_fetch_was_not_blocked");
      let deniedSocket = false;
      let unexpectedSocket;
      try { unexpectedSocket = net.connect({ host: "127.0.0.1", port: Number(process.env.P01_TEST_DENIED_PORT) }); }
      catch (error) { deniedSocket = error.code === "P01_EGRESS_DENIED"; }
      if (unexpectedSocket) unexpectedSocket.destroy();
      if (!deniedSocket) throw new Error("unlisted_loopback_port_was_not_blocked");
      let lookupCalled = false;
      let lookupDenied = false;
      let lookupSocket;
      try {
        lookupSocket = net.connect({
          host: "p01-egress-canary.invalid",
          port: Number(process.env.P01_TEST_ALLOWED_PORT),
          lookup(_hostname, _options, callback) {
            lookupCalled = true;
            callback(null, "203.0.113.1", 4);
          },
        });
      } catch (error) { lookupDenied = error.code === "P01_EGRESS_DENIED"; }
      if (lookupSocket) lookupSocket.destroy();
      if (!lookupDenied || lookupCalled) throw new Error("canary_lookup_was_not_blocked");
      process.stdout.write("U09_NETWORK_GUARD_OK\n");
    })().catch((error) => {
      process.stderr.write(String(error.code ?? error.message ?? "child_failure") + "\n");
      process.exitCode = 1;
    });
  `;
  const minimalEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (typeof process.env[key] === "string") minimalEnv[key] = process.env[key];
  }
  Object.assign(minimalEnv, {
    P01_ALLOWED_HTTP_ORIGINS: JSON.stringify([allowedOrigin]),
    P01_GUARD_LOG: logPath,
    P01_TEST_ALLOWED_URL: `${allowedOrigin}/health`,
    P01_TEST_ALLOWED_PORT: String(allowedPort),
    P01_TEST_DENIED_URL: deniedUrl,
    P01_TEST_DENIED_PORT: String(deniedPort),
  });
  const child = await runNodeChild(process.execPath, ["--require", guardPath, "-e", script], minimalEnv);
  assert.equal(child.code, 0, `child stdout=${child.stdout}; stderr=${child.stderr}`);
  assert.match(child.stdout, /U09_NETWORK_GUARD_OK/);
  const records = readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.kind === "egress_canary_denied"));
  assert.ok(records.some((record) => record.kind === "request" && record.target === allowedOrigin && record.allowed));
  assert.ok(records.some((record) => record.kind === "request" && record.target === "denied" && !record.allowed));
  assert.ok(records.some((record) => record.kind === "socket" && record.target === `127.0.0.1:${allowedPort}` && record.allowed));
  assert.ok(records.some((record) => record.kind === "socket" && record.target === `127.0.0.1:${deniedPort}` && !record.allowed));
  assert.ok(records.some((record) => record.kind === "socket" && record.target === "p01-egress-canary.invalid:443" && !record.allowed));
  assert.ok(records.some((record) => record.kind === "socket" && record.target === `p01-egress-canary.invalid:${allowedPort}` && !record.allowed));
});

test("loopback provider appends /v1 and has only a synthetic child key", () => {
  const provider = createLocalProvider("deepseek-v4-pro", "http://127.0.0.1:41321");
  assert.equal(provider.config.api.baseUrl, "http://127.0.0.1:41321/v1");
  assert.equal(provider.config.access.apiKey, "p01-u09-loopback-only");
  assert.equal(provider.models[0].config.supportsToolCall, undefined);
  assert.equal(provider.models[0].config.properties.supportsToolCall, true);
  assert.equal(provider.models[0].config.optionSpecs.reasoningLevel.map, '{"thinking":{"type":"disabled"}}');
  assert.equal(provider.models[0].config.optionSpecs.maxOutputTokens.map, '{"max_tokens":maxOutputTokens}');
  assert.equal(JSON.stringify(provider).includes(canary), false);
});

test("profile bridge rejects secret-like system variables and mock output contains no canary", async (t) => {
  const root = tempRoot(t);
  const badSpec = makeSpec(root);
  badSpec.system_env["P01_U09_SECRET_CANARY"] = canary;
  await assert.rejects(createProfileBridgePayload(badSpec), /invalid_system_environment/);
  assert.equal(JSON.stringify(badSpec).includes(canary), true, "the test input alone carries the synthetic canary");
  assert.equal(await fs.stat(badSpec.profile_root).then(() => true, () => false), false, "rejection precedes profile creation");

  const goodSpec = makeSpec(root);
  const bridge = await createProfileBridgePayload(goodSpec);
  assert.equal(bridge.credential_decision.decision, "no-key");
  assert.equal(Object.hasOwn(bridge.profile, "credentialRef"), false);
  const serialized = JSON.stringify(bridge);
  assert.equal(serialized.includes(canary), false);
  assert.equal(serialized.includes("P01_U09_SECRET_CANARY"), false);
  assert.equal(bridge.env.ZCODE_ENDPOINT_ORIGIN, goodSpec.relay_origin);
  assert.equal(bridge.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT, "1");
  assert.equal(bridge.profile.modelId, goodSpec.model);
  assert.equal(readFileSync(path.join(goodSpec.profile_root, "profile.json"), "utf8").includes(canary), false);
});

test("filesystem adapter allows reads only under the physical workspace and denies writes/search", async (t) => {
  const root = tempRoot(t);
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "readme.txt"), "ORCHID_ONLY\n");
  await fs.writeFile(outside, "OUTSIDE_CANARY\n");
  const base = {
    async stat(request) { return await fs.stat(request.path); },
    async readTextFile(request) { return await fs.readFile(request.path, "utf8"); },
    async readBinaryFile(request) { return await fs.readFile(request.path); },
    async readTextFileRange(request) { return await fs.readFile(request.path, "utf8"); },
    async writeTextFile() { throw new Error("base write must not be reached"); },
    async searchFiles() { throw new Error("base search must not be reached"); },
  };
  const createFileSystemError = (details) => Object.assign(new Error(details.message), { code: details.code });
  const port = createReadOnlyWorkspaceFileSystemPort(base, workspace, createFileSystemError);
  assert.equal(await port.readTextFile({ path: path.join(workspace, "readme.txt") }), "ORCHID_ONLY\n");
  await assert.rejects(port.readTextFile({ path: outside }), { code: "permission_denied" });
  await assert.rejects(port.readTextFile({ path: path.join(workspace, "..", "outside.txt") }), { code: "permission_denied" });
  await assert.rejects(port.writeTextFile({ path: path.join(workspace, "readme.txt") }), { code: "permission_denied" });
  await assert.rejects(port.searchFiles({ path: workspace }), { code: "permission_denied" });
  assert.equal(readFileSync(outside, "utf8"), "OUTSIDE_CANARY\n");
});

test("native terminal receipt journal is synchronous, correlated and content-minimal", (t) => {
  const root = tempRoot(t);
  const receiptsPath = path.join(root, "receipts.jsonl");
  writeFileSync(receiptsPath, "", { flag: "wx" });
  const received = [];
  const observer = createNativeEventObserver({
    scenarioId: "technical_read",
    sessionId: "session-u09",
    collector: { onSessionEvent: (event) => received.push(event) },
    receiptsPath,
  });
  observer.onSessionEvent({ sessionId: "session-u09", turnId: "turn-u09", sequenceNumber: 1,
    type: "tool_call_scheduled", payload: { toolCallId: "read-call", toolName: "Read" } });
  observer.onSessionEvent({ sessionId: "session-u09", turnId: "turn-u09", sequenceNumber: 2,
    type: "tool_call_result", payload: { toolCallId: "read-call", result: { success: true, content: "ORCHID_ONLY" } } });
  observer.onSessionEvent({ sessionId: "session-u09", turnId: "turn-u09", sequenceNumber: 3,
    type: "model_streaming", payload: { reasoning_content: canary, delta: "public" } });

  const lines = readFileSync(receiptsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(received.length, 3);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    scenario_id: "technical_read",
    session_id: "session-u09",
    turn_id: "turn-u09",
    tool_call_id: "read-call",
    tool_name: "Read",
    event_type: "tool_call_result",
    result_success: true,
  });
  assert.equal(readFileSync(receiptsPath, "utf8").includes(canary), false);
  assert.equal(readFileSync(receiptsPath, "utf8").includes("ORCHID_ONLY"), false);
});

test("model observer writes correlated packet receipt before delegation and never writes messages", async (t) => {
  const root = tempRoot(t);
  const contextsPath = path.join(root, "contexts.jsonl");
  writeFileSync(contextsPath, "", { flag: "wx" });
  const packet = '{"schema_version":1,"instruction":[{"field":"identity","text":"遐蝶\u0027s quoted persona packet"}]}';
  const context = {
    modelCall: { operation: "generateText" },
    traceContext: { sessionId: "session-u09", turnId: "turn-u09" },
  };
  const envelope = {
    additionalContext: packet,
    xiadieReceipt: {
      version: 1,
      nonce: "nonce-u09",
      event: "UserPromptSubmit",
      sessionId: "session-u09",
      turnId: "turn-u09",
      packetSha256: "packet-hash",
      transcriptBytes: 12,
      transcriptSha256: "transcript-hash",
      character: { id: "xiadie", version: "v3", contentSha256: cases.runtime_persona.sha256 },
    },
  };
  let delegated = false;
  const model = {
    bind() { return this; },
    async generateText() {
      delegated = true;
      assert.equal(readFileSync(contextsPath, "utf8").trim().length > 0, true);
      return { text: "reply" };
    },
    async *streamText() { yield "reply"; },
  };
  const delegate = {
    createModel() { return model; },
    addStatusSink() {},
    setModelIoFullRetentionEnabled() {},
  };
  const observed = createObservedNativeModelAdapter(delegate, () => context, () => envelope,
    "daily", contextsPath);
  const instance = observed.adapter.createModel({});
  await instance.generateText({ messages: [
    { role: "system", content: [{ type: "text", text: packet }] },
    { role: "assistant", content: [{ type: "reasoning", text: canary }] },
    { role: "user", content: canary },
  ] });
  assert.equal(delegated, true);
  const row = JSON.parse(readFileSync(contextsPath, "utf8").trim());
  assert.equal(row.request_index, 1);
  assert.equal(row.has_canonical_packet, true);
  assert.equal(row.receipt_matches_invocation, true);
  assert.equal(row.canonical_packet, packet);
  assert.equal(JSON.stringify(row).includes(canary), false);

  const deniedPath = path.join(root, "denied.jsonl");
  writeFileSync(deniedPath, "", { flag: "wx" });
  const denied = createObservedNativeModelAdapter(delegate, () => context, () => envelope, "daily", deniedPath);
  await assert.rejects(async () => denied.adapter.createModel({}).generateText({ messages: [{ role: "user", content: canary }] }),
    /native_model_context_unverified/);
  assert.equal(readFileSync(deniedPath, "utf8").includes(canary), false);
});
