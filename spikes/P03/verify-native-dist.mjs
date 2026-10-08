// Recompile CLI workspace JS into a fresh owned output, without mutating the reference checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = 'E:\\Xiadie\\Xiadie';
const source = path.join(root, '.runtime/P01/desktop-source');
const output = path.resolve(process.argv[2] ?? '');
assert.ok(output.startsWith(path.join(root, '.runtime/P03/experiments') + path.sep));
await mkdir(output);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bind = async file => { const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; };
const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim();
const commit = git(['rev-parse', 'HEAD']);
assert.equal(commit, '29628c9acdb81b703bbd4080c207a0e7ce5e276e');
assert.equal(git(['status', '--porcelain']), '');
const requireNative = createRequire(path.join(source, 'apps/zcode-cli/package.json'));
const tsPackage = requireNative.resolve('typescript/package.json');
const tsRoot = path.dirname(tsPackage);
const tsc = path.join(tsRoot, 'bin/tsc');
const ts = requireNative('typescript');
const names = ['shared-types', 'contracts', 'dynamic-workflow', 'dynamic-workflow-runtime', 'core', 'adapters', 'i18n', 'telemetry', 'bootstrap'];
const results = [];
const mismatches = [];
async function files(directory, prefix = '') {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), 'No links in compilation outputs');
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) entries.push(...await files(path.join(directory, item.name), relative));
    else if (item.isFile() && item.name.endsWith('.js')) entries.push(relative);
  }
  return entries.sort();
}
for (const name of names) {
  const packageRoot = path.join(source, 'apps/zcode-cli/packages', name);
  const configPath = path.join(packageRoot, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  assert.equal(parsed.errors.length, 0);
  const inputs = [];
  for (const filename of [configPath, path.join(packageRoot, 'package.json'), ...parsed.fileNames]) inputs.push(await bind(filename));
  const outDir = path.join(output, name);
  const args = [tsc, '--project', configPath, '--outDir', outDir, '--declaration', 'false', '--declarationMap', 'false', '--incremental', 'false'];
  const startedAt = new Date().toISOString();
  const run = spawnSync(process.execPath, args, { cwd: packageRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  const row = { package: name, command: { executable: process.execPath, args, cwd: packageRoot, startedAt, completedAt: new Date().toISOString(), exitCode: run.status, stdout: run.stdout, stderr: run.stderr }, inputs, outputs: [] };
  results.push(row);
  if (run.status !== 0) {
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'build_failed', results }, null, 2));
    throw new Error(`Native ${name} compilation failed (${run.status}): ${run.stdout}\n${run.stderr}`);
  }
  const originalDist = path.join(packageRoot, 'dist');
  const newFiles = await files(outDir);
  const oldFiles = await files(originalDist);
  if (JSON.stringify(newFiles) !== JSON.stringify(oldFiles)) mismatches.push({ package: name, reason: 'file-set', generated: newFiles, existing: oldFiles });
  for (const relative of newFiles) {
    const generated = await bind(path.join(outDir, relative));
    let existing;
    try { existing = await bind(path.join(originalDist, relative)); } catch { /* captured as mismatch */ }
    const match = generated.sha256 === existing?.sha256;
    row.outputs.push({ relative, generated, existing, match });
    if (!match) mismatches.push({ package: name, relative, generatedSha256: generated.sha256, existingSha256: existing?.sha256 });
  }
  for (const input of inputs) assert.equal((await bind(input.path)).sha256, input.sha256, 'Source unchanged during compilation');
}
assert.equal(git(['status', '--porcelain']), '');
assert.equal(git(['rev-parse', 'HEAD']), commit);
const report = { schema: 'p03-u02-native-dist-recompile/v1', status: mismatches.length ? 'mismatch' : 'pass', source, commit, node: await bind(process.execPath), typescript: { version: ts.version, package: await bind(tsPackage), compiler: await bind(path.join(tsRoot, 'lib/typescript.js')), cli: await bind(tsc) }, script: await bind(fileURLToPath(import.meta.url)), historicalPrepare: await bind(path.join(root, '.runtime/P01/desktop-build-evidence/prepare-runtime.result.json')), results, mismatches, limitation: 'Byte-identical JS recompile; no claim of reinstalling third-party dependencies or rebuilding Electron. Declaration emission disabled only for this readback; JavaScript output compared exactly.' };
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, packages: results.length, files: results.reduce((sum, row) => sum + row.outputs.length, 0), mismatches: mismatches.length, report: path.join(output, 'result.json') }));
assert.equal(mismatches.length, 0, 'Current loaded Native JS must match this compilation');
