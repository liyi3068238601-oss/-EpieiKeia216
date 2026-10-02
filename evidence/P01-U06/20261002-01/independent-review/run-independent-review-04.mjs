import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.argv[2]);
const reviewRoot = path.resolve(process.argv[3]);
const probeScript = path.join(reviewRoot, "independent-review-04.mjs");
const nodeDir = "E:\\Xiadie\\Xiadie\\.runtime\\P01\\desktop-build-evidence\\toolchain\\node-v24.14.0-win-x64";
const nodeExe = path.join(nodeDir, "node.exe");
const env = { ...process.env, PATH: [nodeDir, process.env.PATH ?? ""].join(";"), COREPACK_ENABLE_NETWORK: "0" };
const startedAtUtc = new Date().toISOString();
const result = spawnSync(nodeExe, [probeScript, projectRoot, reviewRoot], {
  cwd: projectRoot,
  env,
  encoding: null,
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024,
});
const completedAtUtc = new Date().toISOString();
const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
writeFileSync(path.join(reviewRoot, "independent-review-04.stdout.log"), stdout);
writeFileSync(path.join(reviewRoot, "independent-review-04.stderr.log"), stderr);
const execution = {
  schema: "p01-independent-review/v1",
  authorCommit: "ef716c8a1ae4b0c67c9af9ea6d84fee809399d1a",
  baselineCommit: "f01f3d3551b55b8bde6889a940e9bcc68425240b",
  startedAtUtc,
  completedAtUtc,
  command: nodeExe,
  argv: [probeScript, projectRoot, reviewRoot],
  cwd: projectRoot,
  exitCode: Number.isInteger(result.status) ? result.status : null,
  signal: result.signal ?? null,
  spawnError: result.error?.message ?? null,
  stdout: { path: "independent-review-04.stdout.log", bytes: stdout.byteLength, sha256: sha256(stdout) },
  stderr: { path: "independent-review-04.stderr.log", bytes: stderr.byteLength, sha256: sha256(stderr) },
};
writeFileSync(path.join(reviewRoot, "independent-review-04.execution.json"), JSON.stringify(execution, null, 2) + "\n", "utf8");
process.stdout.write("independent-review: exit=" + (execution.exitCode ?? "null") + " stdout=" + stdout.byteLength + " stderr=" + stderr.byteLength + (execution.spawnError ? " error=" + execution.spawnError : "") + "\n");
if (execution.exitCode !== 0) process.exitCode = 1;



