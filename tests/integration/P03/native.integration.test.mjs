import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const hostRoot = "E:\\Xiadie\\Xiadie";
const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments");
const nodeExecutable = path.join(hostRoot, ".runtime", "P01", "desktop-build-evidence", "toolchain", "node-v24.14.0-win-x64", "node.exe");
const nativeSourceRoot = path.join(hostRoot, ".runtime", "P01", "desktop-source");
const workerPath = path.join(testDirectory, "native.worker.mjs");

const scenarios = [
  ["same-hash Reads in two turns do not collapse to stale cache", "same-hash-cache"],
  ["same-length same-mtime stat/range race fails closed and next turn recovers", "stat-range-race-recovery"],
  ["Native Hook nonzero exit blocks memory Read", "hook-nonzero"],
  ["Native Hook malformed JSON blocks memory Read", "hook-bad-json"],
  ["Native Hook without receipt blocks memory Read", "hook-missing-receipt"],
  ["Native Hook timeout blocks memory Read", "hook-timeout"],
  ["cancel revokes old receipt and fresh/reopened turns recover", "cancel-recovery"],
  ["foreign and unselected memory paths fail closed", "path-denials"],
];

test("P03 U09 composes the accepted Host seam with pinned Native in isolated workers", async (t) => {
  const experimentPhysicalRoot = await assertPhysicalDirectory(experimentRoot);
  for (const [label, scenario] of scenarios) {
    await t.test(label, async () => {
      const fixtureRoot = path.join(experimentRoot, `u09-native-${randomUUID()}`);
      const profile = path.join(fixtureRoot, "profile");
      await mkdir(fixtureRoot, { recursive: false });
      const fixturePhysicalRoot = await assertPhysicalDirectory(fixtureRoot, experimentPhysicalRoot);
      await mkdir(profile, { recursive: false });
      const home = path.join(fixtureRoot, "profile", "home");
      const temp = path.join(fixtureRoot, "profile", "temp");
      await mkdir(home, { recursive: false });
      await mkdir(temp, { recursive: false });
      const profileReal = await assertPhysicalDirectory(profile, fixturePhysicalRoot);
      await assertPhysicalDirectory(home, profileReal);
      await assertPhysicalDirectory(temp, profileReal);
      const result = await runWorker(scenario, { fixtureRoot, home, temp });
      assert.equal(result.exitCode, 0,
        `Pinned Native scenario ${scenario} failed (exit=${result.exitCode}, timedOut=${result.timedOut}).\n${result.stdout}\n${result.stderr}`);
      assert.equal(result.timedOut, false, `Pinned Native scenario ${scenario} exceeded its owned-worker deadline`);

      const resultLine = result.stdout.split(/\r?\n/).find((line) => line.includes("P03_U09_NATIVE_RESULT "));
      assert.ok(resultLine, `scenario ${scenario} did not emit machine-readable runtime metrics.\n${result.stdout}`);
      const markerIndex = resultLine.indexOf("P03_U09_NATIVE_RESULT ");
      const metrics = JSON.parse(resultLine.slice(markerIndex + "P03_U09_NATIVE_RESULT ".length));
      assert.equal(metrics.scenario, scenario);
      assert.equal(metrics.nativeCommit, "29628c9acdb81b703bbd4080c207a0e7ce5e276e");
      assert.equal(metrics.runtime, "pinned-native-24.14.0");
      assert.equal(metrics.provider, "local-loopback-mock");
      assert.equal(metrics.listener?.address, "127.0.0.1");
      assert.equal(metrics.listener?.checkedBeforeNative, true);
      assert.equal(metrics.listener?.portPreviouslyUnoccupied, true);
      assert.equal(metrics.listener?.priorListenerCountOnPort, 0);
      assert.equal(metrics.nonLoopbackRequests, 0);
      assert.equal(metrics.fixtureRetained, true);
      assert.equal(metrics.listenerSnapshot?.file, "listeners-before.json");
      assert.match(metrics.listenerSnapshot?.sha256 ?? "", /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(metrics.listenerSnapshot?.entryCount));
      t.diagnostic(JSON.stringify(metrics));
    });
  }
});

async function runWorker(scenario, fixture) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  env.P03_U09_SCENARIO = scenario;
  env.P03_U09_FIXTURE_ROOT = fixture.fixtureRoot;
  env.P01_U06_ZCODE_SOURCE = nativeSourceRoot;
  env.HOME = fixture.home;
  env.USERPROFILE = fixture.home;
  env.TEMP = fixture.temp;
  env.TMP = fixture.temp;

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
  }, 90_000);
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
    signal: exit.signal,
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

async function assertPhysicalDirectory(directory, containmentRoot) {
  const resolved = path.resolve(directory);
  const details = await lstat(resolved);
  assert.ok(details.isDirectory() && !details.isSymbolicLink(), `${resolved} must be a physical directory, not a link or junction`);
  const physical = path.resolve(await realpath(resolved));
  assert.equal(pathKey(physical), pathKey(resolved), `${resolved} resolves through a link, junction, or alias`);
  if (containmentRoot !== undefined) {
    assert.ok(isWithin(containmentRoot, physical), `${physical} escaped owned root ${containmentRoot}`);
  }
  return physical;
}

function isWithin(root, candidate) {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
