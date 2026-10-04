import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const probeLoadsKey = Symbol.for("xiadie.p02.better-sqlite3-loads");
const observedLoads = [];
const originalDlopen = process.dlopen;
Object.defineProperty(globalThis, probeLoadsKey, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: observedLoads,
});
const realpathNative = (await import("node:fs")).realpathSync.native;
process.dlopen = function p02ObserveDlopen(module, filename, ...flags) {
  const result = Reflect.apply(originalDlopen, process, [module, filename, ...flags]);
  if (typeof filename === "string" && /[\\/]better-sqlite3[\\/]prebuilds[\\/]win32-x64\.node$/i.test(filename)) {
    observedLoads.push({ path: realpathNative(filename), pid: process.pid });
  }
  return result;
};

let writeSqliteRuntimeProbe;
try {
  const { default: Database } = await import("better-sqlite3");
  const bindingProbe = new Database(":memory:");
  bindingProbe.close();
  ({ writeSqliteRuntimeProbe } = await import(pathToFileURL(path.join(testDirectory, "durable-host.mjs")).href));
} finally {
  process.dlopen = originalDlopen;
}

function removeOwnedTemp(root) {
  const tempRoot = realpathSync(os.tmpdir());
  const resolvedRoot = realpathSync(root);
  const relative = path.relative(tempRoot, resolvedRoot);
  assert.equal(path.basename(root).startsWith("p02-sqlite-probe-"), true);
  assert.equal(path.resolve(root).toLowerCase(), resolvedRoot.toLowerCase());
  assert.equal(lstatSync(root).isSymbolicLink(), false);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
}

test("runtime probe permits only byte-identical repeats for the same observed addon binding", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "p02-sqlite-probe-"));
  const probeDirectory = path.join(root, "sqlite-runtime-probes");
  mkdirSync(probeDirectory);
  const probePath = path.join(probeDirectory, `${process.pid}.json`);
  const linkedProbeTarget = path.join(root, "linked-probe-target");
  const previousProbeDirectory = process.env.P02_SQLITE_RUNTIME_PROBE_DIR;
  process.env.P02_SQLITE_RUNTIME_PROBE_DIR = probeDirectory;

  try {
    assert.equal(observedLoads.length, 1, "the test must observe the actual better-sqlite3 addon load");
    assert.equal(observedLoads[0].pid, process.pid);
    writeSqliteRuntimeProbe(root);
    const firstBytes = readFileSync(probePath);
    const firstHash = createHash("sha256").update(firstBytes).digest("hex");
    const firstMtimeNs = statSync(probePath, { bigint: true }).mtimeNs;

    writeSqliteRuntimeProbe(root);
    const repeatedBytes = readFileSync(probePath);
    assert.deepEqual(repeatedBytes, firstBytes);
    assert.equal(createHash("sha256").update(repeatedBytes).digest("hex"), firstHash);
    assert.equal(statSync(probePath, { bigint: true }).mtimeNs, firstMtimeNs);

    const conflictingBytes = Buffer.from("{\"conflicting\":true}\n", "utf8");
    writeFileSync(probePath, conflictingBytes);
    assert.throws(() => writeSqliteRuntimeProbe(root), /SQLITE_RUNTIME_PROBE_CONFLICT/);
    assert.deepEqual(readFileSync(probePath), conflictingBytes);

    unlinkSync(probePath);
    rmSync(probeDirectory, { recursive: true });
    mkdirSync(linkedProbeTarget);
    symlinkSync(linkedProbeTarget, probeDirectory, "junction");
    assert.equal(lstatSync(probeDirectory).isSymbolicLink(), true);
    assert.throws(() => writeSqliteRuntimeProbe(root), /SQLITE_RUNTIME_PROBE_PATH_INVALID/);
    assert.equal(existsSync(path.join(linkedProbeTarget, `${process.pid}.json`)), false);
  } finally {
    if (previousProbeDirectory === undefined) delete process.env.P02_SQLITE_RUNTIME_PROBE_DIR;
    else process.env.P02_SQLITE_RUNTIME_PROBE_DIR = previousProbeDirectory;
    removeOwnedTemp(root);
  }
});
