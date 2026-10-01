"""Original bounded detached-child contrast test for the external Windows Job."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time

parser = argparse.ArgumentParser()
parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2]))
parser.add_argument('--output-dir')
args = parser.parse_args()
root = Path(args.root).resolve()
out = Path(args.output_dir).resolve() if args.output_dir else root / 'evidence/P00-U09/20261001-01/runs' / ('job-detached-' + str(time.time_ns()))
assert any(out.is_relative_to(root / x) for x in ('evidence/P00-U09', 'evidence/P00-U11'))
out.mkdir(parents=True, exist_ok=False)
(out / '.gitignore').write_text('data/\n', encoding='utf-8', newline='\n')
owner_file = Path(__file__).with_name('windows-job.py')
spec = importlib.util.spec_from_file_location('p00_owned_job', owner_file)
owner = importlib.util.module_from_spec(spec); spec.loader.exec_module(owner)
fixture = out / 'detached-fixture.mjs'
fixture.write_text("""import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
});
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
console.log(JSON.stringify({ type: 'detached_fixture', parentPid: process.pid, leafPid: child.pid }));
child.unref();
await new Promise(resolve => setTimeout(resolve, 250));
""", encoding='utf-8', newline='\n')
entry = handle = None
summary = {'status': 'failed', 'scope': 'External owned Job closes a detached synthetic leaf; not native SDK behavior',
           'external_model_calls': 0, 'cwd': str(Path.cwd()),
           'code_bindings': {str(p.relative_to(root)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in (Path(__file__).resolve(), owner_file.resolve(), fixture.resolve())}}
try:
    entry = owner.launch(r'C:\Program Files\nodejs\node.exe', Path(__file__).with_name('job-gate.mjs'),
                         out / 'data', {'mode': 'module', 'path': str(fixture), 'args': []})
    event = owner.next_json(entry['items'])
    assert event['type'] == 'detached_fixture' and event['parentPid'] == entry['child'].pid
    entry['child'].wait(timeout=10)
    assert entry['child'].returncode == 0
    members = entry['job'].pids(); assert members == [event['leafPid']]
    handle = owner.watch_member(entry['job'], event['leafPid'])
    alive_before = owner.alive(handle); assert alive_before
    owner.stop(entry)
    wait_after = owner.k.WaitForSingleObject(handle, 5000); assert wait_after == 0
    summary.update(status='passed', parent_exit_code=0, leaf_pid=event['leafPid'], members_after_parent_exit=members,
                   detached_leaf_alive_after_parent_exit=alive_before, leaf_wait_after_job_close=wait_after)
finally:
    if entry:
        owner.stop(entry)
        (out / 'stdout.jsonl').write_text(''.join(entry['stdout']), encoding='utf-8', newline='\n')
        (out / 'stderr.txt').write_text(''.join(entry['stderr']), encoding='utf-8', newline='\n')
    if handle: owner.check(owner.k.CloseHandle(handle))
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({'status': summary['status'], 'summary': str(out / 'summary.json')}))
