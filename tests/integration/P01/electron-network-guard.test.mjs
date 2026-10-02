import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../../../../../");
const guardPath = path.join(testDirectory, "electron-network-guard.cjs");
const nodePath = path.join(
  repositoryRoot,
  ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe",
);

function safeCleanup(root) {
  const tempRoot = realpathSync(os.tmpdir());
  const resolvedRoot = realpathSync(root);
  const relative = path.relative(tempRoot, resolvedRoot);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(resolvedRoot) !== tempRoot ||
    !path.basename(resolvedRoot).startsWith("p01-u10-guard-") ||
    lstatSync(root).isSymbolicLink()
  ) {
    throw new Error("unsafe_test_temp_cleanup_target");
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}

test("Electron guard permits only configured loopback and handles normalized Socket.connect args", async (t) => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "p01-u10-guard-"));
  t.after(() => safeCleanup(tempRoot));
  const logPath = path.join(tempRoot, "guard.jsonl");
  const ipcPrefix = `\\\\.\\pipe\\p01-u10-${randomUUID()}-`;

  const httpServer = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("loopback-ok");
  });
  httpServer.on("connection", (socket) => socket.on("error", () => {}));
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const httpPort = httpServer.address().port;
  t.after(() => httpServer.close());

  const tcpServer = createNetServer((socket) => {
    socket.on("error", () => {});
    socket.end("tcp-ok");
  });
  await new Promise((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const tcpPort = tcpServer.address().port;
  t.after(() => tcpServer.close());

  const script = String.raw`
    const assert = require('node:assert/strict');
    const net = require('node:net');
    (async () => {
      const response = await fetch(process.env.P01_TEST_URL);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'loopback-ok');
      process.stdout.write('fetch-ok ');

      const socket = net.createConnection({host:'127.0.0.1', port:Number(process.env.P01_TEST_TCP_PORT)});
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      await new Promise((resolve, reject) => { socket.once('end', resolve); socket.once('error', reject); });
      assert.equal(Buffer.concat(chunks).toString(), 'tcp-ok');
      process.stdout.write('socket-ok ');

      await assert.rejects(fetch('https://example.invalid'), error => error.code === 'P01_EGRESS_DENIED');
      let lookupCalled = false;
      const lookupSocket = new net.Socket();
      assert.throws(() => lookupSocket.connect({host:'127.0.0.1', port:Number(process.env.P01_TEST_TCP_PORT),
        lookup(){ lookupCalled = true; }}), error => error.code === 'P01_EGRESS_DENIED');
      assert.equal(lookupCalled, false);
      process.stdout.write('lookup-denied ');

      const unknownSocket = new net.Socket();
      assert.throws(() => unknownSocket.connect([{host:'localhost', port:Number(process.env.P01_TEST_TCP_PORT)}, null]),
        error => error.code === 'P01_EGRESS_DENIED');
      const deniedPipe = new net.Socket();
      assert.throws(() => deniedPipe.connect({path:'\\\\.\\pipe\\foreign-process-channel'}),
        error => error.code === 'P01_EGRESS_DENIED');
      process.stdout.write('pipe-denied ');
      process.stdout.write('guard-contract-ok');
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const safeSystemKeys = ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"];
  const env = Object.fromEntries(safeSystemKeys
    .filter((key) => typeof process.env[key] === "string")
    .map((key) => [key, process.env[key]]));
  Object.assign(env, {
    P01_ALLOWED_HTTP_ORIGINS: JSON.stringify([
      `http://127.0.0.1:${httpPort}`,
      `http://127.0.0.1:${tcpPort}`,
    ]),
    P01_GUARD_LOG: logPath,
    P01_TEST_URL: `http://127.0.0.1:${httpPort}/probe`,
    P01_TEST_TCP_PORT: String(tcpPort),
    P01_ALLOWED_IPC_PIPE_PREFIX: ipcPrefix,
    P01_TEST_IPC_PREFIX: ipcPrefix,
  });
  const child = spawn(nodePath, ["-r", guardPath, "-e", script], {
    cwd: repositoryRoot,
    env,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill(), 8_000);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 0, `${JSON.stringify(result)}\n${stderr}\n${stdout}`);
  assert.match(stdout, /guard-contract-ok/);
  const records = readFileSync(logPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(records.some((record) => record.kind === "request" && record.allowed === true));
  assert.ok(records.some((record) => record.kind === "request" && record.allowed === false));
  assert.ok(records.some((record) => record.kind === "socket" && record.allowed === true));
  assert.ok(records.some((record) => record.kind === "socket" && record.allowed === false));
  assert.ok(records.some((record) => record.kind === "egress_canary_denied"));
});

test("Electron guard injects CLI instrumentation only for the pinned candidate command", async (t) => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "p01-u10-guard-"));
  t.after(() => safeCleanup(tempRoot));
  const logPath = path.join(tempRoot, "guard.jsonl");
  const cliPath = path.join(tempRoot, "candidate-cli.cjs");
  const otherPath = path.join(tempRoot, "other-cli.cjs");
  const ipcPrefix = `\\\\.\\pipe\\p01-u10-${randomUUID()}-`;
  writeFileSync(cliPath, "process.stdout.write(JSON.stringify({guarded:globalThis.__p01Guard===true,pid:process.pid,args:process.argv.slice(2),nodeOptions:process.env.NODE_OPTIONS??null}));\n", "utf8");
  writeFileSync(otherPath, "process.stdout.write(JSON.stringify({guarded:globalThis.__p01Guard===true,nodeOptions:process.env.NODE_OPTIONS??null}));\n", "utf8");

  const helper = String.raw`
    const assert = require('node:assert/strict');
    const { spawn } = require('node:child_process');
    const safeKeys = ['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'];
    const base = Object.fromEntries(safeKeys.filter(k => process.env[k]).map(k => [k, process.env[k]]));
    for (const key of ['P01_GUARD_LOG','P01_GUARD_PROCESS_ROLE','P01_GUARD_CLI_ENTRY',
      'P01_GUARD_CLI_ENTRY_SHA256','P01_GUARD_ELECTRON_EXE','P01_GUARD_WRAPPERS',
      'P01_ALLOWED_HTTP_ORIGINS','P01_ALLOWED_IPC_PIPE_PREFIX']) base[key] = process.env[key];
    async function run(args) {
      const child = spawn(process.env.P01_TEST_NODE_PATH, args, {
        env: {...base, ELECTRON_RUN_AS_NODE:'1'}, stdio:['ignore','pipe','pipe'], windowsHide:true,
      });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', part => stdout += part);
      child.stderr.setEncoding('utf8').on('data', part => stderr += part);
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('spawn_probe_timeout')); }, 8000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({code,signal,stdout,stderr}); });
      });
      assert.equal(result.code, 0, JSON.stringify(result));
      return JSON.parse(result.stdout);
    }
    (async () => {
      const guarded = await run([process.env.P01_GUARD_CLI_ENTRY, 'app-server', '--stdio']);
      assert.equal(guarded.guarded, true);
      assert.deepEqual(guarded.args, ['app-server', '--stdio']);
      assert.equal(guarded.nodeOptions, null);
      const unmodified = await run([process.env.P01_TEST_OTHER_ENTRY]);
      assert.equal(unmodified.guarded, false);
      assert.equal(unmodified.nodeOptions, null);
      process.stdout.write(JSON.stringify({guarded,unmodified}));
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const safeSystemKeys = ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"];
  const env = Object.fromEntries(safeSystemKeys
    .filter((key) => typeof process.env[key] === "string")
    .map((key) => [key, process.env[key]]));
  Object.assign(env, {
    P01_GUARD_LOG: logPath,
    P01_GUARD_PROCESS_ROLE: "utility",
    P01_GUARD_CLI_ENTRY: cliPath,
    P01_GUARD_CLI_ENTRY_SHA256: createHash("sha256").update(readFileSync(cliPath)).digest("hex"),
    P01_GUARD_ELECTRON_EXE: nodePath,
    P01_GUARD_WRAPPERS: path.join(tempRoot, "wrappers"),
    P01_ALLOWED_HTTP_ORIGINS: JSON.stringify(["http://127.0.0.1:1"]),
    P01_ALLOWED_IPC_PIPE_PREFIX: ipcPrefix,
    P01_TEST_NODE_PATH: nodePath,
    P01_TEST_OTHER_ENTRY: otherPath,
  });
  delete env.NODE_OPTIONS;
  const child = spawn(nodePath, ["-r", guardPath, "-e", helper], {
    cwd: repositoryRoot,
    env,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => child.kill(), 12_000);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  assert.equal(result.code, 0, `${JSON.stringify(result)}\n${stderr}\n${stdout}`);
  const output = JSON.parse(stdout);
  assert.equal(output.guarded.guarded, true);
  assert.deepEqual(output.guarded.args, ["app-server", "--stdio"]);
  assert.equal(output.guarded.nodeOptions, null);
  assert.equal(output.unmodified.guarded, false);
  assert.equal(output.unmodified.nodeOptions, null);
  const records = readFileSync(logPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const injected = records.filter((record) => record.kind === "cli_spawn_injected");
  assert.equal(injected.length, 1);
  const cliPid = output.guarded.pid;
  assert.equal(injected[0].child_pid, cliPid);
  assert.ok(records.some((record) => record.pid === cliPid && record.process_role === "cli" &&
    record.kind === "guard_loaded" && record.cli_entry_sha256 === env.P01_GUARD_CLI_ENTRY_SHA256));
  assert.ok(records.some((record) => record.pid === cliPid && record.process_role === "cli" &&
    record.kind === "egress_canary_denied"));
});
