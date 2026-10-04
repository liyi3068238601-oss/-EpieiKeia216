import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const authorRoot = path.resolve(process.argv[2]);
const reviewRoot = path.resolve(process.argv[3]);
const require = createRequire(path.join(authorRoot, "package.json"));
const BetterSQLite3 = require("better-sqlite3");
const { openEventStore } = await import(pathToFileURL(path.join(authorRoot, "dist/packages/storage/events/src/index.js")).href);
const { backupAndMigrateEventStore, BackupMaintenanceError } = await import(
  pathToFileURL(path.join(authorRoot, "dist/packages/storage/backup/src/index.js")).href);
const result = { schema: "p02-u08-review-negative-cases/v1", node: process.version, cases: [] };

await noClobberCase();
await unsafeIntegerInStagedSnapshotCase();
await writeFile(path.join(reviewRoot, "negative-results.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(result));

async function noClobberCase() {
  const root = path.join(reviewRoot, "data", "no-clobber");
  const backupDirectory = path.join(root, "backups");
  await mkdir(backupDirectory, { recursive: true });
  const databasePath = path.join(root, "events.sqlite");
  const connection = new BetterSQLite3(databasePath, { timeout: 180 });
  connection.defaultSafeIntegers(true);
  connection.close();
  const target = path.join(backupDirectory, "existing.sqlite");
  const sentinel = Buffer.from("reviewer-owned destination bytes\n", "utf8");
  await writeFile(target, sentinel, { flag: "wx" });
  let caught;
  try {
    await backupAndMigrateEventStore({ databasePath, backupDirectory, backupName: "existing.sqlite" });
  } catch (error) { caught = error; }
  assert.ok(caught instanceof BackupMaintenanceError, "the existing-name conflict must use the product error type");
  assert.equal(caught.code, "PUBLISH_CONFLICT");
  assert.equal(caught.stage, "publish");
  const actual = await readFile(target);
  assert.deepEqual(actual, sentinel, "an existing destination must remain byte-identical");
  const source = new BetterSQLite3(databasePath, { readonly: true, fileMustExist: true });
  source.defaultSafeIntegers(true);
  const userVersion = String(source.pragma("user_version", { simple: true }));
  source.close();
  assert.equal(userVersion, "0", "a publication conflict must leave the source unmigrated");
  const files = await readdir(backupDirectory);
  result.cases.push({ id: "existing_destination_no_clobber", status: "pass", code: caught.code, stage: caught.stage,
    targetBytes: actual.length, targetSha256: sha(actual), sourceUserVersion: userVersion,
    finalNamePreserved: files.includes("existing.sqlite"), privateStages: files.filter((name) => name.startsWith(".p02-snapshot-")).length });
}

async function unsafeIntegerInStagedSnapshotCase() {
  const root = path.join(reviewRoot, "data", "unsafe-staged-integer");
  const backupDirectory = path.join(root, "backups");
  await mkdir(backupDirectory, { recursive: true });
  const databasePath = path.join(root, "events.sqlite");
  const store = openEventStore({ path: databasePath });
  const input = {
    event: {
      source: "review-synthetic", eventId: "unsafe-staged-integer-1",
      scope: { sessionId: "review-session", turnId: "review-turn", runId: "review-run", taskId: "review-task" },
      attemptId: "review-attempt-1", operationId: null, kind: "fact",
      occurredAt: "2026-10-04T00:00:00.000Z", observedAt: "2026-10-04T00:00:01.000Z",
      sourceSequence: 1, payload: { text: "synthetic reviewer fixture" },
    },
    origin: { sourcePin: "reviewer-owned", historicalLocator: "reviewer-fixture://unsafe-integer",
      rawSha256: "a".repeat(64), rawBytes: 128, extent: "single-event-envelope", rawRetained: false },
  };
  const admission = store.append(input);
  let appendResult;
  if (admission.status === "queued") appendResult = await admission.completion;
  else appendResult = admission;
  assert.equal(appendResult.status, "committed", "a valid synthetic event must seed the v1 source");
  await store.close();

  const originalBackup = BetterSQLite3.prototype.backup;
  const metrics = { calls: 0, completedRealTransfers: 0, injectedRows: 0, finalProgressCallbacks: 0, injectedValue: null };
  BetterSQLite3.prototype.backup = function completeThenCorruptOwnedStage(destinationFile, options) {
    const matches = path.basename(destinationFile) === "snapshot.sqlite" && path.basename(path.dirname(destinationFile)).startsWith(".p02-snapshot-");
    let forwarded = options;
    if (matches && typeof options?.progress === "function") {
      forwarded = { ...options, progress(info) {
        if (info.remainingPages === 0) metrics.finalProgressCallbacks += 1;
        return options.progress(info);
      } };
    }
    const transfer = Reflect.apply(originalBackup, this, [destinationFile, forwarded]);
    if (!matches) return transfer;
    metrics.calls += 1;
    return transfer.then((metadata) => {
      metrics.completedRealTransfers += 1;
      const staged = new BetterSQLite3(destinationFile);
      try {
        staged.pragma("ignore_check_constraints = ON");
        const update = staged.prepare("UPDATE event_observations SET source_sequence = ? WHERE event_id = ?")
          .run(9007199254740993n, "unsafe-staged-integer-1");
        metrics.injectedRows = update.changes;
        metrics.injectedValue = String(staged.prepare("SELECT CAST(source_sequence AS TEXT) AS value FROM event_observations WHERE event_id = ?")
          .get("unsafe-staged-integer-1").value);
      } finally { staged.close(); }
      return metadata;
    });
  };
  let caught;
  try {
    await backupAndMigrateEventStore({ databasePath, backupDirectory, backupName: "unsafe.sqlite" });
  } catch (error) { caught = error; }
  finally { BetterSQLite3.prototype.backup = originalBackup; }
  assert.ok(caught instanceof BackupMaintenanceError, "unsafe copied data must fail using the product error type");
  assert.equal(caught.code, "CORRUPT_DATABASE");
  assert.equal(caught.stage, "validate-backup");
  assert.equal(metrics.calls, 1);
  assert.equal(metrics.completedRealTransfers, 1, "the real online backup must finish before the staged row is changed");
  assert.equal(metrics.injectedRows, 1);
  assert.equal(metrics.injectedValue, "9007199254740993");
  const names = await readdir(backupDirectory);
  assert.equal(names.includes("unsafe.sqlite"), false, "an unsafe staged snapshot must not be published");
  const source = openEventStore({ path: databasePath, readOnly: true });
  try {
    const observations = source.readObservations();
    assert.equal(observations.items.length, 1);
    assert.equal(observations.items[0].sourceSequence, 1, "the source event remains safe and unchanged");
  } finally { await source.close(); }
  result.cases.push({ id: "unsafe_integer_rejected_during_backup_validation", status: "pass", code: caught.code, stage: caught.stage,
    metrics, finalBackupPublished: names.includes("unsafe.sqlite"), retainedPrivateStages: names.filter((name) => name.startsWith(".p02-snapshot-")).length,
    causeName: caught.cause?.name ?? null, causeMessage: caught.cause?.message ?? null });
}

function sha(value) { return createHash("sha256").update(value).digest("hex"); }
