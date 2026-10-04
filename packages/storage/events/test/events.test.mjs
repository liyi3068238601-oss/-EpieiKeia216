import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const experimentParent = path.resolve(repositoryRoot, ".runtime", "P02", "experiments", "u05", "sqlite");
await mkdir(experimentParent, { recursive: true });
const eventStoreModule = await import(new URL("../../../../dist/packages/storage/events/src/index.js", import.meta.url).href);
const sqliteAdapterModule = await import(new URL("../../../../dist/packages/storage/events/src/sqlite.js", import.meta.url).href);
const contractsModule = await import(new URL("../../../../dist/packages/contracts/src/events.js", import.meta.url).href);
const { openEventStore, EventStoreError } = eventStoreModule;
const { openSQLiteConnection, SQLiteIntegerRangeError } = sqliteAdapterModule;
const { canonicalizeJson } = contractsModule;

test("atomic first fact, origin, capture material and receipt; retry, resequence and conflict remain auditable", async (t) => {
  const fixture = await makeFixture(t, "atomic");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());

  assert.deepEqual(store.getDiagnostics(), {
    schemaVersion: 1,
    journalMode: "wal",
    synchronous: 2,
    foreignKeys: 1,
    busyTimeoutMs: 180,
    readOnly: false,
  });

  const input = makeInput({ eventId: "atomic-1", sourceSequence: 4, observedAt: "2026-10-03T07:00:01.000Z" }, {
    capture: makeCapture(),
  });
  const accepted = await append(store, input);
  assert.equal(accepted.status, "committed");
  assert.equal(accepted.commitSequence, 1);
  const receipt = store.queryReceipt(identity(input.event), accepted.observationKey);
  assert.equal(receipt.status, "found");
  assert.equal(receipt.firstReceipt.commitSequence, 1);
  assert.equal(receipt.observation.commitSequence, 1);

  const factPage = store.read();
  assert.equal(factPage.items.length, 1);
  assert.equal(factPage.items[0].event.observedAt, input.event.observedAt);
  assert.equal(factPage.items[0].event.sourceSequence, 4);
  assert.equal(factPage.items[0].event.payload.text, "first fact");

  const firstObservations = store.readObservations();
  assert.equal(firstObservations.items.length, 1);
  assert.equal(firstObservations.items[0].origin.historicalLocator, input.origin.historicalLocator);
  assert.equal(firstObservations.items[0].capture.snapshot.messages[0].text, "[REDACTED]");
  assert.equal(JSON.stringify(firstObservations.items[0]).includes("synthetic private text"), false);

  const exactRetry = await append(store, input);
  assert.equal(exactRetry.status, "duplicate");
  assert.equal(exactRetry.commitSequence, accepted.commitSequence);
  assert.equal(store.readObservations().items.length, 1);

  const resequenced = makeInput({
    eventId: "atomic-1",
    sourceSequence: 9,
    observedAt: "2026-10-03T07:00:02.000Z",
  });
  const redelivery = await append(store, resequenced);
  assert.equal(redelivery.status, "duplicate");
  assert.equal(redelivery.commitSequence, 2);
  assert.equal(store.readObservations().items[1].disposition, "redelivery_resequenced");
  assert.equal(store.read().items[0].event.sourceSequence, 4);
  assert.equal(store.read().items[0].event.observedAt, "2026-10-03T07:00:01.000Z");
  assert.equal(store.queryReceipt(identity(input.event)).firstReceipt.commitSequence, 1);

  const conflict = makeInput({
    eventId: "atomic-1",
    sourceSequence: 10,
    payload: { text: "conflicting candidate" },
  }, { origin: makeOrigin("native-log://candidate-2") });
  const conflictResult = await append(store, conflict);
  assert.equal(conflictResult.status, "conflict");
  assert.equal(conflictResult.commitSequence, 3);
  assert.equal(store.read().items.length, 1);
  assert.equal(store.read().items[0].event.payload.text, "first fact");
  assert.equal(store.readObservations().items[2].disposition, "identity_conflict");
  assert.equal(store.readObservations().items[2].event.payload.text, "conflicting candidate");
  assert.equal(store.readObservations().items[2].firstCommitSequence, 1);
  const repeatedConflict = await append(store, conflict);
  assert.equal(repeatedConflict.status, "conflict");
  assert.equal(repeatedConflict.commitSequence, conflictResult.commitSequence);
  assert.equal(store.readObservations().items.length, 3);
});

test("Node's SQLite binding reads and writes the Better SQLite v1 ledger", async (t) => {
  const fixture = await makeFixture(t, "cross-binding");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const input = makeInput({ eventId: "cross-binding-node-1" });
  assert.equal((await append(store, input)).status, "committed");
  await store.close();

  const nodeDatabase = new DatabaseSync(fixture.databasePath);
  fixture.own(() => closeDatabase(nodeDatabase));
  const before = nodeDatabase.prepare(
    "SELECT committed_at FROM event_receipts WHERE source = ? AND event_id = ?",
  ).get(input.event.source, input.event.eventId);
  assert.equal(typeof before.committed_at, "string");
  const nodeWrite = nodeDatabase.prepare(
    "UPDATE event_receipts SET committed_at = ? WHERE source = ? AND event_id = ?",
  ).run("2026-10-04T12:00:00.000Z", input.event.source, input.event.eventId);
  assert.equal(nodeWrite.changes, 1);
  nodeDatabase.close();

  const reopened = openEventStore({ path: fixture.databasePath, readOnly: true });
  fixture.own(() => reopened.close());
  const receipt = reopened.queryReceipt(identity(input.event));
  assert.equal(receipt.status, "found");
  assert.equal(receipt.firstReceipt.committedAt, "2026-10-04T12:00:00.000Z");
  assert.equal(reopened.read().items.length, 1);
});

test("private SQLite adapter preserves the safe integer boundary and rejects overflow in get and all", () => {
  const database = openSQLiteConnection(":memory:", { readonly: false, timeout: 180 });
  try {
    const maximum = database.prepare("SELECT 9007199254740991 AS value").get();
    assert.equal(maximum.value, Number.MAX_SAFE_INTEGER);
    const minimum = database.prepare("SELECT -9007199254740991 AS value").get();
    assert.equal(minimum.value, Number.MIN_SAFE_INTEGER);
    assert.throws(
      () => database.prepare("SELECT 9007199254740993 AS value").get(),
      SQLiteIntegerRangeError,
    );
    assert.throws(
      () => database.prepare("SELECT 9007199254740993 AS value").all(),
      SQLiteIntegerRangeError,
    );
    assert.throws(
      () => database.prepare("SELECT -9007199254740993 AS value").all(),
      SQLiteIntegerRangeError,
    );
  } finally {
    database.close();
  }
});

test("unsafe stored writer counter fails without committing a fact or receipt", async (t) => {
  const fixture = await makeFixture(t, "unsafe-counter");
  const initial = openEventStore({ path: fixture.databasePath });
  fixture.own(() => initial.close());
  await initial.close();

  const tamper = new Database(fixture.databasePath);
  tamper.defaultSafeIntegers(true);
  tamper.pragma("ignore_check_constraints = ON");
  tamper.prepare("UPDATE writer_state SET last_commit_sequence = ? WHERE singleton = 1")
    .run(9007199254740993n);
  assert.equal(
    tamper.prepare("SELECT last_commit_sequence FROM writer_state WHERE singleton = 1").get().last_commit_sequence,
    9007199254740993n,
  );
  tamper.close();

  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const input = makeInput({ eventId: "unsafe-counter-1" });
  const result = await append(store, input);
  assert.deepEqual(result, { status: "failed", observationKey: result.observationKey, code: "CORRUPT_STORE" });
  assert.equal(store.read().items.length, 0);
  assert.equal(store.readObservations().items.length, 0);
  assert.equal(store.queryReceipt(identity(input.event)).status, "not_found");

  const audit = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  audit.defaultSafeIntegers(true);
  fixture.own(() => closeDatabase(audit));
  assert.equal(audit.prepare("SELECT count(*) AS count FROM events").get().count, 0n);
  assert.equal(audit.prepare("SELECT count(*) AS count FROM event_receipts").get().count, 0n);
});

test("scope and operation queries page complete facts and observations explicitly", async (t) => {
  const fixture = await makeFixture(t, "paging");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  await append(store, makeInput({ eventId: "page-1" }));
  await append(store, makeInput({ eventId: "page-2", kind: "operation_intent", operationId: "op-page", payload: { action: "send" } }));
  await append(store, makeInput({ eventId: "page-3" }));

  const page1 = store.read({ limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextAfterCommitSequence, 1);
  const page2 = store.read({ limit: 1, afterCommitSequence: page1.nextAfterCommitSequence });
  assert.equal(page2.items[0].event.eventId, "page-2");
  assert.equal(page2.hasMore, true);
  const page3 = store.read({ limit: 1, afterCommitSequence: page2.nextAfterCommitSequence });
  assert.equal(page3.items[0].event.eventId, "page-3");
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextAfterCommitSequence, null);

  const byScope = store.read({ scope: { sessionId: "session-u05", turnId: "turn-u05" } });
  assert.equal(byScope.items.length, 3);
  const byOperation = store.read({ operationId: "op-page" });
  assert.deepEqual(byOperation.items.map(({ event }) => event.eventId), ["page-2"]);
  assert.equal(store.readObservations({ operationId: "op-page" }).items.length, 1);
  assert.throws(() => store.read({ limit: 0 }), (error) => error instanceof EventStoreError && error.code === "INVALID_INPUT");
});

test("invalid raw, over-limit event, forged mask and mismatched capture are refused before enqueue", async (t) => {
  const fixture = await makeFixture(t, "invalid");
  const store = openEventStore({ path: fixture.databasePath, maxPending: 2 });
  fixture.own(() => store.close());

  assert.deepEqual(store.append(makeInput({}, { origin: { ...makeOrigin(), rawRetained: true } })), {
    status: "invalid", code: "INVALID_INPUT",
  });
  assert.deepEqual(store.append(makeInput({ payload: { text: "x".repeat(520 * 1024) } })), {
    status: "invalid", code: "INVALID_INPUT",
  });

  const forgedMask = makeCapture();
  const rawSnapshot = {
    ...forgedMask.snapshot,
    messages: [{ ...forgedMask.snapshot.messages[0], text: "plain private text" }],
  };
  const forged = {
    ...forgedMask,
    snapshot: rawSnapshot,
    snapshotSha256: sha256(canonicalizeJson(rawSnapshot)),
  };
  assert.deepEqual(store.append(makeInput({}, { capture: forged })), { status: "invalid", code: "INVALID_INPUT" });
  const makeCaptureWithMessages = (messages) => {
    const snapshot = { ...forgedMask.snapshot, messages };
    return { ...forgedMask, snapshot, snapshotSha256: sha256(canonicalizeJson(snapshot)) };
  };
  const validMessage = forgedMask.snapshot.messages[0];
  for (const messages of [
    [],
    [validMessage, { ...validMessage, role: "assistant" }],
    [{ ...validMessage, role: "assistant" }],
  ]) {
    assert.deepEqual(
      store.append(makeInput({}, { capture: makeCaptureWithMessages(messages) })),
      { status: "invalid", code: "INVALID_INPUT" },
    );
  }
  assert.deepEqual(store.append(makeInput({}, { capture: makeCapture({ sessionId: "other-session" }) })), {
    status: "invalid", code: "INVALID_INPUT",
  });

  const tooLargeSnapshot = {
    schemaVersion: 1,
    redactionVersion: "full-mask-v1",
    messages: Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: "[REDACTED]",
      textBytes: 100,
      textSha256: "a".repeat(64),
    })),
  };
  const tooLargeCapture = {
    ...makeCapture(),
    snapshot: tooLargeSnapshot,
    snapshotSha256: sha256(canonicalizeJson(tooLargeSnapshot)),
  };
  assert.deepEqual(store.append(makeInput({}, { capture: tooLargeCapture })), { status: "invalid", code: "INVALID_INPUT" });
  assert.equal(store.read().items.length, 0);
});

test("readback recomputes facts and rejects tampered mirror columns as CORRUPT_STORE", async (t) => {
  const fixture = await makeFixture(t, "corrupt");
  const store = openEventStore({ path: fixture.databasePath });
  await append(store, makeInput({ eventId: "corrupt-1" }));
  await store.close();

  const tamper = new Database(fixture.databasePath);
  tamper.prepare("UPDATE events SET session_id = 'forged-session' WHERE event_id = 'corrupt-1'").run();
  tamper.close();

  const readonly = openEventStore({ path: fixture.databasePath, readOnly: true });
  fixture.own(() => readonly.close());
  assert.throws(() => readonly.read(), (error) => error instanceof EventStoreError && error.code === "CORRUPT_STORE");
});

test("bounded FIFO rejects overflow and close drains its accepted frontier", async (t) => {
  const fixture = await makeFixture(t, "queue");
  const store = openEventStore({ path: fixture.databasePath, maxPending: 1 });
  fixture.own(() => store.close());
  const first = store.append(makeInput({ eventId: "queue-1" }));
  assert.equal(first.status, "queued");
  assert.deepEqual(store.append(makeInput({ eventId: "queue-2" })), { status: "queue_full" });
  const frontier = store.drain();
  const closing = store.close();
  assert.deepEqual(store.append(makeInput({ eventId: "queue-3" })), { status: "closed" });
  await frontier;
  await closing;
  assert.equal((await first.completion).status, "committed");
  assert.throws(() => store.read(), (error) => error instanceof EventStoreError && error.code === "CLOSED");
});

test("lost COMMIT acknowledgements are unknown for new and repeated observations, then reconciled by receipt", async (t) => {
  const fixture = await makeFixture(t, "lost-ack");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const input = makeInput({ eventId: "lost-ack-1" });

  const newAckLoss = await loseNextCommitAck(store, input);
  assert.equal(newAckLoss.status, "unknown");
  const firstReceipt = store.queryReceipt(identity(input.event), newAckLoss.observationKey);
  assert.equal(firstReceipt.status, "found");
  assert.equal(firstReceipt.observation.commitSequence, 1);
  assert.equal(store.readObservations().items.length, 1);

  const duplicateAckLoss = await loseNextCommitAck(store, input);
  assert.equal(duplicateAckLoss.status, "unknown");
  const duplicateReceipt = store.queryReceipt(identity(input.event), duplicateAckLoss.observationKey);
  assert.equal(duplicateReceipt.status, "found");
  assert.equal(duplicateReceipt.observation.commitSequence, 1);
  assert.equal(store.read().items.length, 1);
  assert.equal(store.readObservations().items.length, 1);
  assert.equal((await append(store, input)).commitSequence, 1);
});

test("failed COMMIT with capture rolls back fact, observation, origin, material, receipt and writer sequence atomically", async (t) => {
  const fixture = await makeFixture(t, "capture-rollback");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const prototype = Database.prototype;
  const originalExec = prototype.exec;
  prototype.exec = function failCommitBeforeSqlite(sql) {
    if (String(sql).trim().toUpperCase() === "COMMIT") throw new Error("injected COMMIT failure before SQLite commit");
    return originalExec.call(this, sql);
  };
  let result;
  try {
    result = await append(store, makeInput({ eventId: "capture-rollback-1" }, { capture: makeCapture() }));
  } finally {
    prototype.exec = originalExec;
  }
  assert.deepEqual(result, { status: "failed", observationKey: result.observationKey, code: "SQLITE_ERROR" });
  assert.equal(store.read().items.length, 0);
  assert.equal(store.readObservations().items.length, 0);
  assert.equal(store.queryReceipt({ source: "zcode-hook", eventId: "capture-rollback-1" }).status, "not_found");
  const inspect = new Database(fixture.databasePath, { readonly: true, fileMustExist: true });
  fixture.own(() => closeDatabase(inspect));
  for (const table of ["events", "event_observations", "event_origins", "transcript_materials", "event_receipts"]) {
    assert.equal(inspect.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, `${table} must roll back`);
  }
  assert.equal(inspect.prepare("SELECT last_commit_sequence FROM writer_state WHERE singleton = 1").get().last_commit_sequence, 0);
});

test("failed rollback quarantines the writer, settles queued successors unknown, and close rolls back", async (t) => {
  const fixture = await makeFixture(t, "rollback-failure");
  const store = openEventStore({ path: fixture.databasePath, maxPending: 4 });
  fixture.own(() => store.close());
  const prototype = Database.prototype;
  const originalExec = prototype.exec;
  let beginCount = 0;
  prototype.exec = function failCommitAndRollback(sql) {
    const normalizedSql = String(sql).trim().toUpperCase();
    if (normalizedSql === "BEGIN IMMEDIATE") beginCount += 1;
    if (normalizedSql === "COMMIT") throw new Error("injected COMMIT failure before SQLite commit");
    if (normalizedSql === "ROLLBACK") throw new Error("injected ROLLBACK failure");
    return originalExec.call(this, sql);
  };
  let first;
  let second;
  let settled;
  try {
    first = store.append(makeInput({ eventId: "rollback-1" }));
    second = store.append(makeInput({ eventId: "rollback-2" }));
    settled = await Promise.race([
      Promise.all([first.completion, second.completion]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("poisoned writer did not settle accepted jobs")), 2000)),
    ]);
  } finally {
    prototype.exec = originalExec;
  }
  assert.equal(beginCount, 1, "the queued successor must not enter the unresolved transaction");
  assert.deepEqual(settled.map(({ status }) => status), ["unknown", "unknown"]);
  assert.deepEqual(store.append(makeInput({ eventId: "rollback-3" })), { status: "closed" });
  assert.throws(() => store.read(), (error) => error instanceof EventStoreError && error.code === "UNRESOLVED_TRANSACTION");
  await store.close();

  const recovered = openEventStore({ path: fixture.databasePath, readOnly: true });
  fixture.own(() => recovered.close());
  assert.equal(recovered.read().items.length, 0);
  assert.equal(recovered.readObservations().items.length, 0);
});

test("close reports a SQLite close failure after settling accepted work", async (t) => {
  const fixture = await makeFixture(t, "close-failure");
  const store = openEventStore({ path: fixture.databasePath });
  const prototype = Database.prototype;
  const originalClose = prototype.close;
  let armed = true;
  prototype.close = function closeThenReportFailure() {
    const result = originalClose.call(this);
    if (armed) {
      armed = false;
      throw new Error("injected close acknowledgement failure");
    }
    return result;
  };
  let completion;
  let closePromise;
  try {
    completion = store.append(makeInput({ eventId: "close-failure-1" })).completion;
    closePromise = store.close();
    assert.equal((await completion).status, "committed");
    await assert.rejects(closePromise, /injected close acknowledgement failure/);
  } finally {
    prototype.close = originalClose;
  }
  await assert.rejects(store.close(), /injected close acknowledgement failure/);
  const recovered = openEventStore({ path: fixture.databasePath, readOnly: true });
  fixture.own(() => recovered.close());
  assert.equal(recovered.read().items.length, 1);
  await recovered.close();
});

test("actual SQLite BUSY, controlled SQLITE_FULL, readonly refusal and future-schema preflight", async (t) => {
  const busyFixture = await makeFixture(t, "busy");
  const busyStore = openEventStore({ path: busyFixture.databasePath });
  busyFixture.own(() => busyStore.close());
  const lock = new Database(busyFixture.databasePath, { timeout: 0 });
  busyFixture.own(() => closeDatabase(lock));
  lock.exec("BEGIN IMMEDIATE");
  const startedAt = performance.now();
  const busyResult = await append(busyStore, makeInput({ eventId: "busy-1" }));
  const waitedMs = performance.now() - startedAt;
  assert.equal(busyResult.status, "failed");
  assert.equal(busyResult.code, "BUSY");
  assert.ok(waitedMs >= 100 && waitedMs < 2000, `bounded BUSY wait was ${waitedMs.toFixed(1)}ms`);
  lock.exec("ROLLBACK");
  lock.close();
  assert.equal((await append(busyStore, makeInput({ eventId: "after-busy" }))).commitSequence, 1);
  await busyStore.close();

  const readonlyStore = openEventStore({ path: busyFixture.databasePath, readOnly: true });
  busyFixture.own(() => readonlyStore.close());
  assert.equal(readonlyStore.getDiagnostics().readOnly, true);
  assert.deepEqual(readonlyStore.append(makeInput({ eventId: "readonly-1" })), { status: "readonly" });
  await readonlyStore.close();
  const rawReadonly = new Database(busyFixture.databasePath, { readonly: true, fileMustExist: true });
  busyFixture.own(() => closeDatabase(rawReadonly));
  assert.throws(
    () => rawReadonly.exec("UPDATE writer_state SET last_commit_sequence = last_commit_sequence + 1"),
    (error) => /READ-ONLY|READONLY|SQLITE_READONLY/i.test(`${error.code ?? ""} ${error.message ?? ""}`),
  );

  const fullFixture = await makeFixture(t, "full");
  const fullStore = openEventStore({ path: fullFixture.databasePath });
  fullFixture.own(() => fullStore.close());
  const prototype = Database.prototype;
  const originalExec = prototype.exec;
  let pageCapSet = false;
  let pageCapReset = false;
  let pageCapConnection;
  prototype.exec = function cappedCommit(sql) {
    const normalizedSql = String(sql).trim().toUpperCase();
    if (normalizedSql === "ROLLBACK" && pageCapSet && !pageCapReset) {
      try {
        return originalExec.call(this, sql);
      } finally {
        originalExec.call(this, "PRAGMA max_page_count = 2147483646");
        pageCapReset = true;
      }
    }
    const result = originalExec.call(this, sql);
    if (normalizedSql === "COMMIT" && !pageCapSet) {
      const currentPages = this.prepare("PRAGMA page_count").get().page_count;
      originalExec.call(this, `PRAGMA max_page_count = ${currentPages}`);
      pageCapConnection = this;
      pageCapSet = true;
    }
    return result;
  };
  let fullResult;
  try {
    await append(fullStore, makeInput({ eventId: "full-base" }));
    assert.equal(pageCapSet, true);
    fullResult = await append(fullStore, makeInput({
      eventId: "full-over-cap",
      payload: { text: "F".repeat(480 * 1024) },
    }));
  } finally {
    prototype.exec = originalExec;
    if (pageCapSet && !pageCapReset) {
      originalExec.call(pageCapConnection, "PRAGMA max_page_count = 2147483646");
      pageCapReset = true;
    }
  }
  assert.equal(fullResult.status, "failed");
  assert.equal(fullResult.code, "FULL");
  assert.equal(fullStore.read().items.length, 1);
  assert.equal(fullStore.readObservations().items.length, 1);
  assert.equal(pageCapReset, true);
  const afterFull = await append(fullStore, makeInput({ eventId: "after-full" }));
  assert.equal(afterFull.commitSequence, 2);
  await fullStore.close();

  const futureFixture = await makeFixture(t, "future");
  const futureDb = new Database(futureFixture.databasePath);
  futureDb.exec("PRAGMA user_version = 99");
  futureDb.close();
  assert.throws(
    () => openEventStore({ path: futureFixture.databasePath }),
    (error) => error instanceof EventStoreError && error.code === "UNSUPPORTED_FUTURE_SCHEMA",
  );
  const verifyFuture = new Database(futureFixture.databasePath, { readonly: true, fileMustExist: true });
  assert.equal(verifyFuture.prepare("PRAGMA user_version").get().user_version, 99);
  assert.equal(verifyFuture.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  assert.equal(verifyFuture.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'").get().count, 0);
  verifyFuture.close();

  const legacyFixture = await makeFixture(t, "legacy-v0");
  const legacy = new Database(legacyFixture.databasePath);
  legacy.exec("CREATE TABLE unrelated_legacy_data (value TEXT)");
  legacy.close();
  assert.throws(
    () => openEventStore({ path: legacyFixture.databasePath }),
    (error) => error instanceof EventStoreError && error.code === "UNSUPPORTED_SCHEMA",
  );
  const verifyLegacy = new Database(legacyFixture.databasePath, { readonly: true, fileMustExist: true });
  assert.equal(verifyLegacy.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(verifyLegacy.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  assert.equal(verifyLegacy.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'unrelated_legacy_data'").get().count, 1);
  verifyLegacy.close();
});

test("owned process hard-kill before COMMIT rolls back; after COMMIT before ACK is found by receipt without duplication", async (t) => {
  const fixture = await makeFixture(t, "kill");
  const worker = path.join(testDirectory, "sqlite-worker.mjs");
  for (const phase of ["before-commit", "after-commit", "after-duplicate-commit"]) {
    const databasePath = path.join(fixture.directory, `${phase}.sqlite`);
    const markerPath = path.join(fixture.directory, `${phase}.marker.json`);
    const input = makeInput({ eventId: `hardkill-${phase}` });
    const seed = openEventStore({ path: databasePath });
    if (phase === "after-duplicate-commit") await append(seed, input);
    await seed.close();
    const child = spawn(process.execPath, [worker, databasePath, phase, markerPath, JSON.stringify(input)], {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    fixture.own(() => stopOwnedChild(child));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const marker = await waitForMarker(child, markerPath, stdout, stderr);
    const exit = await stopOwnedChild(child);
    assert.ok(exit.code !== 0 || exit.signal !== null, `worker unexpectedly completed at ${phase}`);

    const recovered = openEventStore({ path: databasePath });
    if (phase === "before-commit") {
      assert.equal(recovered.queryReceipt(identity(input.event), marker.observationKey).status, "not_found");
      assert.equal(recovered.read().items.length, 0);
      assert.equal(recovered.readObservations().items.length, 0);
    } else {
      const receipt = recovered.queryReceipt(identity(input.event), marker.observationKey);
      assert.equal(receipt.status, "found");
      assert.equal(receipt.observation.commitSequence, 1);
      assert.equal(recovered.read().items.length, 1);
      assert.equal(recovered.readObservations().items.length, 1);
      const retry = await append(recovered, input);
      assert.equal(retry.status, "duplicate");
      assert.equal(retry.commitSequence, 1);
      assert.equal(recovered.read().items.length, 1);
      assert.equal(recovered.readObservations().items.length, 1);
    }
    await recovered.close();
  }
});

async function append(store, input) {
  const admission = store.append(input);
  assert.equal(admission.status, "queued", `append was ${admission.status}`);
  return admission.completion;
}

async function loseNextCommitAck(store, input) {
  const prototype = Database.prototype;
  const originalExec = prototype.exec;
  let armed = true;
  prototype.exec = function commitThenLoseAck(sql) {
    const result = originalExec.call(this, sql);
    if (armed && String(sql).trim().toUpperCase() === "COMMIT") {
      armed = false;
      throw new Error("injected acknowledgement loss after SQLite COMMIT");
    }
    return result;
  };
  try { return await append(store, input); }
  finally { prototype.exec = originalExec; }
}

async function makeFixture(t, prefix) {
  const physicalParent = await realpath(experimentParent);
  const directory = await mkdtemp(path.join(physicalParent, `${prefix}-`));
  const cleanupActions = [];
  t.after(async () => {
    for (const action of cleanupActions.reverse()) {
      try { await action(); } catch { /* Keep the real test assertion as the primary result. */ }
    }
    await removeOwnedFixture(directory);
  });
  return {
    directory,
    databasePath: path.join(directory, "events.sqlite"),
    own(action) { cleanupActions.push(action); },
  };
}

async function removeOwnedFixture(target) {
  const physicalParent = await realpath(experimentParent);
  const absoluteTarget = path.resolve(target);
  const targetStat = await stat(absoluteTarget).catch(() => undefined);
  if (targetStat === undefined) return;
  const physicalTarget = await realpath(absoluteTarget);
  assertContained(physicalParent, physicalTarget);
  await rm(physicalTarget, { recursive: true, force: true });
}

function assertContained(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "test cleanup target must remain beneath the U05 experiment root");
}

function makeInput(overrides = {}, extra = {}) {
  const event = {
    source: "zcode-hook",
    eventId: "event-u05-1",
    scope: { sessionId: "session-u05", turnId: "turn-u05", runId: "run-u05", taskId: "task-u05" },
    attemptId: "attempt-u05-1",
    operationId: null,
    kind: "fact",
    occurredAt: "2026-10-03T07:00:00.000Z",
    observedAt: "2026-10-03T07:00:00.100Z",
    sourceSequence: 1,
    payload: { text: "first fact" },
    ...overrides,
  };
  return {
    event,
    origin: extra.origin ?? makeOrigin(),
    ...(extra.capture === undefined ? {} : { capture: extra.capture }),
  };
}

function makeOrigin(historicalLocator = "native-log://u05/line/1") {
  return {
    sourcePin: "zcode-source-pin-u05",
    historicalLocator,
    rawSha256: "b".repeat(64),
    rawBytes: 128,
    extent: "single-event-envelope",
    rawRetained: false,
  };
}

function makeCapture(overrides = {}) {
  const snapshot = {
    schemaVersion: 1,
    redactionVersion: "full-mask-v1",
    messages: [{
      role: "user",
      text: "[REDACTED]",
      textBytes: 22,
      textSha256: sha256("synthetic private text"),
    }],
  };
  return {
    schemaVersion: 1,
    sessionId: "session-u05",
    turnId: "turn-u05",
    hookEventName: "UserPromptSubmit",
    origin: {
      temporaryLocator: "owned-hook/transcript.jsonl",
      locatorUse: "historical-only",
      rawBytes: 64,
      rawSha256: "c".repeat(64),
      sourcePin: "zcode-source-pin-u05",
      extent: "current-message",
      rawRetained: false,
    },
    snapshot,
    snapshotSha256: sha256(canonicalizeJson(snapshot)),
    ...overrides,
  };
}

function identity(event) { return { source: event.source, eventId: event.eventId }; }
function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function closeDatabase(database) {
  try { database.close(); } catch { /* It may already have been explicitly closed by the test. */ }
}

async function waitForMarker(child, markerPath, stdout, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const contents = await readFile(markerPath, "utf8").catch(() => undefined);
    if (contents !== undefined) return JSON.parse(contents);
    if (child.exitCode !== null) throw new Error(`worker exited before marker: ${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await stopOwnedChild(child);
  throw new Error(`worker marker timeout: ${stdout}\n${stderr}`);
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  child.kill();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned SQLite test worker did not exit promptly")), 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
