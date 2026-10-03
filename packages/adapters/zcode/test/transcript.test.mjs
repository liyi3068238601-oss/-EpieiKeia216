import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const fixtureParent = path.resolve(repositoryRoot, ".runtime", "P02", "u04-transcript-fixtures");
await mkdir(fixtureParent, { recursive: true });
const transcriptModuleUrl = new URL("../../../../dist/packages/adapters/zcode/src/transcript.js", import.meta.url);
const contractsModuleUrl = new URL("../../../../dist/packages/contracts/src/events.js", import.meta.url);
const { captureTranscript, createTranscriptQueue } = await import(transcriptModuleUrl.href);
const { canonicalizeJson } = await import(contractsModuleUrl.href);
const SOURCE_PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";

test("capture reads only the current prompt and returns a frozen full-mask historical snapshot", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "current prompt with synthetic secret");
  const result = captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit",
    sessionId: "session-u04",
    turnId: "turn-u04",
    prompt: "current prompt with synthetic secret",
  }));

  assert.equal(result.status, "captured");
  const { capture } = result;
  assert.equal(capture.origin.temporaryLocator, "zcode-hook-fixture/transcript.jsonl");
  assert.equal(capture.origin.locatorUse, "historical-only");
  assert.equal(capture.origin.extent, "current-message");
  assert.equal(capture.origin.rawRetained, false);
  assert.equal(capture.origin.sourcePin, SOURCE_PIN);
  assert.equal(capture.snapshotSha256, sha256(canonicalizeJson(capture.snapshot)));
  assert.deepEqual(capture.snapshot.messages, [{
    role: "user",
    text: "[REDACTED]",
    textBytes: Buffer.byteLength("current prompt with synthetic secret", "utf8"),
    textSha256: sha256("current prompt with synthetic secret"),
  }]);
  assert.equal(JSON.stringify(capture).includes("synthetic secret"), false);
  assert.ok(Object.isFrozen(capture));
  assert.ok(Object.isFrozen(capture.origin));
  assert.ok(Object.isFrozen(capture.snapshot));
  assert.ok(Object.isFrozen(capture.snapshot.messages));
  assert.ok(Object.isFrozen(capture.snapshot.messages[0]));

  await rm(fixture.transcriptPath);
  assert.equal(capture.origin.temporaryLocator, "zcode-hook-fixture/transcript.jsonl");
  assert.equal(capture.snapshot.messages[0].text, "[REDACTED]");
});

test("capture uses Stop responseText (or responsePreview fallback) and verifies the trace", async (t) => {
  const fixture = await createTranscriptFile(t, "assistant", "final response");
  const result = captureTranscript(captureInput(fixture, {
    hookEventName: "Stop",
    sessionId: "session-u04",
    turnId: "turn-u04",
    responseText: "final response",
    responsePreview: "different preview must not win",
  }));
  assert.equal(result.status, "captured");
  assert.deepEqual(result.capture.snapshot.messages.map(({ role, text }) => ({ role, text })), [
    { role: "assistant", text: "[REDACTED]" },
  ]);

  const mismatch = captureTranscript({
    ...captureInput(fixture, {
      hookEventName: "UserPromptSubmit",
      sessionId: "session-u04",
      turnId: "turn-u04",
      prompt: "final response",
    }),
    trace: { hookEventName: "UserPromptSubmit", sessionId: "other-session", turnId: "turn-u04" },
  });
  assert.deepEqual(mismatch, { status: "rejected", code: "trace_mismatch" });
});

test("capture rejects external, malformed, half-written, oversized, and linked transcript inputs", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "prompt");
  const outside = path.join(fixtureParent, `outside-${path.basename(fixture.root)}.jsonl`);
  await writeFile(outside, messageLine("user", "prompt"), "utf8");
  t.after(async () => removeOwnedFixture(outside));
  assert.deepEqual(captureTranscript({
    ...captureInput(fixture, { hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "prompt" }),
    hookInput: {
      hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", transcriptPath: outside, prompt: "prompt",
    },
  }), { status: "rejected", code: "outside_owned_temp" });

  await writeFile(fixture.transcriptPath, messageLine("user", "prompt").trimEnd(), "utf8");
  assert.deepEqual(captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "prompt",
  })), { status: "rejected", code: "incomplete_line" });

  await writeFile(fixture.transcriptPath, "{not-json}\n", "utf8");
  assert.deepEqual(captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "prompt",
  })), { status: "rejected", code: "malformed_jsonl" });

  await writeFile(fixture.transcriptPath, Buffer.alloc(512 * 1024 + 1, 0x78));
  assert.deepEqual(captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "prompt",
  })), { status: "rejected", code: "too_large" });

  const outsideDirectory = await mkdtemp(path.join(fixtureParent, "outside-directory-"));
  t.after(async () => removeOwnedFixture(outsideDirectory));
  const linkPath = path.join(fixture.root, "zcode-hook-fixture", "linked-temp");
  try {
    await symlink(outsideDirectory, linkPath, "junction");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("junction creation unavailable on this host; lexical escape rejection was tested");
      return;
    }
    throw error;
  }
  const linkedPath = path.join(linkPath, "transcript.jsonl");
  await writeFile(linkedPath, messageLine("user", "prompt"), "utf8");
  assert.deepEqual(captureTranscript({
    ...captureInput(fixture, { hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "prompt" }),
    hookInput: {
      hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", transcriptPath: linkedPath, prompt: "prompt",
    },
  }), { status: "rejected", code: "linked_path" });
});

test("capture reports injected EACCES without treating it as an NTFS ACL test", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "prompt");
  const originalOpenSync = fs.openSync;
  fs.openSync = (filename, ...args) => {
    if (path.resolve(String(filename)) === path.resolve(fixture.transcriptPath)) {
      throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    }
    return originalOpenSync(filename, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(captureTranscript(captureInput(fixture, {
      hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "prompt",
    })), { status: "rejected", code: "unreadable" });
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
  }
});

test("capture detects a file changed during the bounded read", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "prompt");
  const originalReadSync = fs.readSync;
  const originalWriteFileSync = fs.writeFileSync;
  let changed = false;
  fs.readSync = (...args) => {
    const bytesRead = originalReadSync(...args);
    if (!changed && bytesRead > 0) {
      changed = true;
      originalWriteFileSync(fixture.transcriptPath, Buffer.concat([fixture.bytes, Buffer.from(" ")]));
    }
    return bytesRead;
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(captureTranscript(captureInput(fixture, {
      hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "prompt",
    })), { status: "rejected", code: "unstable_read" });
  } finally {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
  }
});

test("queue returns immediately, bounds active plus waiting work, and saves only a matching receipt", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "queue secret");
  const result = captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "queue secret",
  }));
  assert.equal(result.status, "captured");
  const { capture } = result;
  let releaseSink;
  let received;
  const queue = createTranscriptQueue({
    maxPending: 1,
    sink: async (sanitizedCapture) => {
      received = sanitizedCapture;
      return new Promise((resolve) => { releaseSink = resolve; });
    },
  });

  const accepted = queue.enqueue(capture);
  assert.equal(accepted.status, "queued");
  assert.deepEqual(queue.getStatus(accepted.jobId), {
    jobId: accepted.jobId, status: "queued", snapshotSha256: capture.snapshotSha256,
  });
  assert.deepEqual(queue.enqueue(capture), { status: "queue_full" });
  await Promise.resolve();
  assert.equal(queue.getStatus(accepted.jobId).status, "saving");
  assert.equal(received.snapshotSha256, capture.snapshotSha256);
  assert.equal(JSON.stringify(received).includes("queue secret"), false);
  assert.ok(Object.isFrozen(received));
  assert.ok(Object.isFrozen(received.snapshot.messages[0]));

  const drained = queue.drain();
  releaseSink({ status: "saved", receiptId: "receipt-u04-1", snapshotSha256: capture.snapshotSha256 });
  await drained;
  assert.deepEqual(queue.getStatus(accepted.jobId), {
    jobId: accepted.jobId,
    status: "saved",
    snapshotSha256: capture.snapshotSha256,
    receiptId: "receipt-u04-1",
  });
  await queue.close();
  assert.deepEqual(queue.enqueue(capture), { status: "closed" });
});

test("queue distinguishes explicit failure from throwing or malformed unknown receipts", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "queue prompt");
  const result = captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "queue prompt",
  }));
  assert.equal(result.status, "captured");
  const cases = [
    { name: "throw", sink: async () => { throw new Error("synthetic sink failure"); }, status: "unknown", code: "sink_threw" },
    { name: "mismatched receipt", sink: async () => ({ status: "saved", receiptId: "wrong", snapshotSha256: "0".repeat(64) }), status: "unknown", code: "invalid_receipt" },
    { name: "explicit failure", sink: async () => ({ status: "failed", code: "write_failed" }), status: "failed", code: "write_failed" },
  ];
  for (const scenario of cases) {
    const queue = createTranscriptQueue({ sink: scenario.sink });
    const accepted = queue.enqueue(result.capture);
    assert.equal(accepted.status, "queued", scenario.name);
    await queue.drain();
    assert.deepEqual(queue.getStatus(accepted.jobId), {
      jobId: accepted.jobId,
      status: scenario.status,
      snapshotSha256: result.capture.snapshotSha256,
      code: scenario.code,
    }, scenario.name);
    await queue.close();
  }
});

test("queue close rejects new work and drains accepted jobs; status history stays within 64", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "queue prompt");
  const result = captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "queue prompt",
  }));
  assert.equal(result.status, "captured");
  let releaseSink;
  const queue = createTranscriptQueue({
    sink: async (capture) => new Promise((resolve) => {
      releaseSink = () => resolve({ status: "saved", receiptId: "closed-job", snapshotSha256: capture.snapshotSha256 });
    }),
  });
  const accepted = queue.enqueue(result.capture);
  assert.equal(accepted.status, "queued");
  await Promise.resolve();
  const closing = queue.close();
  assert.deepEqual(queue.enqueue(result.capture), { status: "closed" });
  let drained = false;
  void closing.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  releaseSink();
  await closing;
  assert.equal(queue.getStatus(accepted.jobId).status, "saved");

  const history = createTranscriptQueue({
    sink: async (capture) => ({ status: "saved", receiptId: "ring", snapshotSha256: capture.snapshotSha256 }),
  });
  for (let index = 0; index < 65; index += 1) {
    const item = history.enqueue(result.capture);
    assert.equal(item.status, "queued");
    await history.drain();
  }
  assert.equal(history.readRecentStatuses().length, 64);
  assert.equal(history.readRecentStatuses()[0].jobId, 2);
  assert.equal(history.getStatus(1), undefined);
  assert.deepEqual(history.readRecentStatuses(0), []);
  await history.close();
});

test("queue rejects forged captures that add raw transcript material", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "must not enter queue");
  const result = captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "must not enter queue",
  }));
  assert.equal(result.status, "captured");
  let sinkCalls = 0;
  const queue = createTranscriptQueue({ sink: async (capture) => {
    sinkCalls += 1;
    return { status: "saved", receiptId: "valid", snapshotSha256: capture.snapshotSha256 };
  } });
  assert.deepEqual(queue.enqueue({ ...result.capture, rawText: "must not enter queue" }), { status: "invalid_capture" });
  await queue.drain();
  assert.equal(sinkCalls, 0);
  await queue.close();
});

test("drain waits only for jobs accepted at its call frontier", async (t) => {
  const fixture = await createTranscriptFile(t, "user", "frontier prompt");
  const result = captureTranscript(captureInput(fixture, {
    hookEventName: "UserPromptSubmit", sessionId: "s", turnId: "t", prompt: "frontier prompt",
  }));
  assert.equal(result.status, "captured");
  const releases = [];
  const queue = createTranscriptQueue({
    maxPending: 2,
    sink: async (capture) => new Promise((resolve) => releases.push(() => resolve({
      status: "saved", receiptId: `frontier-${releases.length}`, snapshotSha256: capture.snapshotSha256,
    }))),
  });
  const first = queue.enqueue(result.capture);
  assert.equal(first.status, "queued");
  await Promise.resolve();
  const firstFrontier = queue.drain();
  const second = queue.enqueue(result.capture);
  assert.equal(second.status, "queued");
  releases[0]();
  await firstFrontier;
  assert.equal(queue.getStatus(first.jobId).status, "saved");
  assert.equal(queue.getStatus(second.jobId).status, "saving");
  releases[1]();
  await queue.close();
  assert.equal(queue.getStatus(second.jobId).status, "saved");
});

async function createTranscriptFile(t, role, text) {
  const realFixtureParent = await realpath(fixtureParent);
  const root = await mkdtemp(path.join(realFixtureParent, "owned-"));
  const hookDirectory = path.join(root, "zcode-hook-fixture");
  await mkdir(hookDirectory);
  const transcriptPath = path.join(hookDirectory, "transcript.jsonl");
  const bytes = Buffer.from(messageLine(role, text), "utf8");
  await writeFile(transcriptPath, bytes);
  t.after(async () => removeOwnedFixture(root));
  return { root, transcriptPath, bytes };
}

async function removeOwnedFixture(target) {
  const absoluteTarget = path.resolve(target);
  const realFixtureParent = await realpath(fixtureParent);
  const physicalParent = await realpath(path.dirname(absoluteTarget));
  const physicalTarget = path.join(physicalParent, path.basename(absoluteTarget));
  assertContained(realFixtureParent, physicalTarget);
  await rm(physicalTarget, { recursive: true, force: true });
}

function assertContained(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "recursive test cleanup target must stay inside the named fixture parent");
}

function captureInput(fixture, hookInput) {
  return {
    hookInput: { ...hookInput, transcriptPath: fixture.transcriptPath },
    trace: {
      hookEventName: hookInput.hookEventName,
      sessionId: hookInput.sessionId,
      turnId: hookInput.turnId,
    },
    ownedTempRoot: fixture.root,
    sourcePin: SOURCE_PIN,
  };
}

function messageLine(role, text) {
  return `${JSON.stringify({ message: { content: [{ type: "text", text }], role } })}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
