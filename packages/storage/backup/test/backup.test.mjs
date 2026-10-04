import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import BetterSQLite3 from "better-sqlite3";
// Keep Node SQLite only for explicit fixture creation and inspection; fault injection targets the product binding.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const experimentParent = path.resolve(repositoryRoot, ".runtime", "P02", "experiments", "u08", "backup");
const workerPath = path.join(testDirectory, "backup-worker.mjs");
await mkdir(experimentParent, { recursive: true });

const backupModule = await import(new URL("../../../../dist/packages/storage/backup/src/index.js", import.meta.url).href);
const eventStoreModule = await import(new URL("../../../../dist/packages/storage/events/src/index.js", import.meta.url).href);
const contractsModule = await import(new URL("../../../../dist/packages/contracts/src/events.js", import.meta.url).href);
const { backupAndMigrateEventStore, restoreEventStoreBackup, BackupMaintenanceError } = backupModule;
const { openEventStore } = eventStoreModule;
const { canonicalizeJson } = contractsModule;

test("empty v0 is backed up as empty v0 before the source initializes to v1", async (t) => {
  const fixture = await makeFixture(t, "empty-v0");
  await createEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);

  const report = await backupAndMigrateEventStore({
    databasePath: fixture.databasePath,
    backupDirectory: fixture.backupDirectory,
    backupName: "empty-v0.sqlite",
  });
  assert.equal(report.mode, "initialize-empty-v0-to-v1");
  assert.equal(report.sourceSchemaVersion, 0);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(countsFrom(report.sourceVerification), emptyCounts());
  assert.deepEqual(report.backupVerification, report.sourceVerification);
  assert.equal(report.sourceVerification.integrityCheck, "ok");
  assert.equal(report.backupVerification.integrityCheck, "ok");
  assert.equal(report.backupSha256, await sha256File(report.backupPath));

  const backup = inspectRawDatabase(report.backupPath);
  assert.equal(backup.userVersion, 0);
  assert.equal(backup.integrityCheck, "ok");
  assert.deepEqual(backup.userObjects, []);
  const source = inspectRawDatabase(fixture.databasePath);
  assert.equal(source.userVersion, 1);
  assert.equal(source.integrityCheck, "ok");
  assert.ok(source.userObjects.length > 0, "source must contain the initialized v1 schema");
});

test("active-WAL v1 snapshot restores committed facts, observations, writer receipts and capture hashes", async (t) => {
  const fixture = await makeFixture(t, "active-wal");
  await mkdir(fixture.backupDirectory);
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());

  await append(store, makeInput("fact-u08-1", "fact", { payload: { text: "synthetic fact one" }, capture: makeCapture() }));
  await append(store, makeInput("intent-u08-1", "operation_intent", {
    operationId: "operation-u08-1",
    payload: { action: "synthetic-write", input: { file: "owned.txt" } },
  }));
  await append(store, makeInput("receipt-u08-1", "operation_receipt", {
    operationId: "operation-u08-1",
    payload: { status: "success", result: { toolCallId: "tool-u08-1" } },
  }));

  const walPath = `${fixture.databasePath}-wal`;
  const walBefore = await readFile(walPath);
  assert.ok(walBefore.length > 32, "committed state must still be present in an active WAL");
  const expected = readStoreState(store);
  assert.equal(expected.facts.length, 3);
  assert.equal(expected.observations.length, 3);
  assert.equal(expected.receipts.length, 3);
  assert.equal(expected.captureHashes.length, 1);

  // This is deliberately the incomplete negative control: SQLite's main file alone is not the live WAL state.
  const mainOnlyPath = path.join(fixture.directory, "main-only.sqlite");
  await copyFile(fixture.databasePath, mainOnlyPath);
  let mainOnly;
  try { mainOnly = inspectRawDatabase(mainOnlyPath); } catch { /* Missing WAL context may make the main-only copy unreadable. */ }
  assert.ok(
    mainOnly === undefined || mainOnly.userVersion !== 1 || mainOnly.counts.factCount !== expected.facts.length ||
      mainOnly.counts.observationCount !== expected.observations.length ||
      mainOnly.counts.captureCount !== expected.captureHashes.length ||
      mainOnly.counts.receiptCount !== expected.facts.length,
    "copying only the main database file must fail to reproduce the committed WAL snapshot",
  );

  const report = await backupAndMigrateEventStore({
    databasePath: fixture.databasePath,
    backupDirectory: fixture.backupDirectory,
    backupName: "active-wal.sqlite",
  });
  assert.equal(report.mode, "snapshot-v1-only");
  assert.equal(report.sourceSchemaVersion, 1);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.sourceVerification.integrityCheck, "ok");
  assert.equal(report.sourceVerification.foreignKeyCheck, "ok");
  assert.deepEqual(report.backupVerification, report.sourceVerification);
  assert.deepEqual(countsFrom(report.sourceVerification), {
    facts: expected.facts.length,
    observations: expected.observations.length,
    origins: expected.observations.length,
    receipts: expected.facts.length,
    captures: expected.captureHashes.length,
    materials: expected.captureHashes.length,
  });
  assert.equal(report.backupSha256, await sha256File(report.backupPath));

  const backupStore = openEventStore({ path: report.backupPath, readOnly: true });
  fixture.own(() => backupStore.close());
  const backedUp = readStoreState(backupStore);
  assert.deepEqual(backedUp, expected);

  const destinationDirectory = path.join(fixture.directory, "restored-root");
  await assert.rejects(stat(destinationDirectory), { code: "ENOENT" });
  const restored = await restoreEventStoreBackup({
    backupPath: report.backupPath,
    destinationDirectory,
  });
  assert.equal(restored.schemaVersion, 1);
  assert.equal(restored.databasePath, path.join(destinationDirectory, "events.sqlite"));
  assert.equal(restored.backupSha256, report.backupSha256);
  assert.equal(restored.verification.integrityCheck, "ok");
  assert.equal(restored.databaseSha256, await sha256File(restored.databasePath));
  assert.deepEqual(countsFrom(restored.verification), countsFrom(report.backupVerification));
  assert.equal(await sha256File(report.backupPath), report.backupSha256, "restore must not mutate its backup source");

  const restoredStore = openEventStore({ path: restored.databasePath, readOnly: true });
  fixture.own(() => restoredStore.close());
  assert.deepEqual(readStoreState(restoredStore), expected);

  const restoredBytes = await readFile(restored.databasePath);
  await assert.rejects(
    restoreEventStoreBackup({ backupPath: report.backupPath, destinationDirectory }),
    (error) => isMaintenanceError(error, "restore-source", "PUBLISH_CONFLICT"),
  );
  assert.deepEqual(await readFile(restored.databasePath), restoredBytes,
    "restoring into an existing root must preserve the original restored database bytes");
});

test("backup publication never replaces a pre-existing name", async (t) => {
  const fixture = await makeFixture(t, "no-clobber");
  await createEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);
  const first = await backupAndMigrateEventStore({
    databasePath: fixture.databasePath,
    backupDirectory: fixture.backupDirectory,
    backupName: "fixed-name.sqlite",
  });
  const firstBytes = await readFile(first.backupPath);
  const firstHash = sha256(firstBytes);

  const walStore = openEventStore({ path: fixture.databasePath });
  await walStore.close();
  assert.equal(inspectRawDatabase(fixture.databasePath).journalMode, "wal",
    "the second publication attempt must exercise an existing v1 WAL source");

  await assert.rejects(
    backupAndMigrateEventStore({
      databasePath: fixture.databasePath,
      backupDirectory: fixture.backupDirectory,
      backupName: "fixed-name.sqlite",
    }),
    (error) => isMaintenanceError(error, "publish", "PUBLISH_CONFLICT"),
  );
  assert.deepEqual(await readFile(first.backupPath), firstBytes);
  assert.equal(await sha256File(first.backupPath), firstHash);
});

test("a real COMMIT followed by a lost acknowledgement is read back or reported unresolved without replay", async (t) => {
  await t.test("verified readback resolves the committed migration as success", async (t) => {
    const outcome = await runLostCommitAckFixture(t, "ack-readback-success", false);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.report.mode, "initialize-empty-v0-to-v1");
    assert.equal(outcome.readbackFailureInjected, false);
    assert.equal(outcome.schemaExecCount, 1, "migration DDL must run exactly once");
    assert.equal(outcome.commitExecCount, 1, "the real COMMIT must not be automatically replayed");
    assertV1SourceAndV0Backup(outcome.fixture, outcome.report.backupPath);
  });

  await t.test("unavailable readback reports unresolved and preserves the verified snapshot", async (t) => {
    const outcome = await runLostCommitAckFixture(t, "ack-readback-unavailable", true);
    assert.ok(isMaintenanceError(outcome.error, "migrate", "UNRESOLVED_TRANSACTION"),
      `expected unresolved transaction, got ${safeError(outcome.error)}`);
    assert.equal(outcome.readbackFailureInjected, true, "the readback failure must be controlled and observed");
    assert.equal(outcome.schemaExecCount, 1, "migration DDL must run exactly once");
    assert.equal(outcome.commitExecCount, 1, "the real COMMIT must not be automatically replayed");
    assertV1SourceAndV0Backup(outcome.fixture, path.join(outcome.fixture.backupDirectory, "ack.sqlite"));
  });
});

test("future schema and non-empty v0 user objects are refused without changing source main or WAL bytes", async (t) => {
  await t.test("future schema", async (t) => {
    const fixture = await makeFixture(t, "future-schema");
    await mkdir(fixture.backupDirectory);
    const source = await createWalDatabase(fixture.databasePath, 2, "future_object");
    fixture.own(() => source.close());
    const before = await mainAndWalDigests(fixture.databasePath);
    assert.ok(before.wal?.bytes > 32, "the rejected future database has live uncheckpointed WAL bytes");

    await assert.rejects(
      backupAndMigrateEventStore({ databasePath: fixture.databasePath, backupDirectory: fixture.backupDirectory }),
      (error) => isMaintenanceError(error, "preflight", "UNSUPPORTED_FUTURE_SCHEMA"),
    );
    assert.deepEqual(await mainAndWalDigests(fixture.databasePath), before);
    assert.deepEqual(await readdir(fixture.backupDirectory), []);
  });

  await t.test("non-empty v0 table and view", async (t) => {
    const fixture = await makeFixture(t, "legacy-v0-objects");
    await mkdir(fixture.backupDirectory);
    const source = await createWalDatabase(fixture.databasePath, 0, "legacy_object");
    fixture.own(() => source.close());
    const before = await mainAndWalDigests(fixture.databasePath);
    assert.ok(before.wal?.bytes > 32, "the rejected v0 database has live uncheckpointed WAL bytes");

    await assert.rejects(
      backupAndMigrateEventStore({ databasePath: fixture.databasePath, backupDirectory: fixture.backupDirectory }),
      (error) => isMaintenanceError(error, "preflight", "UNSUPPORTED_SCHEMA"),
    );
    assert.deepEqual(await mainAndWalDigests(fixture.databasePath), before);
    assert.deepEqual(await readdir(fixture.backupDirectory), []);
  });
});

test("a second SQLite BEGIN IMMEDIATE makes maintenance return bounded BUSY before backup or DDL", async (t) => {
  const fixture = await makeFixture(t, "busy-lock");
  await createEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);
  const blocker = new DatabaseSync(fixture.databasePath, { timeout: 0 });
  fixture.own(() => closeDatabase(blocker));
  blocker.exec("BEGIN IMMEDIATE");

  const startedAt = performance.now();
  await assert.rejects(
    backupAndMigrateEventStore({ databasePath: fixture.databasePath, backupDirectory: fixture.backupDirectory }),
    (error) => isMaintenanceError(error, "lock", "BUSY"),
  );
  const waitedMs = performance.now() - startedAt;
  assert.ok(waitedMs >= 100 && waitedMs < 5000, `bounded SQLite BUSY wait was ${waitedMs.toFixed(1)}ms`);
  assert.deepEqual(await readdir(fixture.backupDirectory), []);
  const source = inspectRawDatabase(fixture.databasePath);
  assert.equal(source.userVersion, 0);
  assert.deepEqual(source.userObjects, []);
  blocker.exec("ROLLBACK");
  await closeDatabase(blocker);
});

test("a controlled deadline aborts the real SQLite backup progress callback before v0 DDL", async (t) => {
  const fixture = await makeFixture(t, "backup-deadline");
  await createPaddedEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);
  const originalNow = performance.now.bind(performance);
  const ownNow = Object.getOwnPropertyDescriptor(performance, "now");
  let clockCalls = 0;
  Object.defineProperty(performance, "now", {
    configurable: true,
    writable: true,
    value() {
      clockCalls += 1;
      return originalNow() + (clockCalls * 10);
    },
  });
  try {
    await assert.rejects(
      backupAndMigrateEventStore({
        databasePath: fixture.databasePath,
        backupDirectory: fixture.backupDirectory,
        backupName: "deadline.sqlite",
        deadlineMs: 1,
      }),
      (error) => isMaintenanceError(error, "backup", "BACKUP_DEADLINE"),
    );
  } finally {
    if (ownNow === undefined) delete performance.now;
    else Object.defineProperty(performance, "now", ownNow);
  }
  assert.ok(clockCalls >= 2, `the real backup progress callback observed the controlled monotonic clock ${clockCalls} times`);
  const retained = await readdir(fixture.backupDirectory);
  assert.ok(!retained.includes("deadline.sqlite"), "a partial snapshot must not be published as final");
  const privateStages = retained.filter((name) => name.startsWith(".p02-snapshot-"));
  assert.equal(privateStages.length, 1, "failed backup staging remains available for diagnosis");
  const backupRoot = await realpath(fixture.backupDirectory);
  const stagePath = path.join(fixture.backupDirectory, privateStages[0]);
  const stageInfo = await lstat(stagePath);
  assert.ok(stageInfo.isDirectory() && !stageInfo.isSymbolicLink());
  assertContained(backupRoot, await realpath(stagePath));
  const source = inspectRawDatabase(fixture.databasePath);
  assert.equal(source.userVersion, 0);
  assert.deepEqual(source.userObjects, [], "backup failure must prevent migration DDL");
});

test("backup checks the deadline after the real Better transfer resolves without a final progress callback", async (t) => {
  const fixture = await makeFixture(t, "backup-deadline-after-transfer");
  await createEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);
  const delay = delayCompletedBackupPastDeadline((destination) =>
    path.basename(destination) === "snapshot.sqlite" && path.basename(path.dirname(destination)).startsWith(".p02-snapshot-"));
  try {
    await assert.rejects(
      backupAndMigrateEventStore({
        databasePath: fixture.databasePath,
        backupDirectory: fixture.backupDirectory,
        backupName: "late-snapshot.sqlite",
        deadlineMs: 250,
      }),
      (error) => isMaintenanceError(error, "backup", "BACKUP_DEADLINE"),
    );
  } finally {
    delay.restore();
  }
  assert.equal(delay.metrics.calls, 1, "the product must call the real Better SQLite backup API");
  assert.equal(delay.metrics.completed, 1, "the real transfer must complete before its Promise is delayed");
  assert.equal(delay.metrics.finalProgressCalls, 0, "Better SQLite resolves the final transfer before reporting progress");
  assert.ok(!((await readdir(fixture.backupDirectory)).includes("late-snapshot.sqlite")),
    "a transfer that resolves after its deadline must not publish a backup");
  const source = inspectRawDatabase(fixture.databasePath);
  assert.equal(source.userVersion, 0, "an expired backup must prevent v0 migration");
  assert.deepEqual(source.userObjects, []);
});

test("restore checks the deadline after the real Better transfer and does not publish a new root database", async (t) => {
  const fixture = await makeFixture(t, "restore-deadline-after-transfer");
  await createEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);
  const created = await backupAndMigrateEventStore({
    databasePath: fixture.databasePath,
    backupDirectory: fixture.backupDirectory,
    backupName: "restore-source.sqlite",
  });
  const destinationDirectory = path.join(fixture.directory, "late-restored-root");
  const finalDatabasePath = path.join(destinationDirectory, "events.sqlite");
  const delay = delayCompletedBackupPastDeadline((destination) =>
    path.basename(destination) === "restored.sqlite" && path.basename(path.dirname(destination)) === ".p02-restore-stage");
  try {
    await assert.rejects(
      restoreEventStoreBackup({
        backupPath: created.backupPath,
        destinationDirectory,
        deadlineMs: 250,
      }),
      (error) => isMaintenanceError(error, "restore-backup", "BACKUP_DEADLINE"),
    );
  } finally {
    delay.restore();
  }
  assert.equal(delay.metrics.calls, 1, "restore must call the real Better SQLite backup API");
  assert.equal(delay.metrics.completed, 1, "the real restore transfer must finish before its Promise is delayed");
  assert.equal(delay.metrics.finalProgressCalls, 0, "the final transfer has no progress callback");
  await assert.rejects(stat(finalDatabasePath), { code: "ENOENT" }, "an expired restore must not publish events.sqlite");
  const stagedPath = path.join(destinationDirectory, ".p02-restore-stage", "restored.sqlite");
  assert.equal(inspectRawDatabase(stagedPath).integrityCheck, "ok", "the completed transfer remains private in staging");
});

test("real SQLite SQLITE_FULL during migration preserves v0 and the already published backup", async (t) => {
  const fixture = await makeFixture(t, "migration-full");
  await createEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);
  const prototype = BetterSQLite3.prototype;
  const originalExec = prototype.exec;
  let pageLimitSet = false;
  prototype.exec = function constrainMaintenancePages(sql, ...args) {
    const result = originalExec.call(this, sql, ...args);
    if (String(sql).trim().toUpperCase() === "BEGIN IMMEDIATE" && !pageLimitSet) {
      const pages = Number(this.prepare("PRAGMA page_count").get().page_count);
      originalExec.call(this, `PRAGMA max_page_count = ${Math.max(1, pages)}`);
      pageLimitSet = true;
    }
    return result;
  };
  let failure;
  try {
    await backupAndMigrateEventStore({
      databasePath: fixture.databasePath,
      backupDirectory: fixture.backupDirectory,
      backupName: "before-full.sqlite",
    });
  } catch (error) {
    failure = error;
  } finally {
    prototype.exec = originalExec;
  }
  assert.equal(pageLimitSet, true, "the actual coordinator BEGIN IMMEDIATE received the test-only page cap");
  assert.ok(isMaintenanceError(failure, "migrate", "FULL"), `expected migration FULL, got ${safeError(failure)}`);
  const source = inspectRawDatabase(fixture.databasePath);
  assert.equal(source.userVersion, 0, "failed migration must roll back the schema version");
  assert.deepEqual(source.userObjects, [], "failed migration must roll back created tables");
  const backupPath = path.join(fixture.backupDirectory, "before-full.sqlite");
  const backup = inspectRawDatabase(backupPath);
  assert.equal(backup.userVersion, 0);
  assert.equal(backup.integrityCheck, "ok");
  assert.deepEqual(backup.userObjects, []);
});

test("an owned worker killed immediately before or after COMMIT reopens as valid v0 or v1 with a usable v0 backup", async (t) => {
  for (const phase of ["before", "after"]) {
    await t.test(`${phase} COMMIT`, async (t) => {
      const fixture = await makeFixture(t, `kill-${phase}-commit`);
      await createEmptyV0(fixture.databasePath);
      await mkdir(fixture.backupDirectory);
      const markerPath = path.join(fixture.directory, "commit-boundary.json");
      const child = spawnCommitWorker(fixture, phase, markerPath);
      fixture.own(() => stopOwnedChild(child).then(() => undefined));

      const marker = await waitForMarker(child, markerPath);
      assert.deepEqual(marker, { phase, pid: child.pid }, "only the exact owned worker may be terminated");
      const stopped = await stopOwnedChild(child);
      assert.notEqual(stopped.code, 0, "the owned worker must be terminated at the observed commit boundary");

      const source = inspectRawDatabase(fixture.databasePath);
      assert.equal(source.integrityCheck, "ok");
      assert.equal(source.userVersion, phase === "before" ? 0 : 1);
      if (phase === "before") assert.deepEqual(source.userObjects, []);
      else assert.ok(source.userObjects.length > 0, "post-COMMIT state must contain v1 schema");

      const backup = inspectRawDatabase(path.join(fixture.backupDirectory, "killed.sqlite"));
      assert.equal(backup.userVersion, 0, "the published pre-migration snapshot must remain v0");
      assert.equal(backup.integrityCheck, "ok");
      assert.deepEqual(backup.userObjects, []);
    });
  }
});

function delayCompletedBackupPastDeadline(matchesDestination) {
  const prototype = BetterSQLite3.prototype;
  const originalBackup = prototype.backup;
  let calls = 0;
  let completed = 0;
  let finalProgressCalls = 0;
  prototype.backup = function delayActualBackupResolution(destinationFile, options) {
    const matches = matchesDestination(path.resolve(destinationFile));
    let actualOptions = options;
    if (matches && typeof options?.progress === "function") {
      actualOptions = {
        ...options,
        progress(info) {
          if (info.remainingPages === 0) finalProgressCalls += 1;
          return options.progress(info);
        },
      };
    }
    const transfer = originalBackup.call(this, destinationFile, actualOptions);
    if (!matches) return transfer;
    calls += 1;
    return transfer.then(async (metadata) => {
      completed += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return metadata;
    });
  };

  return {
    get metrics() {
      return { calls, completed, finalProgressCalls };
    },
    restore() {
      prototype.backup = originalBackup;
    },
  };
}

async function makeFixture(t, prefix) {
  const parentInfo = await lstat(experimentParent);
  assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "U08 experiment root must be a physical directory");
  const physicalParent = await realpath(experimentParent);
  const directory = await mkdtemp(path.join(physicalParent, `${prefix}-`));
  const physicalDirectory = await realpath(directory);
  assertContained(physicalParent, physicalDirectory);
  const backupDirectory = path.join(physicalDirectory, "backups");
  const cleanupActions = [];
  t.after(async () => {
    for (const action of cleanupActions.reverse()) {
      try { await action(); } catch { /* Keep the real assertion as the primary result. */ }
    }
    await removeOwnedFixture(physicalDirectory);
  });
  return {
    directory: physicalDirectory,
    databasePath: path.join(physicalDirectory, "events.sqlite"),
    backupDirectory,
    own(action) { cleanupActions.push(action); },
  };
}

async function removeOwnedFixture(target) {
  const physicalParent = await realpath(experimentParent);
  const absoluteTarget = path.resolve(target);
  const targetStat = await lstat(absoluteTarget).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (targetStat === undefined) return;
  assert.ok(targetStat.isDirectory() && !targetStat.isSymbolicLink(), "cleanup target must be an owned physical fixture directory");
  const physicalTarget = await realpath(absoluteTarget);
  assertContained(physicalParent, physicalTarget);
  await rm(physicalTarget, { recursive: true, force: true });
}

function assertContained(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "test cleanup target must remain beneath the U08 experiment root");
}

async function createEmptyV0(databasePath) {
  const database = new DatabaseSync(databasePath);
  try { database.exec("PRAGMA user_version = 1; PRAGMA user_version = 0"); }
  finally { database.close(); }
}

async function createPaddedEmptyV0(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE padding (payload BLOB NOT NULL)");
    const insert = database.prepare("INSERT INTO padding(payload) VALUES (?)");
    const pageFiller = Buffer.alloc(8192, 0x5a);
    for (let index = 0; index < 600; index += 1) insert.run(pageFiller);
    database.exec("DROP TABLE padding; PRAGMA user_version = 1; PRAGMA user_version = 0");
  } finally {
    database.close();
  }
  const readOnlyDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(readOnlyDatabase.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(readOnlyDatabase.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_'").get()?.count, 0);
    assert.ok(readOnlyDatabase.prepare("PRAGMA page_count").get()?.page_count > 500,
      "the empty v0 database must require multiple real backup progress steps");
  } finally {
    readOnlyDatabase.close();
  }
}

async function createWalDatabase(databasePath, userVersion, tableName) {
  const database = new DatabaseSync(databasePath, { timeout: 0 });
  const journal = database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
  assert.equal(journal, "wal");
  database.exec(`CREATE TABLE ${tableName} (value TEXT NOT NULL)`);
  database.exec(`CREATE VIEW ${tableName}_view AS SELECT value FROM ${tableName}`);
  database.prepare(`INSERT INTO ${tableName}(value) VALUES (?)`).run("owned preflight sentinel");
  database.exec(`PRAGMA user_version = ${userVersion}`);
  return database;
}

function inspectRawDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const userVersion = database.prepare("PRAGMA user_version").get()?.user_version;
    const journalMode = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const integrityCheck = database.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const userObjects = database.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE type IN ('table', 'view', 'trigger', 'index') AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all().map(({ name, type }) => ({ name, type }));
    const names = new Set(userObjects.map(({ name }) => name));
    const tableCount = (name) => names.has(name)
      ? database.prepare(`SELECT count(*) AS count FROM ${name}`).get()?.count
      : 0;
    const counts = {
      factCount: tableCount("events"),
      observationCount: tableCount("event_observations"),
      receiptCount: tableCount("event_receipts"),
      captureCount: tableCount("transcript_materials"),
    };
    return { userVersion, journalMode, integrityCheck, userObjects, counts };
  } finally {
    database.close();
  }
}

async function runLostCommitAckFixture(t, prefix, failReadback) {
  const fixture = await makeFixture(t, prefix);
  await createEmptyV0(fixture.databasePath);
  await mkdir(fixture.backupDirectory);

  const prototype = BetterSQLite3.prototype;
  const originalExec = prototype.exec;
  const originalPrepare = prototype.prepare;
  let commitAckThrown = false;
  let readbackFailureInjected = false;
  let schemaExecCount = 0;
  let commitExecCount = 0;
  prototype.exec = function commitThenLoseAcknowledgement(sql, ...args) {
    const statement = String(sql);
    const normalized = statement.trim().toUpperCase();
    if (!commitAckThrown && statement.includes("CREATE TABLE writer_state")) schemaExecCount += 1;
    if (normalized === "COMMIT") commitExecCount += 1;
    const result = originalExec.call(this, sql, ...args);
    if (normalized === "COMMIT" && !commitAckThrown) {
      commitAckThrown = true;
      throw new Error("controlled lost SQLite COMMIT acknowledgement");
    }
    return result;
  };
  prototype.prepare = function failReadbackOnceAfterCommit(sql, ...args) {
    if (failReadback && commitAckThrown && !readbackFailureInjected &&
        String(sql).trim().toUpperCase() === "PRAGMA USER_VERSION") {
      readbackFailureInjected = true;
      throw new Error("controlled readback unavailable after committed COMMIT");
    }
    return originalPrepare.call(this, sql, ...args);
  };

  let report;
  let error;
  try {
    report = await backupAndMigrateEventStore({
      databasePath: fixture.databasePath,
      backupDirectory: fixture.backupDirectory,
      backupName: "ack.sqlite",
    });
  } catch (caught) {
    error = caught;
  } finally {
    prototype.exec = originalExec;
    prototype.prepare = originalPrepare;
  }
  assert.equal(commitAckThrown, true, "the actual SQLite COMMIT must execute before its acknowledgement is lost");
  return { fixture, report, error, readbackFailureInjected, schemaExecCount, commitExecCount };
}

function assertV1SourceAndV0Backup(fixture, backupPath) {
  const source = inspectRawDatabase(fixture.databasePath);
  assert.equal(source.userVersion, 1, "a true COMMIT followed by an acknowledgement error leaves the source at v1");
  assert.equal(source.integrityCheck, "ok");
  assert.ok(source.userObjects.length > 0);
  const backup = inspectRawDatabase(backupPath);
  assert.equal(backup.userVersion, 0, "the published snapshot remains the pre-migration v0 database");
  assert.equal(backup.integrityCheck, "ok");
  assert.deepEqual(backup.userObjects, []);
}

async function mainAndWalDigests(databasePath) {
  return {
    main: await fileDigest(databasePath),
    wal: await fileDigest(`${databasePath}-wal`),
  };
}

async function fileDigest(filePath) {
  const details = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (details === undefined) return null;
  assert.ok(details.isFile() && !details.isSymbolicLink(), "SQLite state path must be a regular owned file");
  const bytes = await readFile(filePath);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function emptyCounts() {
  return { facts: 0, observations: 0, origins: 0, receipts: 0, captures: 0, materials: 0 };
}

function countsFrom(verification) {
  return {
    facts: verification.facts.count,
    observations: verification.observations.count,
    origins: verification.origins.count,
    receipts: verification.receipts.count,
    captures: verification.captures.count,
    materials: verification.materials.count,
  };
}

function readStoreState(store) {
  const facts = readAllPages((query) => store.read(query)).map(({ commitSequence, event }) => ({ commitSequence, event }));
  const observations = readAllPages((query) => store.readObservations(query));
  const receipts = observations.map((observation) => {
    const receipt = store.queryReceipt({ source: observation.event.source, eventId: observation.event.eventId }, observation.observationKey);
    assert.equal(receipt.status, "found", `writer receipt is missing for ${observation.event.eventId}`);
    return {
      eventId: observation.event.eventId,
      observationKey: observation.observationKey,
      firstCommitSequence: receipt.firstReceipt.commitSequence,
      observationCommitSequence: receipt.observation.commitSequence,
      disposition: receipt.observation.disposition,
    };
  });
  const captureHashes = observations.flatMap((observation) =>
    observation.capture === undefined ? [] : [observation.capture.snapshotSha256]);
  return { facts, observations, receipts, captureHashes };
}

function readAllPages(readPage) {
  const result = [];
  let afterCommitSequence;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = readPage({ limit: 1, ...(afterCommitSequence === undefined ? {} : { afterCommitSequence }) });
    result.push(...page.items);
    if (!page.hasMore) return result;
    assert.ok(Number.isSafeInteger(page.nextAfterCommitSequence));
    assert.ok(afterCommitSequence === undefined || page.nextAfterCommitSequence > afterCommitSequence);
    afterCommitSequence = page.nextAfterCommitSequence;
  }
  assert.fail("SQLite fixture exceeded bounded complete-pagination test limit");
}

async function append(store, input) {
  const admission = store.append(input);
  assert.equal(admission.status, "queued", `append was ${admission.status}`);
  const result = await admission.completion;
  assert.equal(result.status, "committed", `append completed as ${result.status}`);
}

function makeInput(eventId, kind, options = {}) {
  const operationId = options.operationId ?? null;
  const event = {
    source: "zcode-hook",
    eventId,
    scope: { sessionId: "session-u08", turnId: "turn-u08", runId: "run-u08", taskId: "task-u08" },
    attemptId: "attempt-u08-1",
    operationId,
    kind,
    occurredAt: "2026-10-03T09:00:00.000Z",
    observedAt: "2026-10-03T09:00:00.100Z",
    sourceSequence: 1,
    payload: options.payload ?? { text: "synthetic backup fact" },
  };
  return {
    event,
    origin: {
      sourcePin: "u08-owned-fixture-source",
      historicalLocator: `owned-fixture://${eventId}`,
      rawSha256: "b".repeat(64),
      rawBytes: 128,
      extent: "single-event-envelope",
      rawRetained: false,
    },
    ...(options.capture === undefined ? {} : { capture: options.capture }),
  };
}

function makeCapture() {
  const snapshot = {
    schemaVersion: 1,
    redactionVersion: "full-mask-v1",
    messages: [{
      role: "user",
      text: "[REDACTED]",
      textBytes: 23,
      textSha256: sha256(Buffer.from("synthetic source text", "utf8")),
    }],
  };
  return {
    schemaVersion: 1,
    sessionId: "session-u08",
    turnId: "turn-u08",
    hookEventName: "UserPromptSubmit",
    origin: {
      temporaryLocator: "owned-hook/transcript.jsonl",
      locatorUse: "historical-only",
      rawBytes: 64,
      rawSha256: "c".repeat(64),
      sourcePin: "u08-owned-fixture-source",
      extent: "current-message",
      rawRetained: false,
    },
    snapshot,
    snapshotSha256: createHash("sha256").update(canonicalizeJson(snapshot), "utf8").digest("hex"),
  };
}

function isMaintenanceError(error, stage, code) {
  return error instanceof BackupMaintenanceError && error.name === "BackupMaintenanceError" &&
    error.stage === stage && error.code === code;
}

function safeError(error) {
  if (!(error instanceof Error)) return "non-Error rejection";
  return `${error.name}:${error.code ?? "no-code"}:${error.stage ?? "no-stage"}`;
}

function closeDatabase(database) {
  try { database.close(); } catch { /* The test may have explicitly closed it already. */ }
}

function spawnCommitWorker(fixture, phase, markerPath) {
  const spec = {
    phase,
    ownedRoot: fixture.directory,
    databasePath: fixture.databasePath,
    backupDirectory: fixture.backupDirectory,
    backupName: "killed.sqlite",
    markerPath,
  };
  const env = Object.fromEntries(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]
    .filter((key) => typeof process.env[key] === "string")
    .map((key) => [key, process.env[key]]));
  const child = spawn(process.execPath, [workerPath, JSON.stringify(spec)], {
    cwd: repositoryRoot,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { child.stdoutText = `${child.stdoutText}${chunk}`.slice(-4096); });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { child.stderrText = `${child.stderrText}${chunk}`.slice(-4096); });
  return child;
}

async function waitForMarker(child, markerPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const contents = await readFile(markerPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (contents !== undefined) return JSON.parse(contents);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`owned worker exited before its durable marker: ${child.stdoutText}\n${child.stderrText}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await stopOwnedChild(child);
  throw new Error(`owned worker marker timed out: ${child.stdoutText}\n${child.stderrText}`);
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  assert.ok(Number.isInteger(child.pid) && child.pid > 0, "owned worker PID must be available");
  child.kill();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned SQLite test worker did not exit within 5 seconds")), 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
