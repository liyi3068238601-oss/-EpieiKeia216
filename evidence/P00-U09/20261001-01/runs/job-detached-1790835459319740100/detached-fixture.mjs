import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
});
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
console.log(JSON.stringify({ type: 'detached_fixture', parentPid: process.pid, leafPid: child.pid }));
child.unref();
await new Promise(resolve => setTimeout(resolve, 250));
