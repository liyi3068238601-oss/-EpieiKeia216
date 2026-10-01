"""Original Windows P00 process ownership spike; not an OS security sandbox."""
import argparse
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

if os.name != 'nt':
    raise SystemExit('This P00 Job Object spike requires Windows')

k = c.WinDLL('kernel32', use_last_error=True)
for name, args, ret in (
    ('CreateJobObjectW', [c.c_void_p, w.LPCWSTR], w.HANDLE),
    ('SetInformationJobObject', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
    ('QueryInformationJobObject', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p], w.BOOL),
    ('AssignProcessToJobObject', [w.HANDLE, w.HANDLE], w.BOOL),
    ('OpenProcess', [w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
    ('WaitForSingleObject', [w.HANDLE, w.DWORD], w.DWORD),
    ('CloseHandle', [w.HANDLE], w.BOOL),
):
    f = getattr(k, name); f.argtypes = args; f.restype = ret

class BasicLimit(c.Structure):
    _fields_ = [('PerProcessUserTimeLimit', c.c_int64), ('PerJobUserTimeLimit', c.c_int64),
                ('LimitFlags', w.DWORD), ('MinimumWorkingSetSize', c.c_size_t),
                ('MaximumWorkingSetSize', c.c_size_t), ('ActiveProcessLimit', w.DWORD),
                ('Affinity', c.c_size_t), ('PriorityClass', w.DWORD), ('SchedulingClass', w.DWORD)]

class IoCounters(c.Structure):
    _fields_ = [(name, c.c_uint64) for name in ('ReadOperationCount', 'WriteOperationCount',
                'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

class ExtendedLimit(c.Structure):
    _fields_ = [('BasicLimitInformation', BasicLimit), ('IoInfo', IoCounters),
                ('ProcessMemoryLimit', c.c_size_t), ('JobMemoryLimit', c.c_size_t),
                ('PeakProcessMemoryUsed', c.c_size_t), ('PeakJobMemoryUsed', c.c_size_t)]

class PidList(c.Structure):
    _fields_ = [('assigned', w.DWORD), ('count', w.DWORD), ('pids', c.c_size_t * 256)]

def check(value):
    if not value:
        raise c.WinError(c.get_last_error())
    return value

class OwnedJob:
    def __init__(self):
        self.handle = check(k.CreateJobObjectW(None, None))
        limits = ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway.
        try:
            check(k.SetInformationJobObject(self.handle, 9, c.byref(limits), c.sizeof(limits)))
        except BaseException:
            self.close(); raise

    def assign(self, child):
        # Popen owns this newly created process HANDLE; never targets a discovered user PID.
        check(k.AssignProcessToJobObject(self.handle, w.HANDLE(int(child._handle))))

    def pids(self):
        info = PidList()
        check(k.QueryInformationJobObject(self.handle, 3, c.byref(info), c.sizeof(info), None))
        assert info.count <= 256, 'P00 fixture exceeded its fixed small PID capacity'
        return [int(x) for x in info.pids[:info.count]]

    def close(self):
        if self.handle:
            handle, self.handle = self.handle, None
            check(k.CloseHandle(handle))

def clean_env(root):
    system = Path(os.environ.get('SystemRoot', r'C:\Windows'))
    env = {'SystemRoot': str(system), 'WINDIR': str(system),
           'ComSpec': str(system / 'System32/cmd.exe'),
           'PATH': r'C:\Program Files\nodejs;C:\Program Files\Git\cmd;' + str(system / 'System32'),
           'PATHEXT': '.COM;.EXE;.BAT;.CMD'}
    for key in ('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'):
        p = root / key.lower(); p.mkdir(parents=True, exist_ok=True); env[key] = str(p)
    return env  # Full replacement; no HOME or inherited provider credentials.

def reader(stream, items, rows):
    for line in stream:
        rows.append(line); items.put(line)
    items.put(None)

def next_json(items, timeout=15):
    value = items.get(timeout=timeout)
    if value is None:
        raise RuntimeError('Gate exited before expected event')
    return json.loads(value)

def launch(node, gate, data, command):
    data.mkdir(parents=True)
    job = OwnedJob()
    child = None
    try:
        child = subprocess.Popen([node, str(gate)], cwd=data, env=clean_env(data),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
        items, rows, errors = queue.Queue(), [], []
        thread = threading.Thread(target=reader, args=(child.stdout, items, rows), daemon=True); thread.start()
        error_thread = threading.Thread(target=reader, args=(child.stderr, queue.Queue(), errors), daemon=True); error_thread.start()
        ready = next_json(items); assert ready == {'type': 'job_gate_ready', 'pid': child.pid}
        job.assign(child)
        initial = job.pids(); assert initial == [child.pid]
        child.stdin.write(json.dumps(command) + '\n'); child.stdin.flush(); child.stdin.close()
        return {'job': job, 'child': child, 'items': items, 'stdout': rows, 'stderr': errors,
                'threads': [thread, error_thread], 'initial_members': initial}
    except BaseException:
        job.close()
        if child is not None:
            if child.poll() is None: child.kill()
            child.wait(timeout=10)
        raise

def watch_member(job, pid):
    assert pid in job.pids(), 'Do not open an unverified process outside this owned Job'
    return check(k.OpenProcess(0x00100000, False, pid))  # SYNCHRONIZE only; PID reuse avoided by retained handle.

def alive(handle):
    state = k.WaitForSingleObject(handle, 0)
    if state == 0xFFFFFFFF: raise c.WinError(c.get_last_error())
    return state == 0x102

def stop(entry):
    entry['job'].close()
    entry['child'].wait(timeout=10)
    for thread in entry['threads']: thread.join(timeout=2)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--output-dir')
    parser.add_argument('--node', default=r'C:\Program Files\nodejs\node.exe')
    parser.add_argument('--driver', help='Optional original SDK probe module executed after Job assignment')
    parser.add_argument('--driver-args', nargs=argparse.REMAINDER, default=[])
    args = parser.parse_args()
    root = Path(args.root).resolve()
    out = Path(args.output_dir).resolve() if args.output_dir else root / 'evidence/P00-U09/20261001-01/runs' / ('job-' + str(time.time_ns()))
    assert any(out.is_relative_to(root / scope) for scope in ('evidence/P00-U09', 'evidence/P00-U11')), 'Output outside authorized evidence roots'
    out.mkdir(parents=True, exist_ok=False)
    (out / '.gitignore').write_text('data/\n', encoding='utf-8', newline='\n')
    gate = Path(__file__).with_name('job-gate.mjs')
    entries, handles = [], []
    result = {'scope': 'External Windows Job containment; not native SDK cancel or a security sandbox',
        'status': 'failed', 'cwd': str(Path.cwd()), 'root': str(root), 'output_dir': str(out),
        'code_bindings': {str(p.relative_to(root) if p.is_relative_to(root) else p).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in (Path(__file__).resolve(), gate.resolve())},
        'struct_bytes': c.sizeof(ExtendedLimit), 'external_model_calls': 0,
        'official_sources': ['https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject',
        'https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects',
        'https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information'],
        'limits': ['Windows host only', 'Gate is trusted original fixture; no runtime imports/spawns before assignment',
                   'Forced close is not cooperative checkpoint flush; durable recovery is tested separately',
                   'No API/filesystem/credential sandbox, no arbitrary malicious process security claim']}
    try:
        if args.driver:
            driver = Path(args.driver).resolve()
            assert driver.is_file() and driver.is_relative_to(root), 'Only an explicit module within the project'
            a = launch(args.node, gate, out / 'data/A', {'mode': 'module', 'path': str(driver), 'args': args.driver_args}); entries.append(a)
            deadline, observed = time.monotonic() + 120, []
            while a['child'].poll() is None:
                members = a['job'].pids()
                if not observed or members != observed[-1]: observed.append(members)
                if time.monotonic() >= deadline: raise TimeoutError('Owned driver exceeded 120 seconds')
                time.sleep(0.05)
            code = a['child'].wait(timeout=10)
            before_close = a['job'].pids()
            stop(a)
            result.update(status='passed' if code == 0 else 'failed', driver=str(driver), driver_exit_code=code, assigned_before_import=True,
                          initial_members=a['initial_members'], observed_members=observed,
                          members_before_job_close=before_close)
        else:
            for label in ('A', 'B'):
                entry = launch(args.node, gate, out / ('data/' + label), {'mode': 'fixture'}); entries.append(entry)
                event = next_json(entry['items']); assert event['type'] == 'job_fixture_child' and event['parentPid'] == entry['child'].pid
                entry['leaf_pid'] = event['pid']
                entry['members'] = entry['job'].pids()
                assert set(entry['members']) == {entry['child'].pid, event['pid']}
                entry['handles'] = [watch_member(entry['job'], pid) for pid in entry['members']]; handles.extend(entry['handles'])
            a, b = entries
            assert all(alive(h) for h in handles)
            stop(a)
            for h in a['handles']: assert k.WaitForSingleObject(h, 5000) == 0
            b_after_a = [alive(h) for h in b['handles']]; assert all(b_after_a)
            stop(b)
            for h in b['handles']: assert k.WaitForSingleObject(h, 5000) == 0
            result.update(status='passed', assigned_before_gate=True,
                a_members=a['members'], b_members=b['members'], a_all_exited=True,
                b_members_alive_after_a_close=b_after_a, b_all_exited=True,
                original_owner_assigned=False, final_assertions=6)
    except BaseException as error:
        result['error'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        for entry in entries:
            stop(entry)
        for handle in handles: check(k.CloseHandle(handle))
        for i, entry in enumerate(entries):
            (out / f'{i}-stdout.jsonl').write_text(''.join(entry['stdout']), encoding='utf-8', newline='\n')
            (out / f'{i}-stderr.txt').write_text(''.join(entry['stderr']), encoding='utf-8', newline='\n')
        (out / 'summary.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8', newline='\n')
        print(json.dumps({'status': result['status'], 'summary': str(out / 'summary.json')}))
    if result['status'] != 'passed': raise SystemExit(1)

if __name__ == '__main__': main()
