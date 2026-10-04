import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const authorRoot = path.resolve(process.argv[2]);
const reviewRoot = path.resolve(process.argv[3]);
const nodePath = path.resolve(process.argv[4]);
const commandsDir = path.join(reviewRoot, "commands");
const logsDir = path.join(reviewRoot, "logs");
mkdirSync(commandsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
const checks = [
  { name: "01-typecheck-noemit", args: [path.join(authorRoot, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json", "--noEmit"], timeout: 300000 },
  { name: "02-build", args: [path.join(authorRoot, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], timeout: 300000 },
  { name: "03-targeted-unit-tests", args: ["tools/run-tests.mjs", "unit", "P02-U08", "P02-U07"], timeout: 900000 },
];
const results = [];
for (const check of checks) {
  const started = new Date().toISOString();
  const run = spawnSync(nodePath, check.args, { cwd: authorRoot, encoding: "utf8", timeout: check.timeout,
    maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const stdoutPath = path.join(logsDir, check.name + ".stdout.txt");
  const stderrPath = path.join(logsDir, check.name + ".stderr.txt");
  writeFileSync(stdoutPath, stdout, { flag: "wx" });
  writeFileSync(stderrPath, stderr, { flag: "wx" });
  const record = {
    schema: "p02-independent-command/v1", name: check.name,
    argv: [nodePath, ...check.args], cwd: authorRoot, startedAt: started, completedAt: new Date().toISOString(),
    timeoutMs: check.timeout, exitCode: run.status, signal: run.signal, error: run.error?.message ?? null,
    stdout: { path: path.relative(reviewRoot, stdoutPath).split(path.sep).join("/"), bytes: Buffer.byteLength(stdout), sha256: sha(stdout) },
    stderr: { path: path.relative(reviewRoot, stderrPath).split(path.sep).join("/"), bytes: Buffer.byteLength(stderr), sha256: sha(stderr) },
  };
  const recordPath = path.join(commandsDir, check.name + ".json");
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  results.push(record);
  console.log(JSON.stringify({ name: check.name, exitCode: record.exitCode, signal: record.signal, error: record.error,
    stdoutBytes: record.stdout.bytes, stderrBytes: record.stderr.bytes, record: path.relative(reviewRoot, recordPath) }));
  if (record.exitCode !== 0) process.exitCode = 1;
}
writeFileSync(path.join(reviewRoot, "command-results.json"), JSON.stringify({ schema: "p02-independent-command-set/v1", node: nodePath,
  nodeVersion: process.version, commands: results.map(({ name, argv, cwd, exitCode, signal, error, stdout, stderr }) =>
    ({ name, argv, cwd, exitCode, signal, error, stdout, stderr })) }, null, 2) + "\n", { flag: "wx" });

function sha(value) { return createHash("sha256").update(value).digest("hex"); }
