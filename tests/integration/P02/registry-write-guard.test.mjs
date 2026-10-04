import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  installDefaultProtocolClientGuard,
  installRegistryWriteGuard,
  writeMainProcessSnapshot,
} = require("./registry-write-guard.cjs");

function removeOwnedTemp(root) {
  const tempRoot = realpathSync(os.tmpdir());
  const resolvedRoot = realpathSync(root);
  const relative = path.relative(tempRoot, resolvedRoot);
  assert.equal(path.basename(root).startsWith("p02-registry-guard-"), true);
  assert.equal(path.resolve(root).toLowerCase(), resolvedRoot.toLowerCase());
  assert.equal(lstatSync(root).isSymbolicLink(), false);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
}

test("blocks every reg.exe spawn, records its exact argv, and leaves other executables alone", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "p02-registry-guard-"));
  const logPath = path.join(root, "guard.jsonl");
  const spawnCalls = [];
  const childProcess = {
    spawn(...args) {
      spawnCalls.push(args);
      return { allowed: true };
    },
  };
  const processInfo = { pid: 4123, type: "browser", cwd: () => root };
  const env = { P02_REGISTRY_GUARD_LOG: logPath };
  const restore = installRegistryWriteGuard({ childProcess, env, processInfo });
  try {
    const requests = [
      ["reg.exe", ["add", "HKCU\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode", "/f"]],
      ["C:\\Windows\\System32\\REG.EXE", ["QUERY", "HKCU\\Software\\Classes"]],
    ];
    for (const [command, args] of requests) {
      assert.throws(() => childProcess.spawn(command, args, { cwd: root }), (error) =>
        error.code === "P02_REGISTRY_WRITE_BLOCKED" && error.p02RegistryWriteBlocked === true);
    }
    assert.equal(spawnCalls.length, 0, "blocked registry calls must never reach the original spawn");

    const options = { cwd: root, windowsHide: true };
    const allowed = childProcess.spawn("powershell.exe", ["-NoProfile", "-Command", "Get-Location"], options);
    assert.deepEqual(allowed, { allowed: true });
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0], ["powershell.exe", ["-NoProfile", "-Command", "Get-Location"], options]);

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    for (let index = 0; index < requests.length; index += 1) {
      const [command, args] = requests[index];
      const expectedArgv = [command, ...args];
      assert.equal(records[index].schemaVersion, 1);
      assert.equal(records[index].kind, "blocked_reg_exe");
      assert.equal(records[index].pid, 4123);
      assert.equal(records[index].processType, "browser");
      assert.deepEqual(records[index].rawArgv, expectedArgv);
      assert.equal(records[index].rawArgvSha256,
        createHash("sha256").update(JSON.stringify(expectedArgv), "utf8").digest("hex"));
    }
  } finally {
    restore();
    removeOwnedTemp(root);
  }
});

test("fails closed if the owned guard log path is absent or relative", () => {
  const childProcess = { spawn() { throw new Error("must not be called"); } };
  assert.throws(() => installRegistryWriteGuard({ childProcess, env: {}, processInfo: process }),
    /P02_REGISTRY_GUARD_LOG must be an absolute path/);
  assert.throws(() => installRegistryWriteGuard({
    childProcess,
    env: { P02_REGISTRY_GUARD_LOG: "relative\\guard.jsonl" },
    processInfo: process,
  }), /P02_REGISTRY_GUARD_LOG must be an absolute path/);
});

test("pins the actual Electron main PID, cwd, executable, and argv for protocol argument validation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "p02-registry-guard-"));
  try {
    const snapshotPath = path.join(root, "main-process-runtime.json");
    const argv = [process.execPath, "--inspect=0", "C:\\candidate\\packages\\desktop\\dist\\main.js"];
    const processInfo = {
      pid: 4125,
      type: "browser",
      cwd: () => root,
      execPath: process.execPath,
      defaultApp: true,
      argv,
    };
    const snapshot = writeMainProcessSnapshot({
      env: { P02_MAIN_PROCESS_SNAPSHOT: snapshotPath },
      processInfo,
    });
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), snapshot);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.pid, 4125);
    assert.equal(snapshot.processType, "browser");
    assert.equal(snapshot.cwd, root);
    assert.equal(snapshot.execPath, process.execPath);
    assert.equal(snapshot.defaultApp, true);
    assert.deepEqual(snapshot.argv, argv);
    assert.equal(snapshot.argvSha256, createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex"));
    assert.equal(snapshot.argvEntry, "--inspect=0");
    assert.equal(snapshot.resolvedArgvEntry, path.resolve(root, "--inspect=0"));
  } finally {
    removeOwnedTemp(root);
  }
});

test("blocks Electron protocol changes and recent-document clearing without calling the native APIs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "p02-registry-guard-"));
  const logPath = path.join(root, "guard.jsonl");
  const calls = [];
  const app = {
    setAsDefaultProtocolClient(...args) { calls.push(["set", ...args]); return true; },
    removeAsDefaultProtocolClient(...args) { calls.push(["remove", ...args]); return true; },
    clearRecentDocuments(...args) { calls.push(["clear", ...args]); },
  };
  const processInfo = { pid: 4124, type: "browser", cwd: () => root };
  const env = { P02_REGISTRY_GUARD_LOG: logPath };
  const restore = installDefaultProtocolClientGuard({ app, env, processInfo });
  try {
    assert.equal(app.setAsDefaultProtocolClient("zcode", "C:\\owned\\electron.exe", ["C:\\owned\\zcode.cjs"]), false);
    assert.equal(app.removeAsDefaultProtocolClient("zcode"), false);
    assert.equal(app.clearRecentDocuments(), undefined);
    assert.deepEqual(calls, [], "native Electron side-effect APIs must never be called");

    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.kind), [
      "blocked_default_protocol_registration",
      "blocked_default_protocol_removal",
      "blocked_clear_recent_documents",
    ]);
    assert.deepEqual(records.map((record) => record.code), [
      "P02_DEFAULT_PROTOCOL_REGISTRATION_BLOCKED",
      "P02_DEFAULT_PROTOCOL_REMOVAL_BLOCKED",
      "P02_CLEAR_RECENT_DOCUMENTS_BLOCKED",
    ]);
    const expectedArgs = [
      ["zcode", "C:\\owned\\electron.exe", ["C:\\owned\\zcode.cjs"]],
      ["zcode"],
      [],
    ];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.pid, 4124);
      assert.equal(record.processType, "browser");
      assert.equal(record.blocked, true);
      assert.deepEqual(record.rawArgs, expectedArgs[index]);
      assert.equal(record.rawArgsSha256,
        createHash("sha256").update(JSON.stringify(expectedArgs[index]), "utf8").digest("hex"));
    }
    assert.deepEqual(records[0].expectedRegistrySubkeys, [
      "Software\\Classes\\zcode",
      "Software\\Classes\\zcode\\DefaultIcon",
      "Software\\Classes\\zcode\\shell",
      "Software\\Classes\\zcode\\shell\\open",
      "Software\\Classes\\zcode\\shell\\open\\command",
    ]);
    assert.equal(records[2].returnValue, null, "undefined return is represented as null in JSON evidence");
  } finally {
    restore();
    removeOwnedTemp(root);
  }
});

test("the Electron preload's ESM spawn binding sees the typed block before OS process creation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "p02-registry-guard-"));
  try {
    const logPath = path.join(root, "guard.jsonl");
    const fakeExe = path.join(root, "no-such-tool", "reg.exe");
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "registry-write-guard.cjs");
    const childSource = `
      import { spawn } from "node:child_process";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const require = createRequire(import.meta.url);
      const { installRegistryWriteGuard } = require(${JSON.stringify(modulePath)});
      installRegistryWriteGuard({ env: process.env, processInfo: process });
      syncBuiltinESMExports();
      try {
        spawn(${JSON.stringify(fakeExe)}, ["query", "HKCU\\\\Software\\\\Classes"]);
        process.stdout.write(JSON.stringify({ code: "spawn_returned" }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, marker: error.p02RegistryWriteBlocked === true }));
      }
    `;
    const systemRoot = process.env.SYSTEMROOT || "C:\\Windows";
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource], {
      encoding: "utf8",
      env: { SYSTEMROOT: systemRoot, WINDIR: process.env.WINDIR || systemRoot, P02_REGISTRY_GUARD_LOG: logPath },
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { code: "P02_REGISTRY_WRITE_BLOCKED", marker: true });
    const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].rawArgv[0], fakeExe);
    assert.equal(records[0].kind, "blocked_reg_exe");
  } finally {
    removeOwnedTemp(root);
  }
});
