import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const hostRoot = "E:\\Xiadie\\Xiadie";
const nodeExecutable = path.join(hostRoot, ".runtime", "P01", "desktop-build-evidence", "toolchain", "node-v24.14.0-win-x64", "node.exe");
const nativeSourceRoot = path.join(hostRoot, ".runtime", "P01", "desktop-source");
const workerPath = path.join(testDirectory, "native.worker.mjs");
const scenarios = [
  ["success and fresh-root backup restore", "success-backup-restore"],
  ["actual Native tool failure", "tool-failure"],
  ["actual Native model route failure", "native-failure"],
  ["caller cancellation", "cancel"],
  ["in-flight close settles cancellation before writer close", "inflight-close"],
  ["actual SQLite writer BUSY does not become Saved", "writer-busy"],
  ["reopen recovers committed history without replay", "recovery"],
];

test("P02 U10 uses independent fixed-Node workers for actual Native integration", async (t) => {
  for (const [label, scenario] of scenarios) {
    await t.test(label, async () => {
      const result = await runWorker(scenario);
      assert.equal(result.exitCode, 0,
        `Native worker scenario ${scenario} failed (exit=${result.exitCode}, timedOut=${result.timedOut}).\n${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.includes("# pass 1") || result.stdout.includes("ℹ pass 1"),
        `Native worker scenario ${scenario} did not report its single test as passed.\n${result.stdout}`);
      for (const line of result.stdout.split("\n")) {
        if (line.startsWith("P02_NATIVE_RESULT ") || line.startsWith("P02_NATIVE_HOOK_PROCESS ")) process.stdout.write(`${line}\n`);
      }
    });
  }
});

async function runWorker(scenario) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.P02_U10_SCENARIO = scenario;
  env.P01_U06_ZCODE_SOURCE = nativeSourceRoot;

  const child = spawn(nodeExecutable, ["--test", workerPath], {
    cwd: repositoryRoot,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killOwnedTree(child);
  }, 60_000);
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (exit.error !== undefined) {
    return { exitCode: 1, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: exit.error.message };
  }
  return {
    exitCode: exit.code ?? 1,
    timedOut,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function killOwnedTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", resolve);
    killer.once("close", resolve);
  });
}
