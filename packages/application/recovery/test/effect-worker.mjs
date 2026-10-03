import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { executeOperationOnce } from "../../../../dist/packages/application/recovery/src/index.js";
import { openEventStore } from "../../../../dist/packages/storage/events/src/index.js";

const [, , databasePath, effectPath, markerPath, encodedExecution] = process.argv;
if (!databasePath || !effectPath || !markerPath || !encodedExecution) {
  throw new Error("usage: effect-worker.mjs <db> <effect-log> <marker> <execution-json>");
}

const store = openEventStore({ path: databasePath });
try {
  await executeOperationOnce(store, JSON.parse(encodedExecution), (intent) => {
    const effectFd = openSync(effectPath, "a");
    try {
      writeSync(effectFd, `${JSON.stringify(intent)}\n`);
      fsyncSync(effectFd);
    } finally {
      closeSync(effectFd);
    }

    const markerFd = openSync(markerPath, "wx");
    try {
      writeSync(markerFd, "effect-fsynced; receipt not returned\n");
      fsyncSync(markerFd);
    } finally {
      closeSync(markerFd);
    }

    // The parent hard-kills this owned worker at the durable-effect boundary.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    return { status: "success", result: { effect: "should-not-be-reached" } };
  });
} finally {
  await store.close();
}
