import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = 'E:\\Xiadie\\Xiadie';
const author = path.join(root, '.runtime', 'P02', 'worktrees', 'mature-sqlite-store');
const review = path.join(root, '.runtime', 'P02', 'reviews', 'mature-sqlite-store-u05');
const data = path.join(review, 'data');
fs.mkdirSync(data, { recursive: true });
const authorRequire = createRequire(path.join(author, 'package.json'));
const Database = authorRequire('better-sqlite3');
const { openEventStore, EventStoreError } = await import(
  pathToFileURL(path.join(author, 'dist', 'packages', 'storage', 'events', 'src', 'index.js')).href
);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const input = (eventId) => ({
  event: {
    source: 'review-synthetic',
    eventId,
    scope: { sessionId: 'review-session', turnId: 'review-turn', runId: 'review-run', taskId: 'review-task' },
    attemptId: 'review-attempt',
    operationId: null,
    kind: 'fact',
    occurredAt: '2026-10-04T06:30:00.000Z',
    observedAt: '2026-10-04T06:30:01.000Z',
    sourceSequence: 1,
    payload: { text: 'review-owned synthetic event' },
  },
  origin: {
    sourcePin: 'review-synthetic-source-v1',
    historicalLocator: 'review-fixture://synthetic/1',
    rawSha256: 'b'.repeat(64),
    rawBytes: 64,
    extent: 'single-event-envelope',
    rawRetained: false,
  },
});
async function append(store, value) {
  const admission = store.append(value);
  assert.equal(admission.status, 'queued', 'product API should accept the synthetic event');
  return admission.completion;
}
function sidecars(dbPath) {
  return [dbPath, dbPath + '-wal', dbPath + '-shm'].map((filename) => {
    if (!fs.existsSync(filename)) return { path: filename, exists: false };
    const bytes = fs.readFileSync(filename);
    return { path: filename, exists: true, bytes: bytes.length, sha256: sha256(bytes) };
  });
}
function productError(run) {
  try {
    run();
  } catch (error) {
    return { name: error.name, code: error.code, message: error.message };
  }
  throw new Error('expected the product API to reject this invalid state');
}

const results = {
  schema: 'p02-u05-review-negative-cases/v1',
  dataRoot: data,
  runtime: { node: process.version, executable: process.execPath },
  cases: {},
};

const missingPath = path.join(data, 'readonly-missing.sqlite');
assert.deepEqual(sidecars(missingPath).map(({ exists }) => exists), [false, false, false]);
const missingError = (() => {
  try {
    openEventStore({ path: missingPath, readOnly: true });
  } catch (error) {
    return { name: error.name, code: error.code, message: error.message };
  }
  throw new Error('readonly open unexpectedly accepted a missing store');
})();
const missingAfter = sidecars(missingPath);
assert.equal(missingError.code, 'UNSUPPORTED_SCHEMA');
assert.deepEqual(missingAfter.map(({ exists }) => exists), [false, false, false]);
results.cases.readonlyMissing = { error: missingError, filesBeforeAndAfter: missingAfter };

const unsafePath = path.join(data, 'unsafe-stored-integer.sqlite');
const unsafeInput = input('unsafe-stored-integer');
const unsafeStore = openEventStore({ path: unsafePath });
const unsafeCommit = await append(unsafeStore, unsafeInput);
assert.equal(unsafeCommit.status, 'committed');
await unsafeStore.close();
const tamper = new Database(unsafePath);
tamper.pragma('ignore_check_constraints = ON');
tamper.defaultSafeIntegers(true);
const unsafe = BigInt('9007199254740993');
tamper.prepare('UPDATE event_observations SET source_sequence = ? WHERE observation_key = ?')
  .run(unsafe, unsafeCommit.observationKey);
const persisted = tamper.prepare(
  'SELECT source_sequence FROM event_observations WHERE observation_key = ?',
).get(unsafeCommit.observationKey).source_sequence;
assert.equal(persisted, unsafe, 'the fixture must contain the exact unsafe integer, not its rounded Number');
tamper.close();
const unsafeRead = openEventStore({ path: unsafePath, readOnly: true });
const readError = productError(() => unsafeRead.readObservations());
const receiptError = productError(() => unsafeRead.queryReceipt({
  source: unsafeInput.event.source,
  eventId: unsafeInput.event.eventId,
}));
assert.equal(readError.code, 'CORRUPT_STORE');
assert.equal(receiptError.code, 'CORRUPT_STORE');
await unsafeRead.close();
results.cases.unsafeStoredInteger = {
  seededStatus: unsafeCommit.status,
  exactPersistedInteger: persisted.toString(),
  readObservationsError: readError,
  queryReceiptError: receiptError,
  databaseFiles: sidecars(unsafePath),
};

const ackPath = path.join(data, 'duplicate-ack-loss.sqlite');
const ackInput = input('duplicate-ack-loss');
const ackStore = openEventStore({ path: ackPath });
const first = await append(ackStore, ackInput);
assert.equal(first.status, 'committed');
const prototype = Database.prototype;
const originalExec = prototype.exec;
let armed = true;
prototype.exec = function commitAndLoseAck(sql) {
  const result = originalExec.call(this, sql);
  if (armed && String(sql).trim().toUpperCase() === 'COMMIT') {
    armed = false;
    throw new Error('review-injected lost ACK after successful duplicate COMMIT');
  }
  return result;
};
let lostAck;
try {
  lostAck = await append(ackStore, ackInput);
} finally {
  prototype.exec = originalExec;
}
assert.equal(lostAck.status, 'unknown');
const receipt = ackStore.queryReceipt(
  { source: ackInput.event.source, eventId: ackInput.event.eventId },
  lostAck.observationKey,
);
assert.equal(receipt.status, 'found');
assert.equal(receipt.observation.commitSequence, first.commitSequence);
const beforeRetry = { facts: ackStore.read().items.length, observations: ackStore.readObservations().items.length };
assert.deepEqual(beforeRetry, { facts: 1, observations: 1 });
const retry = await append(ackStore, ackInput);
assert.equal(retry.status, 'duplicate');
assert.equal(retry.commitSequence, first.commitSequence);
const afterRetry = { facts: ackStore.read().items.length, observations: ackStore.readObservations().items.length };
assert.deepEqual(afterRetry, beforeRetry);
await ackStore.close();
const reopened = openEventStore({ path: ackPath, readOnly: true });
const reopenedReceipt = reopened.queryReceipt(
  { source: ackInput.event.source, eventId: ackInput.event.eventId },
  first.observationKey,
);
assert.equal(reopenedReceipt.status, 'found');
assert.equal(reopenedReceipt.observation.commitSequence, first.commitSequence);
const reopenedCounts = { facts: reopened.read().items.length, observations: reopened.readObservations().items.length };
assert.deepEqual(reopenedCounts, { facts: 1, observations: 1 });
await reopened.close();
results.cases.duplicateAckLoss = {
  initial: { status: first.status, commitSequence: first.commitSequence },
  afterCommittedDuplicateAckLoss: { status: lostAck.status, code: lostAck.code },
  durableReceipt: { status: receipt.status, commitSequence: receipt.observation.commitSequence },
  retry: { status: retry.status, commitSequence: retry.commitSequence },
  countsBeforeRetry: beforeRetry,
  countsAfterRetry: afterRetry,
  countsAfterReopen: reopenedCounts,
  databaseFiles: sidecars(ackPath),
};

fs.writeFileSync(path.join(review, 'negative-results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
