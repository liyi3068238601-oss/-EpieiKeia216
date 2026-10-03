import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [worktree, outputPath] = process.argv.slice(2);
if (!worktree || !outputPath) throw new Error("usage: independent-counterexamples.mjs <author-worktree> <output-json>");
const { openEventStore, EventStoreError } = await import(pathToFileURL(path.join(worktree, "dist/packages/storage/events/src/index.js")));
const { canonicalizeJson } = await import(pathToFileURL(path.join(worktree, "dist/packages/contracts/src/events.js")));
const scratchParent = path.dirname(outputPath);
const runDirectory = await mkdtemp(path.join(scratchParent, "db-"));
const results = [];
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
function input(eventId, withCapture = false) {
  const event = {
    source: "review-independent",
    eventId,
    scope: { sessionId: "review-session", turnId: "review-turn", runId: "review-run", taskId: "review-task" },
    attemptId: `attempt-${eventId}`,
    operationId: null,
    kind: "fact",
    occurredAt: "2026-10-03T08:00:00.000Z",
    observedAt: "2026-10-03T08:00:00.100Z",
    sourceSequence: 1,
    payload: { text: "review synthetic fact" },
  };
  const origin = {
    sourcePin: "independent-review-pin",
    historicalLocator: `native-log://review/${eventId}`,
    rawSha256: "b".repeat(64),
    rawBytes: 128,
    extent: "single-event-envelope",
    rawRetained: false,
  };
  if (!withCapture) return { event, origin };
  const snapshot = {
    schemaVersion: 1,
    redactionVersion: "full-mask-v1",
    messages: [{ role: "user", text: "[REDACTED]", textBytes: 20, textSha256: sha256("review private input") }],
  };
  const capture = {
    schemaVersion: 1,
    sessionId: event.scope.sessionId,
    turnId: event.scope.turnId,
    hookEventName: "UserPromptSubmit",
    origin: {
      temporaryLocator: "review-hook/current.jsonl",
      locatorUse: "historical-only",
      rawBytes: 48,
      rawSha256: "c".repeat(64),
      sourcePin: "independent-review-pin",
      extent: "current-message",
      rawRetained: false,
    },
    snapshot,
    snapshotSha256: sha256(canonicalizeJson(snapshot)),
  };
  return { event, origin, capture };
}
function append(store, value) {
  const admission = store.append(value);
  assert.equal(admission.status, "queued", `unexpected append admission ${admission.status}`);
  return admission.completion;
}
async function closeStore(store) { await store.close(); }

try {
  // Real COMMIT happens, then the caller loses the acknowledgement.
  {
    const dbPath = path.join(runDirectory, "lost-ack.sqlite");
    const store = openEventStore({ path: dbPath });
    const value = input("lost-ack-1");
    const proto = DatabaseSync.prototype;
    const originalExec = proto.exec;
    let injected = false;
    try {
      proto.exec = function commitThenLoseAck(sql) {
        if (!injected && String(sql).trim().toUpperCase() === "COMMIT") {
          injected = true;
          originalExec.call(this, sql);
          throw new Error("independent injected lost ACK after actual SQLite COMMIT");
        }
        return originalExec.call(this, sql);
      };
      const outcome = await append(store, value);
      assert.equal(injected, true);
      assert.equal(outcome.status, "unknown");
      assert.equal(outcome.code, "UNKNOWN_COMMIT");
      results.push({ id: "commit-ack-lost", passed: true, outcome: outcome.status, code: outcome.code });
    } finally {
      proto.exec = originalExec;
    }
    await closeStore(store);
    const reopened = openEventStore({ path: dbPath });
    const receipt = reopened.queryReceipt({ source: value.event.source, eventId: value.event.eventId });
    assert.equal(receipt.status, "found");
    const retry = await append(reopened, value);
    assert.equal(retry.status, "duplicate");
    assert.equal(reopened.read().items.length, 1);
    assert.equal(reopened.readObservations().items.length, 1);
    await closeStore(reopened);
    results.at(-1).receiptAfterReopen = receipt.status;
    results.at(-1).retry = retry.status;
    results.at(-1).factCountAfterRetry = 1;
    results.at(-1).observationCountAfterRetry = 1;
  }

  // Failure after fact/origin/receipt inserts but during capture insert must roll back all transaction material and sequence.
  {
    const dbPath = path.join(runDirectory, "atomic-capture.sqlite");
    const store = openEventStore({ path: dbPath });
    const blocker = new DatabaseSync(dbPath);
    blocker.exec(`CREATE TRIGGER independent_fail_transcript BEFORE INSERT ON transcript_materials
      BEGIN SELECT RAISE(ABORT, 'independent capture material failure'); END;`);
    blocker.close();
    const value = input("atomic-capture-1", true);
    const failed = await append(store, value);
    assert.equal(failed.status, "failed");
    assert.equal(store.queryReceipt({ source: value.event.source, eventId: value.event.eventId }).status, "not_found");
    assert.equal(store.read().items.length, 0);
    assert.equal(store.readObservations().items.length, 0);
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    const counts = verify.prepare(`SELECT
      (SELECT count(*) FROM events) AS facts,
      (SELECT count(*) FROM event_observations) AS observations,
      (SELECT count(*) FROM event_origins) AS origins,
      (SELECT count(*) FROM event_receipts) AS receipts,
      (SELECT count(*) FROM transcript_materials) AS materials,
      (SELECT last_commit_sequence FROM writer_state WHERE singleton = 1) AS last_sequence`).get();
    assert.deepEqual({ ...counts }, { facts: 0, observations: 0, origins: 0, receipts: 0, materials: 0, last_sequence: 0 });
    verify.close();
    const repair = new DatabaseSync(dbPath);
    repair.exec("DROP TRIGGER independent_fail_transcript");
    repair.close();
    const recovered = await append(store, value);
    assert.equal(recovered.status, "committed");
    assert.equal(recovered.commitSequence, 1);
    assert.equal(store.readObservations().items[0].capture.snapshot.messages[0].text, "[REDACTED]");
    await closeStore(store);
    results.push({ id: "capture-transaction-atomicity", passed: true, failedWrite: failed.status, rowCountsAfterRollback: counts, recoveredCommitSequence: recovered.commitSequence });
  }

  // Corrupt the receipt mirror and require the receipt read path to fail closed.
  {
    const dbPath = path.join(runDirectory, "corrupt-receipt.sqlite");
    const store = openEventStore({ path: dbPath });
    const value = input("corrupt-receipt-1");
    const committed = await append(store, value);
    assert.equal(committed.status, "committed");
    await closeStore(store);
    const tamper = new DatabaseSync(dbPath);
    const changed = tamper.prepare("UPDATE event_receipts SET canonical_hash = ? WHERE source = ? AND event_id = ?")
      .run("a".repeat(64), value.event.source, value.event.eventId);
    assert.equal(changed.changes, 1);
    tamper.close();
    const readonly = openEventStore({ path: dbPath, readOnly: true });
    assert.throws(() => readonly.queryReceipt({ source: value.event.source, eventId: value.event.eventId }),
      (error) => error instanceof EventStoreError && error.code === "CORRUPT_STORE");
    await closeStore(readonly);
    results.push({ id: "corrupt-receipt-read-fail-closed", passed: true, api: "queryReceipt", expectedCode: "CORRUPT_STORE" });
  }

  await writeFile(outputPath, JSON.stringify({ schema: "p02-u05-independent-counterexamples/v1", results }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ cases: results.length, passed: results.filter((item) => item.passed).length, output: outputPath }));
} finally {}


