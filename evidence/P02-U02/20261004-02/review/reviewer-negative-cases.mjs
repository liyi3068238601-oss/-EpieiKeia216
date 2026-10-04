import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(root, "negative-data");
const installRoot = "E:\\Xiadie\\Xiadie\\.runtime\\P02\\experiments\\mature-sqlite-spike\\install";
const requireFromInstall = createRequire(path.join(installRoot, "package.json"));
const BetterDatabase = requireFromInstall("better-sqlite3");

if (process.argv[2] === "--lost-ack-child") {
  runLostAckChild(process.argv[3]);
} else {
  await run();
}

async function run() {
  assert.equal(process.version, "v24.14.0");
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.ok(!fs.existsSync(dataRoot), "review data root must be new");
  fs.mkdirSync(dataRoot, { recursive: true });
  const cases = [];
  const record = async (name, fn) => {
    try { cases.push({ name, status: "pass", details: await fn() }); }
    catch (error) {
      cases.push({ name, status: "fail", error: {
        name: error?.name, code: error?.code ?? null,
        message: String(error?.message ?? error), stack: error?.stack ?? null
      } });
    }
  };

  await record("read-only open of a missing database creates no files", async () => {
    const filename = path.join(dataRoot, "missing-readonly.sqlite");
    let error;
    try { new BetterDatabase(filename, { readonly: true, fileMustExist: true }); }
    catch (caught) { error = caught; }
    assert.ok(error, "missing readonly database unexpectedly opened");
    assert.ok(String(error.code ?? "").startsWith("SQLITE_CANTOPEN"), "unexpected error code " + error.code);
    assert.deepEqual([filename, filename + "-wal", filename + "-shm"].map(fs.existsSync), [false, false, false]);
    return { errorCode: error.code, databaseAndSidecarsRemainAbsent: true };
  });

  await record("new WAL database creates its file; main-file-only copy misses committed WAL row", async () => {
    const filename = path.join(dataRoot, "new-wal.sqlite");
    const mainOnlyCopy = path.join(dataRoot, "main-only-copy.sqlite");
    const snapshotPath = path.join(dataRoot, "online-backup.sqlite");
    const db = new BetterDatabase(filename, { timeout: 120 });
    try {
      assert.ok(fs.existsSync(filename), "writable open did not create file");
      assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
      db.pragma("wal_autocheckpoint = 0");
      db.exec("CREATE TABLE wal_boundary(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;");
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.prepare("INSERT INTO wal_boundary VALUES (1, 'committed in WAL')").run();
      const walPath = filename + "-wal";
      assert.ok(fs.existsSync(walPath) && fs.statSync(walPath).size > 32, "committed WAL bytes missing");
      assert.ok(fs.existsSync(filename + "-shm"), "live WAL SHM sidecar missing");
      assert.equal(db.prepare("SELECT count(*) AS count FROM wal_boundary").get().count, 1);

      fs.copyFileSync(filename, mainOnlyCopy, fs.constants.COPYFILE_EXCL);
      const incomplete = new BetterDatabase(mainOnlyCopy, { timeout: 120 });
      let mainOnlyCount;
      try { mainOnlyCount = incomplete.prepare("SELECT count(*) AS count FROM wal_boundary").get().count; }
      finally { incomplete.close(); }
      assert.equal(mainOnlyCount, 0, "main-only copy unexpectedly included WAL-only commit");

      const backup = await db.backup(snapshotPath, { progress() { return 64; } });
      assert.equal(backup.remainingPages, 0);
      const snapshot = new BetterDatabase(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(snapshot.pragma("integrity_check", { simple: true }), "ok");
        assert.equal(snapshot.prepare("SELECT count(*) AS count FROM wal_boundary").get().count, 1);
      } finally { snapshot.close(); }
      return { writableOpenCreatedFile: true, liveWalBytes: fs.statSync(walPath).size,
        mainOnlyCopyRows: mainOnlyCount, onlineBackupRows: 1, backupRemainingPages: backup.remainingPages,
        rule: "offline-copy the complete DB/WAL/SHM set or use SQLite online backup" };
    } finally { db.close(); }
  });

  await record("safe integer rejection covers get and all for unsafe default and exact BigInt reads", async () => {
    const db = new BetterDatabase(path.join(dataRoot, "bigint-get-all.sqlite"));
    try {
      db.exec("CREATE TABLE counters(value INTEGER NOT NULL) STRICT; INSERT INTO counters VALUES (9007199254740993);");
      db.defaultSafeIntegers(false);
      const roundedGet = db.prepare("SELECT value FROM counters").get().value;
      const roundedAll = db.prepare("SELECT value FROM counters").all()[0].value;
      assert.equal(roundedGet, 9007199254740992);
      assert.equal(roundedAll, 9007199254740992);
      assert.throws(() => safeCounter(roundedGet), /safe integer/);
      assert.throws(() => safeCounter(roundedAll), /safe integer/);
      db.defaultSafeIntegers(true);
      const exactGet = db.prepare("SELECT value FROM counters").get().value;
      const exactAll = db.prepare("SELECT value FROM counters").all()[0].value;
      assert.equal(exactGet, 9007199254740993n);
      assert.equal(exactAll, 9007199254740993n);
      assert.throws(() => safeCounter(exactGet), /safe integer/);
      assert.throws(() => safeCounter(exactAll), /safe integer/);
      assert.equal(safeCounter(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
      assert.throws(() => safeCounter(-1n), /safe integer/);
      return { defaultGet: roundedGet, defaultAll: roundedAll,
        safeIntegersGet: exactGet.toString(), safeIntegersAll: exactAll.toString(),
        unsafeGetAndAllRejected: true, maximumSafeAccepted: Number.MAX_SAFE_INTEGER };
    } finally { db.close(); }
  });

  await record("commit followed by lost application acknowledgement reconciles without replay", async () => {
    const filename = path.join(dataRoot, "lost-ack.sqlite");
    const setup = new BetterDatabase(filename, { timeout: 120 });
    try {
      setup.pragma("journal_mode = WAL");
      setup.pragma("synchronous = FULL");
      setup.exec("CREATE TABLE facts(source TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(source,event_id)) STRICT, WITHOUT ROWID;" +
        "CREATE TABLE origins(source TEXT NOT NULL,event_id TEXT NOT NULL,origin TEXT NOT NULL,PRIMARY KEY(source,event_id),FOREIGN KEY(source,event_id) REFERENCES facts(source,event_id)) STRICT, WITHOUT ROWID;" +
        "CREATE TABLE receipts(source TEXT NOT NULL,event_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,PRIMARY KEY(source,event_id),FOREIGN KEY(source,event_id) REFERENCES facts(source,event_id)) STRICT, WITHOUT ROWID;");
    } finally { setup.close(); }

    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--lost-ack-child", filename], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const termination = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lost-ack worker did not exit")), 10000);
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    assert.deepEqual(termination, { code: 79, signal: null });
    assert.equal(stdout, "", "worker must exit before application acknowledgement");

    const db = new BetterDatabase(filename, { timeout: 120 });
    try {
      const counts = countsFor(db);
      assert.deepEqual(counts, { facts: 1, origins: 1, receipts: 1 });
      assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(appendFact(db, "source-a", "event-a", '{"value":1}'), "duplicate");
      assert.equal(appendFact(db, "source-a", "event-a", '{"value":2}'), "conflict");
      assert.deepEqual(countsFor(db), counts);
      return { childExit: termination, stdout, stderr, readback: counts,
        identicalRetry: "duplicate", changedPayload: "conflict", rowsAfterReconciliation: countsFor(db),
        limit: "controlled process exit after COMMIT before acknowledgement; not physical power loss" };
    } finally { db.close(); }
  });

  await record("backup to an existing destination replaces prior content", async () => {
    const source = new BetterDatabase(path.join(dataRoot, "backup-source.sqlite"));
    const destination = path.join(dataRoot, "backup-existing-target.sqlite");
    source.exec("CREATE TABLE source_payload(value TEXT NOT NULL) STRICT; INSERT INTO source_payload VALUES ('source');");
    const old = new BetterDatabase(destination);
    old.exec("CREATE TABLE old_marker(value TEXT NOT NULL) STRICT; INSERT INTO old_marker VALUES ('preserve-me');");
    old.close();
    const before = fileState(destination);
    let error = null;
    try {
      const status = await source.backup(destination);
      assert.equal(status.remainingPages, 0);
    } catch (caught) { error = { code: caught.code ?? null, message: String(caught.message ?? caught) }; }
    const after = fileState(destination);
    const verify = new BetterDatabase(destination, { readonly: true, fileMustExist: true });
    let hasSource;
    let hasOldMarker;
    try {
      hasSource = Boolean(verify.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_payload'").get());
      hasOldMarker = Boolean(verify.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='old_marker'").get());
    } finally { verify.close(); source.close(); }
    assert.equal(error, null, JSON.stringify(error));
    assert.equal(hasSource, true);
    assert.equal(hasOldMarker, false);
    assert.notDeepEqual(after, before);
    return { error, destinationBefore: before, destinationAfter: after,
      sourceTablePresent: hasSource, oldMarkerPresent: hasOldMarker,
      implication: "use a unique staged file and an explicit no-clobber publish step" };
  });

  const passed = cases.filter((item) => item.status === "pass").length;
  const result = { schema: "p02-u02-review-negative-cases/v1", status: passed === cases.length ? "pass" : "fail",
    runtime: { executable: process.execPath, node: process.version, napi: process.versions.napi,
      platform: process.platform, arch: process.arch, binding: "better-sqlite3@13.0.3" },
    cases, counts: { total: cases.length, passed, failed: cases.length - passed },
    limits: ["All database files and the child process were confined to this review directory.",
      "The range-checked helper mirrors the spike rule; no product driver is implemented in this spike.",
      "The lost-ack worker is a controlled process exit after COMMIT, not hardware power loss."] };
  fs.writeFileSync(path.join(root, "negative-result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (passed !== cases.length) process.exitCode = 1;
}

function runLostAckChild(filename) {
  const db = new BetterDatabase(filename, { timeout: 120 });
  db.pragma("foreign_keys = ON");
  const write = db.transaction(() => {
    db.prepare("INSERT INTO facts VALUES (?,?,?)").run("source-a", "event-a", '{"value":1}');
    db.prepare("INSERT INTO origins VALUES (?,?,?)").run("source-a", "event-a", "synthetic://lost-ack");
    db.prepare("INSERT INTO receipts VALUES (?,?,?)").run("source-a", "event-a", sha256('{"value":1}'));
  }).immediate;
  write();
  process.exit(79);
}

function appendFact(db, source, eventId, payload) {
  const write = db.transaction(() => {
    const existing = db.prepare("SELECT payload FROM facts WHERE source=? AND event_id=?").get(source, eventId);
    if (existing) return existing.payload === payload ? "duplicate" : "conflict";
    db.prepare("INSERT INTO facts VALUES (?,?,?)").run(source, eventId, payload);
    db.prepare("INSERT INTO origins VALUES (?,?,?)").run(source, eventId, "synthetic://retry");
    db.prepare("INSERT INTO receipts VALUES (?,?,?)").run(source, eventId, sha256(payload));
    return "committed";
  }).immediate;
  return write();
}

function countsFor(db) {
  const tables = ["facts", "origins", "receipts"];
  return Object.fromEntries(tables.map((table) => [table, db.prepare("SELECT count(*) AS count FROM " + table).get().count]));
}
function safeCounter(value) {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("counter is outside the safe integer range");
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RangeError("counter is outside the safe integer range");
  return value;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function fileState(filename) { return { bytes: fs.statSync(filename).size, sha256: createHash("sha256").update(fs.readFileSync(filename)).digest("hex") }; }
