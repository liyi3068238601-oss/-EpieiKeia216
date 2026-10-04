import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync as NodeDatabaseSync, backup as nodeBackup } from "node:sqlite";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const p02RuntimeRoot = path.resolve(repositoryRoot, "../..");
const experimentRoot = path.join(p02RuntimeRoot, "experiments", "mature-sqlite-spike");
const reviewerRoot = path.join(p02RuntimeRoot, "reviews", "mature-sqlite-u02");
const installRoot = path.join(experimentRoot, "install");
const fixedNode = path.resolve(repositoryRoot, "../../../P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe");
const requireFromInstall = createRequire(path.join(installRoot, "package.json"));
const packageManifestPath = requireFromInstall.resolve("better-sqlite3/package.json");
const packageRoot = fs.realpathSync(path.dirname(packageManifestPath));
const packageManifest = JSON.parse(fs.readFileSync(packageManifestPath, "utf8"));
const addonLoads = [];
const originalDlopen = process.dlopen;
process.dlopen = function captureNativeLoad(module, filename, ...args) {
  addonLoads.push(path.resolve(filename));
  return originalDlopen.call(this, module, filename, ...args);
};
const BetterDatabase = requireFromInstall("better-sqlite3");
const addonProbe = new BetterDatabase(":memory:");
const bindingSqliteVersion = addonProbe.prepare("SELECT sqlite_version() AS version").get().version;
addonProbe.close();
process.dlopen = originalDlopen;

const args = parseArguments(process.argv.slice(2));
if (args.childPhase) {
  runCrashWorker(args.childPhase, args.childDatabase);
} else {
  await runExperiment(args);
}

async function runExperiment(options) {
  assert.equal(process.execPath.toLowerCase(), fixedNode.toLowerCase(), "must run with the pinned Node 24.14.0 executable");
  assert.equal(process.version, "v24.14.0");
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.ok(Number(process.versions.napi) >= 10, `Node N-API ${process.versions.napi} is older than package requirement 10`);
  assert.equal(packageManifest.version, "13.0.3");
  assert.equal(packageManifest.license, "MIT");
  assert.equal(packageManifest.engines.node, ">=22");
  assert.equal(packageManifest.scripts?.install, undefined, "the npm package must not run an install script");

  const addonPath = addonLoads.find((filename) => filename.toLowerCase().endsWith("\\prebuilds\\win32-x64.node"));
  assert.ok(addonPath, `a Windows x64 prebuilt addon was not actually loaded: ${JSON.stringify(addonLoads)}`);
  assert.equal(normalizeWindowsPath(addonPath), normalizeWindowsPath(path.join(packageRoot, "prebuilds", "win32-x64.node")));
  const installRecordPath = path.join(experimentRoot, "01-install.json");
  const installRecord = JSON.parse(fs.readFileSync(installRecordPath, "utf8"));
  assert.equal(installRecord.exit_code, 0);
  assert.ok(installRecord.argv.includes("--ignore-scripts"));
  assert.ok(installRecord.argv.some((value) => value.includes("node-v24.14.0-win-x64")));

  const dataRoot = path.resolve(options.dataRoot);
  assertContainedInOneOf([path.join(experimentRoot, "runs"), reviewerRoot], dataRoot);
  assert.ok(!fs.existsSync(dataRoot), `experiment data root already exists: ${dataRoot}`);
  fs.mkdirSync(dataRoot, { recursive: true });
  const resultPath = path.resolve(options.resultPath);
  assertContainedInOneOf([path.join(repositoryRoot, "evidence", "P02-U02", "20261004-02"), reviewerRoot], resultPath);
  assert.ok(!fs.existsSync(resultPath), `result already exists: ${resultPath}`);

  const nodeV1Path = path.resolve(options.nodeV1Path);
  const expectedNodeV1Path = path.join(p02RuntimeRoot, "experiments", "completion-u10", "full-01", "scenarios", "success", "profile", "plugin-storage", "data", "xiadie@xiadie-local", "event-ledger.sqlite");
  assert.equal(normalizeWindowsPath(nodeV1Path), normalizeWindowsPath(expectedNodeV1Path), "interop fixture must be the identified synthetic Node product ledger");
  assert.ok(fs.statSync(nodeV1Path).isFile(), `existing Node v1 database missing: ${nodeV1Path}`);
  const packageBefore = packageState();
  const sourceBefore = sqliteArtifactState(nodeV1Path);
  const testResults = [];
  const record = async (name, operation) => {
    try {
      const details = await operation();
      testResults.push({ name, status: "pass", details });
    } catch (error) {
      testResults.push({ name, status: "fail", error: errorRecord(error) });
    }
  };

  testResults.push({
    name: "pinned Windows N-API prebuilt loaded",
    status: "pass",
    details: {
      node: process.version,
      napi: process.versions.napi,
      packageVersion: packageManifest.version,
      packageLicense: packageManifest.license,
      loadedAddon: addonPath,
      prebuiltSha256: sha256File(addonPath), sqliteVersion: bindingSqliteVersion,
      packageRoot,
      installExitCode: installRecord.exit_code,
      installUsedIgnoreScripts: true,
    },
  });

  await record("normalized unique key, exact duplicate, and same-id payload conflict", async () => {
    const filename = path.join(dataRoot, "identity.sqlite");
    const db = new BetterDatabase(filename, { timeout: 120 });
    try {
      db.pragma("foreign_keys = ON");
      db.exec(`CREATE TABLE normalized_events (
        source TEXT NOT NULL, event_id TEXT NOT NULL, canonical_payload TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 64),
        PRIMARY KEY(source, event_id)
      ) STRICT, WITHOUT ROWID;`);
      const find = db.prepare("SELECT canonical_payload, payload_sha256 FROM normalized_events WHERE source = ? AND event_id = ?");
      const insert = db.prepare("INSERT INTO normalized_events(source, event_id, canonical_payload, payload_sha256) VALUES (?, ?, ?, ?)");
      const write = db.transaction((source, eventId, payload) => {
        const canonical = canonicalJson(payload);
        const hash = sha256(canonical);
        const prior = find.get(source, eventId);
        if (prior) return prior.payload_sha256 === hash ? "duplicate" : "conflict";
        insert.run(source, eventId, canonical, hash);
        return "committed";
      }).immediate;
      assert.equal(write("zcode-hook", "evt-1", { text: "first synthetic fact" }), "committed");
      assert.equal(write("zcode-hook", "evt-1", { text: "first synthetic fact" }), "duplicate");
      assert.equal(write("zcode-hook", "evt-1", { text: "different synthetic fact" }), "conflict");
      assert.throws(() => insert.run("zcode-hook", "evt-1", "{}", "0".repeat(64)), (error) =>
        String(error.code).startsWith("SQLITE_CONSTRAINT"));
      assert.equal(db.prepare("SELECT count(*) AS count FROM normalized_events").get().count, 1);
      assert.equal(find.get("zcode-hook", "evt-1").canonical_payload, '{"text":"first synthetic fact"}');
      return { rowsAfterReplayAndConflict: 1, duplicate: "no second fact", conflict: "original preserved", uniqueConstraint: "SQLITE_CONSTRAINT" };
    } finally { db.close(); }
  });

  await record("worker kill before transaction commit rolls back the whole bundle", async () =>
    killTransactionAndCheck(path.join(dataRoot, "kill-before.sqlite"), "before"));
  await record("worker kill after committed transaction retains the whole bundle", async () =>
    killTransactionAndCheck(path.join(dataRoot, "kill-after.sqlite"), "after"));

  await record("better-sqlite3 online backup captures committed WAL and restores a readable database", async () => {
    const filename = path.join(dataRoot, "wal-live.sqlite");
    const snapshotPath = path.join(dataRoot, "wal-snapshot.sqlite");
    const restoredPath = path.join(dataRoot, "wal-restored.sqlite");
    const live = new BetterDatabase(filename, { timeout: 120 });
    try {
      assert.equal(live.pragma("journal_mode = WAL", { simple: true }), "wal");
      live.pragma("wal_autocheckpoint = 0");
      live.pragma("synchronous = FULL");
      live.exec("CREATE TABLE backup_rows(id INTEGER PRIMARY KEY, payload BLOB NOT NULL) STRICT;");
      const insert = live.prepare("INSERT INTO backup_rows(id, payload) VALUES (?, ?)");
      const fill = live.transaction(() => {
        for (let id = 1; id <= 48; id += 1) insert.run(id, Buffer.alloc(16 * 1024, id));
      });
      fill.immediate();
      const walBytes = fs.statSync(`${filename}-wal`).size;
      assert.ok(walBytes > 32, `expected committed data in the live WAL, got ${walBytes} bytes`);
      const progress = [];
      const backupResult = await live.backup(snapshotPath, { progress(state) { progress.push(state); return 64; } });
      assert.equal(backupResult.remainingPages, 0);
      assert.ok(progress.length > 0);
      const snapshot = new BetterDatabase(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(snapshot.pragma("integrity_check", { simple: true }), "ok");
        assert.equal(snapshot.prepare("SELECT count(*) AS count FROM backup_rows").get().count, 48);
        const sourceDigest = payloadDigest(live);
        assert.equal(payloadDigest(snapshot), sourceDigest);
        const restored = await snapshot.backup(restoredPath);
        assert.equal(restored.remainingPages, 0);
      } finally { snapshot.close(); }
      const restored = new NodeDatabaseSync(restoredPath, { readOnly: true });
      try {
        assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.equal(restored.prepare("SELECT count(*) AS count FROM backup_rows").get().count, 48);
      } finally { restored.close(); }
      return { liveJournalMode: "wal", committedWalBytesBeforeBackup: walBytes, rows: 48,
        payloadSha256: payloadDigest(live), backupProgressCallbacks: progress.length,
        backupRemainingPages: backupResult.remainingPages, restoredIntegrity: "ok", restoreReader: "Node 24.14.0 node:sqlite" };
    } finally { live.close(); }
  });

  await record("competing writer reports bounded SQLITE_BUSY and succeeds after release", async () => {
    const filename = path.join(dataRoot, "busy.sqlite");
    const owner = new BetterDatabase(filename, { timeout: 0 });
    const contender = new BetterDatabase(filename, { timeout: 60 });
    try {
      owner.pragma("journal_mode = WAL");
      owner.exec("CREATE TABLE writes(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;");
      owner.exec("BEGIN IMMEDIATE");
      const started = performance.now();
      assert.throws(() => contender.exec("BEGIN IMMEDIATE"), (error) => error.code === "SQLITE_BUSY");
      const waitMs = Math.round(performance.now() - started);
      assert.ok(waitMs < 1000, `busy timeout should return within the 1000ms observation ceiling, got ${waitMs}ms`);
      owner.exec("ROLLBACK");
      contender.prepare("INSERT INTO writes(value) VALUES (?)").run("after-lock-release");
      assert.equal(contender.prepare("SELECT count(*) AS count FROM writes").get().count, 1);
      return { busyCode: "SQLITE_BUSY", configuredTimeoutMs: 60, observedWaitMs: waitMs, retriedAfterRelease: 1 };
    } finally { contender.close(); owner.close(); }
  });

  await record("readonly connection reads and rejects a write", async () => {
    const filename = path.join(dataRoot, "readonly.sqlite");
    const writable = new BetterDatabase(filename);
    writable.exec("CREATE TABLE readonly_probe(value TEXT NOT NULL) STRICT; INSERT INTO readonly_probe VALUES ('synthetic');");
    writable.close();
    const readonly = new BetterDatabase(filename, { readonly: true, fileMustExist: true });
    try {
      assert.equal(readonly.prepare("SELECT value FROM readonly_probe").get().value, "synthetic");
      assert.throws(() => readonly.prepare("INSERT INTO readonly_probe VALUES ('must fail')").run(), (error) => error.code === "SQLITE_READONLY");
    } finally { readonly.close(); }
    const verify = new BetterDatabase(filename, { readonly: true, fileMustExist: true });
    try { assert.equal(verify.prepare("SELECT count(*) AS count FROM readonly_probe").get().count, 1); }
    finally { verify.close(); }
    return { read: "pass", writeError: "SQLITE_READONLY", rowCountAfterRejectedWrite: 1 };
  });

  await record("existing Node v1 schema is readable and writable in both directions; Node backup reads binding-written WAL", async () =>
    crossBindingV1(nodeV1Path, dataRoot));

  await record("unsafe SQLite integer precision is observable and the counter guard rejects corruption", async () => {
    const filename = path.join(dataRoot, "integer-precision.sqlite");
    const db = new BetterDatabase(filename);
    try {
      db.exec(`CREATE TABLE static_metadata(key TEXT PRIMARY KEY, value INTEGER NOT NULL
        CHECK(value BETWEEN 0 AND 9007199254740991)) STRICT, WITHOUT ROWID;
        INSERT INTO static_metadata VALUES ('last_commit_sequence', 9007199254740991);`);
      const maxDefault = db.prepare("SELECT value FROM static_metadata WHERE key = 'last_commit_sequence'").get().value;
      assert.equal(safeCounter(maxDefault), Number.MAX_SAFE_INTEGER);
      db.defaultSafeIntegers(true);
      const maxBigInt = db.prepare("SELECT value FROM static_metadata WHERE key = 'last_commit_sequence'").get().value;
      assert.equal(maxBigInt, BigInt(Number.MAX_SAFE_INTEGER));
      assert.equal(safeCounter(maxBigInt), Number.MAX_SAFE_INTEGER);
      db.pragma("ignore_check_constraints = ON");
      db.exec("UPDATE static_metadata SET value = 9007199254740993 WHERE key = 'last_commit_sequence'");
      db.pragma("ignore_check_constraints = OFF");
      db.defaultSafeIntegers(false);
      const roundedDefault = db.prepare("SELECT value FROM static_metadata WHERE key = 'last_commit_sequence'").get().value;
      const exactStoredText = db.prepare("SELECT CAST(value AS TEXT) AS value FROM static_metadata").get().value;
      assert.equal(exactStoredText, "9007199254740993");
      assert.equal(roundedDefault, 9007199254740992);
      assert.equal(Number.isSafeInteger(roundedDefault), false);
      assert.throws(() => safeCounter(roundedDefault), /safe integer/);
      db.defaultSafeIntegers(true);
      const exactBigInt = db.prepare("SELECT value FROM static_metadata WHERE key = 'last_commit_sequence'").get().value;
      assert.equal(exactBigInt, 9007199254740993n);
      assert.throws(() => safeCounter(exactBigInt), /safe integer/);
      return { validMaximum: Number.MAX_SAFE_INTEGER, exactStoredCorruptValue: exactStoredText,
        defaultRead: roundedDefault, defaultReadRejectedAsUnsafe: true,
        safeIntegersRead: exactBigInt.toString(), safeIntegersRejectedAboveMaximum: true,
        adapterRule: "validate integer type/range before converting; never publish an unsafe counter or static-metadata value" };
    } finally { db.close(); }
  });

  const packageAfter = packageState();
  const sourceAfter = sqliteArtifactState(nodeV1Path);
  const packageUnchanged = JSON.stringify(packageBefore) === JSON.stringify(packageAfter);
  const sourceUnchanged = JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter);
  const passed = testResults.filter((item) => item.status === "pass").length;
  const failed = testResults.length - passed;
  const finalRecord = {
    schema: "p02-u02-mature-sqlite-spike/v1",
    status: failed === 0 && packageUnchanged && sourceUnchanged ? "pass" : "fail",
    attempt: "20261004-02",
    baselineCommit: "4163f5c5d1df93878bbfd2ecd85ab98cf9e919e2",
    runtime: { executable: process.execPath, node: process.version, nodeBuiltinSQLite: process.versions.sqlite,
      nodeAbi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch },
    binding: { name: "better-sqlite3", version: packageManifest.version, sourceCommit: "dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb",
      sourceTag: "13.0.3", license: "MIT", loadedAddon: addonPath, sqliteVersion: bindingSqliteVersion },
    input: { nodeV1Database: nodeV1Path, sourceBefore, sourceAfter, unchanged: sourceUnchanged },
    packageIntegrity: { before: packageBefore, after: packageAfter, unchanged: packageUnchanged },
    results: testResults,
    counts: { tests: testResults.length, passed, failed },
    limits: [
      "Synthetic test rows and owned child processes only. The existing synthetic Node product ledger was copied together with any WAL/SHM sidecars into owned scratch, verified byte-identical before opening, and the original DB/WAL/SHM set was rechecked unchanged afterward.",
      "A killed owned worker validates process-termination recovery, not physical power loss or storage-device failure.",
      "The fixed Node 24.14.0 native Runtime 16-test evidence is historical and was not rerun in this binding-only spike.",
      "This spike selects better-sqlite3 for the normalized event store only. The backup module's binding remains for the coordinator's later decision.",
      "No model, production event, external service, desktop, or package build was used."
    ],
  };
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(finalRecord, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(finalRecord)}\n`);
  if (finalRecord.status !== "pass") process.exitCode = 1;
}

async function killTransactionAndCheck(filename, phase) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--crash-child", phase, filename], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let visibleBeforeKill;
  try {
    await waitFor(() => stdout.includes(phase === "before" ? "PRE_COMMIT_READY" : "COMMIT_DONE"), 10000, () =>
      `worker failed to signal ${phase} state; stdout=${stdout}; stderr=${stderr}`);
    const reader = new BetterDatabase(filename, { timeout: 120 });
    try { visibleBeforeKill = atomicCounts(reader); }
    finally { reader.close(); }
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.equal(child.kill("SIGKILL"), true, "could not terminate the owned transaction worker");
    const termination = await Promise.race([closed, delay(10000).then(() => { throw new Error("worker did not stop after SIGKILL"); })]);
    const recovery = new BetterDatabase(filename, { timeout: 120 });
    try {
      const afterKill = atomicCounts(recovery);
      assert.equal(recovery.pragma("integrity_check", { simple: true }), "ok");
      const expected = phase === "before" ? 0 : 1;
      assert.deepEqual(Object.values(afterKill), [expected, expected, expected]);
      return { phase, pid: child.pid, stdout, stderr, visibleBeforeKill, termination,
        rowsAfterRecovery: afterKill, integrity: "ok", signalRequested: "SIGKILL" };
    } finally { recovery.close(); }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await Promise.race([closed, delay(5000)]);
    }
    throw error;
  }
}

function runCrashWorker(phase, filename) {
  assert.ok(phase === "before" || phase === "after");
  const db = new BetterDatabase(filename, { timeout: 120 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(`CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY, canonical TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS origins(event_id TEXT PRIMARY KEY REFERENCES events(event_id), origin TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS receipts(event_id TEXT PRIMARY KEY REFERENCES events(event_id), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64)) STRICT;`);
  db.exec("BEGIN IMMEDIATE");
  const hash = "a".repeat(64);
  db.prepare("INSERT INTO events(event_id, canonical) VALUES (?, ?)").run("kill-bundle-1", '{"fact":"synthetic"}');
  db.prepare("INSERT INTO origins(event_id, origin) VALUES (?, ?)").run("kill-bundle-1", '{"source":"synthetic"}');
  db.prepare("INSERT INTO receipts(event_id, payload_hash) VALUES (?, ?)").run("kill-bundle-1", hash);
  if (phase === "after") db.exec("COMMIT");
  process.stdout.write(`${phase === "before" ? "PRE_COMMIT_READY" : "COMMIT_DONE"}\n`);
  setInterval(() => {}, 1000);
}

async function crossBindingV1(nodeV1Path, dataRoot) {
  const sourceState = sqliteArtifactState(nodeV1Path);
  const sourceCopyPath = path.join(dataRoot, "node-v1-source.sqlite");
  copySqliteArtifactSet(nodeV1Path, sourceCopyPath, sourceState);
  const sourceCopyState = sqliteArtifactState(sourceCopyPath);
  assert.deepEqual(sameArtifactSet(sourceCopyState), sameArtifactSet(sourceState), "copied source DB/WAL/SHM set must match the original byte-for-byte");
  const source = new NodeDatabaseSync(sourceCopyPath, { readOnly: true, enableForeignKeyConstraints: true, timeout: 120 });
  let initial;
  const nodeCopyPath = path.join(dataRoot, "node-v1-copy.sqlite");
  try {
    assert.equal(source.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(source.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    initial = readV1Counts(source);
    assert.ok(initial.events > 0);
    await nodeBackup(source, nodeCopyPath);
  } finally { source.close(); }
  const bindingDb = new BetterDatabase(nodeCopyPath, { timeout: 120 });
  let betterEvent;
  let betterCommit;
  try {
    bindingDb.pragma("foreign_keys = ON");
    assert.equal(bindingDb.pragma("user_version", { simple: true }), 1);
    assert.equal(bindingDb.pragma("integrity_check", { simple: true }), "ok");
    const beforeWrite = readV1Counts(bindingDb);
    assert.deepEqual(beforeWrite, initial);
    betterEvent = makeSyntheticEvent("better-writer", "cross-binding-better-1", "written by better-sqlite3");
    betterCommit = appendV1(bindingDb, "better", betterEvent);
  } finally { bindingDb.close(); }

  const nodeReader = new NodeDatabaseSync(nodeCopyPath, { enableForeignKeyConstraints: true, timeout: 120 });
  const nodeSnapshotPath = path.join(dataRoot, "node-backup-of-binding.sqlite");
  let nodeSeenBetter;
  try {
    nodeSeenBetter = nodeReader.prepare("SELECT event_json FROM event_observations WHERE source = ? AND event_id = ?").get(betterEvent.source, betterEvent.eventId);
    assert.ok(nodeSeenBetter);
    assert.equal(JSON.parse(nodeSeenBetter.event_json).payload.text, "written by better-sqlite3");
    assert.equal(nodeReader.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    await nodeBackup(nodeReader, nodeSnapshotPath);
  } finally { nodeReader.close(); }
  const backupReader = new BetterDatabase(nodeSnapshotPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(backupReader.pragma("user_version", { simple: true }), 1);
    assert.equal(backupReader.pragma("integrity_check", { simple: true }), "ok");
    const backedUpBetter = backupReader.prepare("SELECT event_json FROM event_observations WHERE source = ? AND event_id = ?").get(betterEvent.source, betterEvent.eventId);
    assert.ok(backedUpBetter);
    assert.equal(JSON.parse(backedUpBetter.event_json).payload.text, "written by better-sqlite3");
  } finally { backupReader.close(); }

  const nodeWriter = new NodeDatabaseSync(nodeCopyPath, { enableForeignKeyConstraints: true, timeout: 120 });
  let nodeEvent;
  let nodeCommit;
  try {
    nodeEvent = makeSyntheticEvent("node-writer", "cross-binding-node-1", "written by node:sqlite");
    nodeCommit = appendV1(nodeWriter, "node", nodeEvent);
  } finally { nodeWriter.close(); }
  const betterReader = new BetterDatabase(nodeCopyPath, { readonly: true, fileMustExist: true });
  let betterSeenNode;
  let finalCounts;
  try {
    assert.equal(betterReader.pragma("integrity_check", { simple: true }), "ok");
    betterSeenNode = betterReader.prepare("SELECT event_json FROM event_observations WHERE source = ? AND event_id = ?").get(nodeEvent.source, nodeEvent.eventId);
    assert.ok(betterSeenNode);
    assert.equal(JSON.parse(betterSeenNode.event_json).payload.text, "written by node:sqlite");
    finalCounts = readV1Counts(betterReader);
    assert.equal(finalCounts.events, initial.events + 2);
    assert.equal(finalCounts.receipts, initial.receipts + 2);
  } finally { betterReader.close(); }
  const sourceAfter = sqliteArtifactState(nodeV1Path);
  assert.deepEqual(sourceAfter, sourceState, "historical Node v1 input must remain byte-identical");
  return { sourceDatabase: nodeV1Path, sourceOpenedOnlyAfterOwnedCopy: sourceCopyPath,
    sourceWasReadOnly: true, sourceState, sourceAfter, sourceCopyState,
    existingV1Counts: initial, bindingWriteSequence: betterCommit, nodeReadOfBindingWrite: true,
    nodeBackupOfBindingWrittenDatabase: nodeSnapshotPath, bindingReadOfNodeBackup: true,
    nodeWriteSequence: nodeCommit, bindingReadOfNodeWrite: true, finalCounts,
    interoperability: "Node 24.14.0 node:sqlite and better-sqlite3 13.0.3 both read/write the v1 schema" };
}

function appendV1(db, writer, event) {
  const current = db.prepare("SELECT last_commit_sequence FROM writer_state WHERE singleton = 1").get();
  if (!current) throw new Error("v1 writer_state singleton is missing");
  const sequence = safeCounter(current.last_commit_sequence, "last_commit_sequence") + 1;
  const canonicalFacts = canonicalJson({ source: event.source, eventId: event.eventId, scope: event.scope,
    attemptId: event.attemptId, operationId: event.operationId, kind: event.kind,
    occurredAt: event.occurredAt, payload: event.payload });
  const factHash = sha256(canonicalFacts);
  const observationKey = sha256(`${writer}\0${event.source}\0${event.eventId}\0${sequence}`);
  const origin = { sourcePin: "synthetic-node-v1", historicalLocator: `synthetic://${writer}/${event.eventId}`,
    rawSha256: "b".repeat(64), rawBytes: 32, extent: "single-event-envelope", rawRetained: false };
  const transact = () => {
    db.prepare(`INSERT INTO events(source,event_id,session_id,turn_id,run_id,task_id,attempt_id,operation_id,
      kind,occurred_at,canonical_facts_json,canonical_hash,first_commit_sequence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.source,event.eventId,event.scope.sessionId,event.scope.turnId,
      event.scope.runId,event.scope.taskId,event.attemptId,event.operationId,event.kind,event.occurredAt,
      canonicalFacts,factHash,sequence);
    db.prepare(`INSERT INTO event_observations(observation_key,source,event_id,commit_sequence,observed_at,source_sequence,
      candidate_hash,disposition,candidate_scope_session_id,candidate_scope_turn_id,candidate_scope_run_id,
      candidate_scope_task_id,candidate_attempt_id,candidate_operation_id,candidate_kind,event_json,conflict_facts_json,origin_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(observationKey,event.source,event.eventId,sequence,event.observedAt,
      event.sourceSequence,factHash,"accepted",event.scope.sessionId,event.scope.turnId,event.scope.runId,event.scope.taskId,
      event.attemptId,event.operationId,event.kind,canonicalJson(event),null,canonicalJson(origin));
    db.prepare("INSERT INTO event_origins(source,event_id,first_observation_key) VALUES (?,?,?)")
      .run(event.source,event.eventId,observationKey);
    db.prepare("INSERT INTO event_receipts(source,event_id,canonical_hash,first_commit_sequence,committed_at) VALUES (?,?,?,?,?)")
      .run(event.source,event.eventId,factHash,sequence,event.observedAt);
    db.prepare("UPDATE writer_state SET last_commit_sequence = ? WHERE singleton = 1").run(sequence);
  };
  if (writer === "better") {
    db.transaction(transact).immediate();
  } else {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
    try { transact(); db.exec("COMMIT"); }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ } throw error; }
  }
  return { sequence, eventId: event.eventId, hash: factHash, observationKey };
}

function makeSyntheticEvent(source, eventId, text) {
  return { source, eventId,
    scope: { sessionId: "mature-sqlite-session", turnId: "mature-sqlite-turn", runId: "mature-sqlite-run", taskId: "P02-U02" },
    attemptId: "attempt-20261004-02", operationId: null, kind: "fact",
    occurredAt: "2026-10-04T04:00:00.000Z", observedAt: "2026-10-04T04:00:01.000Z", sourceSequence: 1,
    payload: { text } };
}

function readV1Counts(db) {
  const tables = ["events", "event_observations", "event_origins", "event_receipts"];
  return Object.fromEntries(tables.map((table) => [table === "events" ? "events" : table === "event_receipts" ? "receipts" : table,
    db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
}

function createAtomicSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY, canonical TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS origins(event_id TEXT PRIMARY KEY REFERENCES events(event_id), origin TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS receipts(event_id TEXT PRIMARY KEY REFERENCES events(event_id), payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64)) STRICT;`);
}

function atomicCounts(db) {
  const count = (table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
  return { events: count("events"), origins: count("origins"), receipts: count("receipts") };
}

function payloadDigest(db) {
  const hash = createHash("sha256");
  for (const row of db.prepare("SELECT id, payload FROM backup_rows ORDER BY id").all()) {
    hash.update(String(row.id));
    hash.update(row.payload);
  }
  return hash.digest("hex");
}

function safeCounter(value, name = "counter") {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name} is outside the safe integer range`);
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} is outside the safe integer range`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function packageState() {
  const packageTree = treeDigest(packageRoot);
  const lockPaths = [
    path.join(installRoot, "package.json"),
    path.join(installRoot, "pnpm-lock.yaml"),
    path.join(installRoot, "node_modules", ".pnpm", "lock.yaml"),
    path.join(installRoot, "node_modules", ".modules.yaml"),
    path.join(installRoot, "node_modules", ".pnpm-workspace-state-v1.json"),
  ];
  const files = lockPaths.filter((filename) => fs.existsSync(filename)).map((filename) => ({
    path: path.relative(installRoot, filename).replaceAll(path.sep, "/"),
    bytes: fs.statSync(filename).size,
    sha256: sha256File(filename),
  }));
  return { version: packageManifest.version, packageRoot, packageTree, installFiles: files,
    integrity: "sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
    prebuilt: { path: path.relative(packageRoot, path.join(packageRoot, "prebuilds", "win32-x64.node")),
      bytes: fs.statSync(path.join(packageRoot, "prebuilds", "win32-x64.node")).size,
      sha256: sha256File(path.join(packageRoot, "prebuilds", "win32-x64.node")) } };
}

function treeDigest(root) {
  const files = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(filename, relative);
      else if (entry.isSymbolicLink()) files.push({ path: relative, target: fs.readlinkSync(filename) });
      else if (entry.isFile()) files.push({ path: relative, bytes: fs.statSync(filename).size, sha256: sha256File(filename) });
    }
  };
  visit(root);
  const serialized = files.map((file) => `${file.path}\0${file.bytes ?? "link"}\0${file.sha256 ?? file.target}\n`).join("");
  return { files: files.length, bytes: files.reduce((total, file) => total + (file.bytes ?? 0), 0), sha256: sha256(serialized) };
}

function sqliteArtifactState(filename) {
  return [filename, `${filename}-wal`, `${filename}-shm`].map((candidate) => fs.existsSync(candidate)
    ? { path: candidate, bytes: fs.statSync(candidate).size, sha256: sha256File(candidate) }
    : { path: candidate, exists: false });
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sha256File(filename) { return sha256(fs.readFileSync(filename)); }
function normalizeWindowsPath(filename) {
  const resolved = path.resolve(filename);
  return (resolved.startsWith("\\\\?\\") ? resolved.slice(4) : resolved).toLowerCase();
}
function errorRecord(error) { return { name: error?.name ?? "Error", message: String(error?.message ?? error), code: error?.code ?? null, stack: error?.stack ?? null }; }
function assertContainedInOneOf(roots, target) {
  for (const root of roots) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return;
  }
  assert.fail(`path is outside the explicitly allowed result roots: ${target}`);
}
function assertContained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `path escaped its authorized root: ${target}`);
}
function copySqliteArtifactSet(sourcePath, destinationPath, sourceState) {
  for (const item of sourceState) {
    if (item.exists === false) continue;
    const source = item.path;
    const suffix = source.slice(sourcePath.length);
    assert.ok(suffix === "" || suffix === "-wal" || suffix === "-shm", `unexpected SQLite companion file: ${source}`);
    const destination = `${destinationPath}${suffix}`;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
  const afterCopy = sqliteArtifactState(sourcePath);
  assert.deepEqual(afterCopy, sourceState, "original database artifact set changed during copy");
}
function sameArtifactSet(items) {
  return items.map((item) => ({
    exists: item.exists ?? true,
    bytes: item.bytes,
    sha256: item.sha256,
  }));
}
function parseArguments(argv) {
  if (argv[0] === "--crash-child") return { childPhase: argv[1], childDatabase: argv[2] };
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--data-root") values.dataRoot = argv[++index];
    else if (argv[index] === "--result") values.resultPath = argv[++index];
    else if (argv[index] === "--node-v1-db") values.nodeV1Path = argv[++index];
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  for (const key of ["dataRoot", "resultPath", "nodeV1Path"]) if (!values[key]) throw new Error(`missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  return values;
}
function waitFor(predicate, timeoutMs, errorMessage) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(errorMessage()));
      setTimeout(poll, 10);
    };
    poll();
  });
}
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
