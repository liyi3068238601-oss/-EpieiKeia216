// Original P00 lifecycle fixture. Imports no runtime until the owner opens the gate.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(JSON.stringify({ type: 'job_gate_ready', pid: process.pid }) + '\n');
const iterator = input[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done) process.exit(2);
const command = JSON.parse(first.value);
input.close();
if (command.mode === 'fixture') {
  const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true, stdio: 'ignore', env: process.env,
  });
  await new Promise((resolve, reject) => { leaf.once('spawn', resolve); leaf.once('error', reject); });
  process.stdout.write(JSON.stringify({ type: 'job_fixture_child', pid: leaf.pid, parentPid: process.pid }) + '\n');
  setInterval(() => {}, 1000);
} else if (command.mode === 'module') {
  process.argv = [process.execPath, command.path, ...(command.args ?? [])];
  await import(pathToFileURL(command.path).href);
} else {
  throw new Error('Unknown gate mode');
}
