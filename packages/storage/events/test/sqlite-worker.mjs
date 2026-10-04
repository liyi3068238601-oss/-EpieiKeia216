import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { openEventStore } from "../../../../dist/packages/storage/events/src/index.js";

const [, , databasePath, phase, markerPath, encodedInput] = process.argv;
if (!databasePath || !["before-commit", "after-commit", "after-duplicate-commit"].includes(phase) || !markerPath || !encodedInput) {
  throw new Error("usage: sqlite-worker.mjs <db> <before-commit|after-commit|after-duplicate-commit> <marker> <input-json>");
}

const store = openEventStore({ path: databasePath });
const prototype = Database.prototype;
const originalExec = prototype.exec;
prototype.exec = function patchedExec(sql) {
  if (String(sql).trim().toUpperCase() === "COMMIT") {
    const admission = currentAdmission;
    const marker = JSON.stringify({ phase, observationKey: admission.observationKey });
    if (phase !== "before-commit") originalExec.call(this, sql);
    writeFileSync(markerPath, marker, { flag: "wx" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    if (phase === "before-commit") return;
    return;
  }
  return originalExec.call(this, sql);
};

let currentAdmission;
try {
  currentAdmission = store.append(JSON.parse(encodedInput));
  if (currentAdmission.status !== "queued") throw new Error(`append rejected: ${currentAdmission.status}`);
  await currentAdmission.completion;
} finally {
  try { prototype.exec = originalExec; } catch { /* Child is normally hard-killed at the test barrier. */ }
  await store.close();
}
