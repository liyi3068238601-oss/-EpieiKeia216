import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createXiadieZCodeApp } from "../../../../dist/packages/adapters/zcode/src/index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PROFILES = path.join(REPO, ".runtime/P02/u04-host-profiles");
const NODE = "E:\\Xiadie\\Xiadie\\.runtime\\P01\\desktop-build-evidence\\toolchain\\node-v24.14.0-win-x64\\node.exe";
const inside = (base, target) => {
  const relative = path.relative(base, path.resolve(target));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function removeOwned(target) {
  assert.ok(inside(PROFILES, target), "cleanup remains in the owned fixture directory");
  await rm(target, { recursive: true, force: true });
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// The native app/cleanup is a fixture; the approved context Hook runs in a real Node child.
async function fixture(t, transcriptSink) {
  await mkdir(PROFILES, { recursive: true });
  const root = await mkdtemp(path.join(PROFILES, "owned-"));
  t.after(() => removeOwned(root));
  const home = path.join(root, "home"), temp = path.join(root, "temp");
  const storage = path.join(root, "plugin-storage");
  const install = path.join(storage, "cache/xiadie");
  const data = path.join(storage, "data/xiadie");
  await Promise.all([home, temp, path.join(install, "hooks"), data].map((directory) => mkdir(directory, { recursive: true })));
  const userConfigPath = path.join(root, "user.json"), projectConfigPath = path.join(root, "project.json");
  await Promise.all([writeFile(userConfigPath, "{}\n"), writeFile(projectConfigPath, "{}\n"),
    copyFile(path.join(REPO, "plugins/xiadie/hooks/context.mjs"), path.join(install, "hooks/context.mjs"))]);
  const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp };
  let wrappedOptions, closeCalls = 0, turn = 0;
  const executionPort = {
    async run(request) {
      const startedAt = new Date();
      const result = spawnSync(NODE, request.command.args, {
        input: request.stdin, env: { ...env, ...request.env?.set }, encoding: "utf8", timeout: 3000,
      });
      const stream = (text) => ({ text: text ?? "", bytes: Buffer.byteLength(text ?? ""), truncated: false });
      return { status: result.error ? "spawn_error" : "completed", exitCode: result.status,
        stdout: stream(result.stdout), stderr: stream(result.stderr), durationMs: Date.now() - startedAt.getTime(),
        timedOut: result.error?.code === "ETIMEDOUT", cancelled: false, startedAt, completedAt: new Date() };
    },
  };
  const app = {
    sessionId: "u04-host-session", runtime: {},
    async submitPrompt(prompt) {
      const turnId = `turn-${++turn}`;
      const directory = await mkdtemp(path.join(temp, "zcode-hook-"));
      const transcriptPath = path.join(directory, "transcript.jsonl");
      await writeFile(transcriptPath, `${JSON.stringify({ message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`);
      try {
        const result = await wrappedOptions.executionPort.run({
          command: { mode: "argv", file: NODE, args: [path.join(install, "hooks/context.mjs")] },
          stdin: JSON.stringify({ hookEventName: "UserPromptSubmit", sessionId: app.sessionId, turnId, transcriptPath, prompt }),
          trace: { sessionId: app.sessionId, turnId, attributes: { hookEventName: "UserPromptSubmit" } },
        });
        assert.equal(result.exitCode, 0, result.stderr.text);
        assert.equal(JSON.parse(result.stdout.text).decision, undefined, "real identity receipt must pass");
        return { response: "synthetic", turnId, traceId: "fixture-trace", events: [], projection: null };
      } finally {
        await removeOwned(directory);
      }
    },
    async sendInput() { throw new Error("not used by this fixture"); },
    async close() { closeCalls += 1; },
  };
  const host = await createXiadieZCodeApp({
    enabled: true, assetsRoot: path.join(REPO, "assets/character"), moduleRoot: path.join(REPO, "dist"),
    installedPluginRoot: install, pluginStorageRoot: storage, dataRoot: data, ownedProfileRoot: root,
    nodeExecutable: NODE, executionPort, modelAdapter: {},
    native: { async createZCodeApp(options) { wrappedOptions = options; return app; }, getCurrentModelInvocationContext() {} },
    appOptions: { env, pluginStorageRoot: storage, userConfigPath, projectConfigPath, skipUserConfig: false },
    ...(transcriptSink ? { transcriptSink } : {}),
  });
  return { host, root, temp, closeCalls: () => closeCalls };
}

test("Hook returns while its masked material is queued; only a matching receipt reports saved", async (t) => {
  const held = deferred();
  t.after(() => held.resolve());
  let captured;
  const f = await fixture(t, async (capture) => {
    captured = capture;
    await held.promise;
    return { status: "saved", receiptId: "mock-writer-receipt-1", snapshotSha256: capture.snapshotSha256 };
  });
  await f.host.submitPrompt("synthetic source text");
  assert.ok(captured);
  assert.equal(captured.snapshot.messages[0].text, "[REDACTED]");
  assert.equal(captured.origin.locatorUse, "historical-only");
  assert.equal(captured.origin.rawRetained, false);
  assert.ok(!JSON.stringify(captured).includes("synthetic source text"));
  await assert.rejects(access(path.join(f.temp, captured.origin.temporaryLocator)), (error) => error.code === "ENOENT");
  assert.notEqual(f.host.readTranscriptDeliveries()[0].status, "saved");
  held.resolve();
  const statuses = await f.host.drainTranscripts();
  assert.equal(statuses[0].status, "saved");
  assert.equal(statuses[0].receiptId, "mock-writer-receipt-1");
  await f.host.close();
});

test("missing sink and uncertain writes remain explicit rather than becoming saved", async (t) => {
  const absent = await fixture(t);
  await absent.host.submitPrompt("synthetic no-sink");
  assert.equal(absent.host.readTranscriptDeliveries()[0].status, "unavailable");
  assert.equal(absent.host.readTranscriptDeliveries()[0].code, "sink_unconfigured");
  await absent.host.close();
  const uncertain = await fixture(t, async () => { throw new Error("synthetic writer lost ACK"); });
  await uncertain.host.submitPrompt("synthetic uncertain");
  assert.equal((await uncertain.host.drainTranscripts())[0].status, "unknown");
  await uncertain.host.close();
});

test("close waits for accepted material, rejects new turns and delegates native close once", async (t) => {
  const held = deferred();
  t.after(() => held.resolve());
  const f = await fixture(t, async (capture) => {
    await held.promise;
    return { status: "saved", receiptId: "mock-close-receipt", snapshotSha256: capture.snapshotSha256 };
  });
  await f.host.submitPrompt("synthetic close");
  let completed = false;
  const closing = f.host.close();
  assert.equal(f.host.close(), closing);
  void closing.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  await assert.rejects(f.host.submitPrompt("late turn"), /closing or closed/);
  held.resolve();
  await closing;
  assert.equal(f.closeCalls(), 1);
  assert.equal(f.host.readTranscriptDeliveries()[0].status, "saved");
});
