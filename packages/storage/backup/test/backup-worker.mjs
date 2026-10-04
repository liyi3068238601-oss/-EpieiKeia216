import assert from "node:assert/strict";
import { openSync, closeSync, fsyncSync, lstatSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import BetterSQLite3 from "better-sqlite3";
import path from "node:path";

const { backupAndMigrateEventStore } = await import(
  new URL("../../../../dist/packages/storage/backup/src/index.js", import.meta.url).href,
);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function physicalDirectory(target, root, label) {
  const info = lstatSync(target);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a physical directory`);
  const physical = await realpath(target);
  assert.ok(inside(root, physical), `${label} must remain inside the owned fixture`);
  return physical;
}

async function validateSpec() {
  assert.equal(process.argv.length, 3, "worker accepts exactly one fixture specification");
  const spec = JSON.parse(process.argv[2]);
  assert.deepEqual(Object.keys(spec).sort(), [
    "backupDirectory", "backupName", "databasePath", "markerPath", "ownedRoot", "phase",
  ]);
  assert.ok(spec.phase === "before" || spec.phase === "after");
  for (const key of ["ownedRoot", "backupDirectory", "databasePath", "markerPath"]) {
    assert.equal(typeof spec[key], "string");
    assert.ok(path.isAbsolute(spec[key]), `${key} must be absolute`);
    assert.equal(path.resolve(spec[key]), spec[key], `${key} must be normalized`);
  }
  assert.equal(typeof spec.backupName, "string");
  assert.match(spec.backupName, /^[A-Za-z0-9._-]+$/);
  assert.ok(spec.backupName !== "." && spec.backupName !== "..");

  const root = await realpath(spec.ownedRoot);
  const databaseInfo = lstatSync(spec.databasePath);
  assert.ok(databaseInfo.isFile() && !databaseInfo.isSymbolicLink(), "database must be an owned regular file");
  const databaseParent = await physicalDirectory(path.dirname(spec.databasePath), root, "database parent");
  const backupDirectory = await physicalDirectory(spec.backupDirectory, root, "backup directory");
  const markerParent = await physicalDirectory(path.dirname(spec.markerPath), root, "marker parent");
  assert.ok(inside(root, databaseParent) && inside(root, backupDirectory) && inside(root, markerParent));
  assert.ok(path.join(backupDirectory, spec.backupName).startsWith(`${backupDirectory}${path.sep}`));
  assert.throws(() => lstatSync(spec.markerPath), { code: "ENOENT" }, "marker must be new");
  return spec;
}

function writeDurableMarker(spec) {
  const descriptor = openSync(spec.markerPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify({ phase: spec.phase, pid: process.pid })}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pauseForParent() {
  const result = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25_000);
  assert.equal(result, "timed-out", "parent must terminate the worker after its durable marker");
  throw new Error("parent did not terminate the owned worker before the bounded pause expired");
}

async function main() {
  const spec = await validateSpec();
  const prototype = BetterSQLite3.prototype;
  const originalExec = prototype.exec;
  let intercepted = false;
  prototype.exec = function pauseAtMigrationCommit(sql, ...args) {
    const isCommit = String(sql).trim().toUpperCase() === "COMMIT";
    if (isCommit && !intercepted && spec.phase === "before") {
      intercepted = true;
      writeDurableMarker(spec);
      pauseForParent();
    }
    const result = originalExec.call(this, sql, ...args);
    if (isCommit && !intercepted && spec.phase === "after") {
      intercepted = true;
      writeDurableMarker(spec);
      pauseForParent();
    }
    return result;
  };

  try {
    await backupAndMigrateEventStore({
      databasePath: spec.databasePath,
      backupDirectory: spec.backupDirectory,
      backupName: spec.backupName,
    });
    if (!intercepted) throw new Error("migration COMMIT boundary was not observed");
  } catch (error) {
    const record = {
      name: error instanceof Error ? error.name : "unknown",
      code: error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : null,
      stage: error !== null && typeof error === "object" && typeof error.stage === "string" ? error.stage : null,
    };
    process.stderr.write(`${JSON.stringify(record)}\n`);
    process.exitCode = 1;
  } finally {
    prototype.exec = originalExec;
  }
}

await main();
