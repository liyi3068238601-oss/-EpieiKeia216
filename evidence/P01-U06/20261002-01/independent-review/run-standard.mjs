import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const reviewRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(process.argv[3]);
const logsRoot = path.join(reviewRoot, "logs");
mkdirSync(logsRoot, { recursive: true });

const toolchainRoot = "E:\\Xiadie\\Xiadie\\.runtime\\P01\\desktop-build-evidence";
const nodeDir = path.join(toolchainRoot, "toolchain", "node-v24.14.0-win-x64");
const nodeExe = path.join(nodeDir, "node.exe");
const pnpmCmd = path.join(toolchainRoot, "bin", "pnpm.CMD");
const storeDir = "E:\\Xiadie\\Xiadie\\.runtime\\P01\\pnpm-store-u04";
const env = {
  ...process.env,
  PATH: [path.join(toolchainRoot, "bin"), nodeDir, process.env.PATH ?? ""].join(";"),
  COREPACK_ENABLE_NETWORK: "0",
};

const commands = [
  {
    id: "frozen-install",
    runner: "pnpm",
    argv: ["install", "--frozen-lockfile", "--ignore-scripts", "--offline", "--store-dir", storeDir],
  },
  { id: "check", runner: "pnpm", argv: ["run", "check"] },
  { id: "build", runner: "pnpm", argv: ["run", "build"] },
  { id: "unit-u06", runner: "node", argv: ["tools/run-tests.mjs", "unit", "P01-U06"] },
  { id: "contract-u06", runner: "node", argv: ["tools/run-tests.mjs", "contract", "P01-U06"] },
  { id: "integration-u06", runner: "node", argv: ["tools/run-tests.mjs", "integration", "P01-U06"] },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const summarize = [];
let blocked = false;
for (const item of commands) {
  const cmd = item.runner === "pnpm" ? pnpmCmd : nodeExe;
  const start = new Date().toISOString();
  const result = spawnSync(cmd, item.argv, {
    cwd: projectRoot,
    env,
    shell: item.runner === "pnpm",
    encoding: null,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const end = new Date().toISOString();
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  const stdoutName = item.id + ".stdout.log";
  const stderrName = item.id + ".stderr.log";
  writeFileSync(path.join(logsRoot, stdoutName), stdout);
  writeFileSync(path.join(logsRoot, stderrName), stderr);
  const execution = {
    schema: "p01-review-command/v1",
    id: item.id,
    startedAtUtc: start,
    completedAtUtc: end,
    command: item.runner === "pnpm" ? "pnpm" : "node",
    executable: cmd,
    argv: item.argv,
    cwd: projectRoot,
    launcher: item.runner === "pnpm" ? "Node spawn with shell=true for Windows .CMD" : "direct node.exe process",
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    spawnError: result.error?.message ?? null,
    environmentOverrides: {
      COREPACK_ENABLE_NETWORK: "0",
      pathPrefix: [path.join(toolchainRoot, "bin"), nodeDir],
    },
    stdout: { path: stdoutName, bytes: stdout.byteLength, sha256: sha256(stdout) },
    stderr: { path: stderrName, bytes: stderr.byteLength, sha256: sha256(stderr) },
  };
  writeFileSync(path.join(logsRoot, item.id + ".execution.json"), JSON.stringify(execution, null, 2) + "\n", "utf8");
  summarize.push({ id: item.id, exitCode: execution.exitCode, stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength, spawnError: execution.spawnError });
  process.stdout.write(item.id + ": exit=" + (execution.exitCode ?? "null") + " stdout=" + stdout.byteLength + " stderr=" + stderr.byteLength + (execution.spawnError ? " error=" + execution.spawnError : "") + "\n");
  if (execution.exitCode !== 0) {
    blocked = true;
    break;
  }
}
writeFileSync(path.join(reviewRoot, "standard-run-summary.json"), JSON.stringify(summarize, null, 2) + "\n", "utf8");
if (blocked) process.exitCode = 1;
