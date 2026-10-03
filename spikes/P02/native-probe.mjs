// Run unchanged P01 assertions with a declared import-layout mapping, never edit them in place.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = 'E:/Xiadie/Xiadie/.runtime/P01/desktop-source';
const output = 'E:/Xiadie/Xiadie/.runtime/P02/experiments/u02/native/mapped-02';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const mappings = [];
const files = [];
await mkdir(output, { recursive: true });
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'exactly one expected mapping');
  return text.replace(before, after);
}
for (const relative of ['packages/adapters/zcode/test/native.integration.test.mjs', 'packages/application/test/native-projection.integration.test.mjs']) {
  const original = await readFile(path.join(repository, relative));
  let text = original.toString();
  text = relative.startsWith('packages/adapters')
    ? replaceOnce(text, '"packages", "provider", "dist", "registry.js"', '"packages", "provider", "src", "registry.ts"')
    : replaceOnce(text, '"packages/provider/dist/registry.js"', '"packages/provider/src/registry.ts"');
  if (relative.startsWith('packages/adapters')) {
    text = replaceOnce(text,
      'const testDirectory = path.dirname(fileURLToPath(import.meta.url));',
      'const testDirectory = ' + JSON.stringify(path.join(repository, 'packages/adapters/zcode/test')) + ';');
  } else {
    text = replaceOnce(text,
      'const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");',
      'const repositoryRoot = ' + JSON.stringify(repository) + ';');
    text = replaceOnce(text, '"../../../dist/packages/application/turn-projection.js"',
      JSON.stringify(pathToFileURL(path.join(repository, 'dist/packages/application/turn-projection.js')).href));
  }
  const filename = path.join(output, path.basename(relative));
  await writeFile(filename, text);
  files.push(filename);
  mappings.push({ source: path.join(repository, relative), original_sha256: sha(original),
    generated: filename, generated_sha256: sha(Buffer.from(text)),
    changes: ['One provider registry dist import mapped to pinned source TS', 'Test root/relative projection import bound to the author worktree; assertions unchanged'] });
}
const registry = path.join(source, 'packages/provider/src/registry.ts');
const snapshotCommand = ['powershell.exe', '-NoProfile', '-Command',
  'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress'];
const snapshot = spawnSync(snapshotCommand[0], snapshotCommand.slice(1), { encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(snapshot.status, 0, 'listener snapshot must succeed before starting mocks');
const before = JSON.parse(snapshot.stdout.replace(/^\uFEFF/, '').trim());
const beforePorts = new Set((Array.isArray(before) ? before : [before]).map(item => item.LocalPort));
const auditFile = path.join(repository, 'spikes/P02/native-network-audit.cjs');
const command = [process.execPath, '--require', auditFile, '--test', ...files];
const started = new Date().toISOString();
const child = spawn(command[0], command.slice(1), { cwd: repository,
  env: { ...process.env, P01_U06_ZCODE_SOURCE: source, P01_U07_ZCODE_SOURCE: source }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false;
child.stdout.on('data', data => { stdout += data; });
child.stderr.on('data', data => { stderr += data; });
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 150000);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
const listeners = stdout.split('\n').filter(line => line.includes('P02_NATIVE_LISTENER '))
  .map(line => JSON.parse(line.slice(line.indexOf('P02_NATIVE_LISTENER ') + 'P02_NATIVE_LISTENER '.length)));
const portPolicy = listeners.length > 0 && listeners.every(item => item.requested[0] === 0
  && ['127.0.0.1', '::1'].includes(item.address?.address) && !beforePorts.has(item.address?.port));
const record = { task: 'P02-U02', command, cwd: repository, started_at: started,
  completed_at: new Date().toISOString(), ...result, timed_out: timedOut, stdout, stderr,
  mappings, source_commit: '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
  port_policy: { pass: portPolicy, snapshot_command: snapshotCommand, snapshot_exit: snapshot.status,
    listening_before: before, actual_test_listeners: listeners, fixed_9229_disabled: 'No Desktop/inspector launched' },
  audit_preload: { path: auditFile, sha256: sha(await readFile(auditFile)), purpose: 'record listen(0) addresses only; no assertion/runtime/provider replacement' },
  registry: { path: registry, sha256: sha(await readFile(registry)) },
  boundary: 'Existing native ZCode Loop/Read/Hook tests with loopback mock model; no product P02 implementation, real model, Desktop or package assertion' };
await writeFile(path.join(output, 'command.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ code: result.code, timed_out: timedOut, output: path.join(output, 'command.json'), stdout_tail: stdout.slice(-1000), stderr_tail: stderr.slice(-1000) }));
process.exitCode = result.code === 0 && portPolicy ? 0 : result.code || 1;
