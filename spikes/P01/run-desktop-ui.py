"""Fresh no-Key actual Desktop UI, local preference persistence and restart."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

ROOT = Path(__file__).resolve().parents[2]
SPIKE = ROOT / 'spikes/P01'
SOURCE = ROOT / '.runtime/P01/desktop-source'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
module_spec = importlib.util.spec_from_file_location('no_key_helper', SPIKE / 'run-no-key.py')
helper = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(helper)


def main():
    assert subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip() == PIN
    assert not subprocess.check_output(['git','-C',str(SOURCE),'status','--porcelain'],text=True).strip()
    desktop = SOURCE / 'packages/desktop'
    files = [desktop / 'out/main/index.js', desktop / 'out/host/index.js', desktop / 'out/preload/index.cjs', desktop / 'out/renderer/index.html']
    assert all(p.is_file() for p in files), 'Desktop build incomplete'
    run_id = 'desktop-no-key-' + str(time.time_ns())
    work = ROOT / '.runtime/P01' / run_id
    out = ROOT / 'evidence/P01-U02/20261001-01/runs' / run_id
    out.mkdir(parents=True)
    home, data, temp = [work / n for n in ('home','data','temp')]
    for p in (home, data, temp, home / 'AppData/Roaming', home / 'AppData/Local'):
        p.mkdir(parents=True, exist_ok=True)
    (home / '.zcode/v2').mkdir(parents=True)
    helper.save(home / '.zcode/v2/setting.json', {'desktopChromiumHardwareAccelerationEnabled': False})
    class Offline(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            self.send_response(503); self.send_header('Content-Length','0'); self.end_headers()
        do_POST = do_GET
    offline = ThreadingHTTPServer(('127.0.0.1', 0), Offline)
    threading.Thread(target=offline.serve_forever, daemon=True).start()
    offline_origin = 'http://127.0.0.1:' + str(offline.server_port)
    env = {k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC','PATHEXT')}
    env.update({'PATH': str(helper.NODE.parent) + r';C:\Program Files\Git\cmd;C:\Windows\System32',
        'USERPROFILE': str(home), 'APPDATA': str(home / 'AppData/Roaming'), 'LOCALAPPDATA': str(home / 'AppData/Local'),
        'TEMP': str(temp), 'TMP': str(temp), 'ZCODE_DATA_BASE_DIR': str(data), 'ZCODE_DESKTOP_HOME_DIR': str(home),
        'ZCODE_DESKTOP_USER_DATA_DIR': str(work / 'userData'), 'ZCODE_DESKTOP_SESSION_DATA_DIR': str(work / 'sessionData'),
        'ZCODE_DESKTOP_APPLICATION_NAME': run_id, 'ZCODE_ENV': 'test', 'ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT': '1',
        'ZCODE_ENDPOINT_ORIGIN': offline_origin, 'ZCODE_BASE_URL': offline_origin,
        'NODE_OPTIONS': '--require=' + str(SPIKE / 'desktop-guard.cjs'), 'P01_GUARD_LOG': str(out / 'network.jsonl'),
        'P01_GUARD_WRAPPERS': str(out / 'utility-guards'), 'P01_ALLOWED_HTTP_ORIGINS': json.dumps([offline_origin])})
    spec = {'desktop': str(desktop), 'electron': str(SOURCE / 'node_modules/electron/dist/electron.exe'),
        'playwright': str(SOURCE / 'node_modules/playwright-core'), 'guard': str(SPIKE / 'desktop-guard.cjs'), 'env': env, 'out': str(out),
        'settings_file': str(home / '.zcode/v2/setting.json')}
    listener_command = ['powershell.exe','-NoProfile','-Command','@(Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress']
    listener_text = subprocess.check_output(listener_command, text=True, encoding='utf-8').strip()
    listeners_before = json.loads(listener_text) if listener_text else []
    # The helper's own loopback listener is intentionally excluded from the
    # pre-existing-machine baseline; no application endpoint uses a fixed port.
    listeners_before = [q for q in listeners_before if q['OwningProcess'] != os.getpid()]
    helper.save(out / 'listeners-before.json', listeners_before)
    spec['occupied_ports_before'] = sorted({q['LocalPort'] for q in listeners_before})
    helper.save(work / 'spec.json', spec)
    before = helper.globals_snapshot()
    command = [str(helper.NODE), str(SPIKE / 'desktop-ui.mjs'), str(work / 'spec.json')]
    started = time.monotonic()
    driver_env = {k:v for k,v in env.items() if k != 'NODE_OPTIONS'}
    code_before = {p:helper.sha(SPIKE / p) for p in ('desktop-guard.cjs','desktop-ui.mjs','run-desktop-ui.py')}
    proc = subprocess.Popen(command, cwd=SPIKE, env=driver_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=180)
    except subprocess.TimeoutExpired:
        timed_out = True
        # This PID is our freshly created helper; /T ends only its child tree.
        subprocess.run([r'C:\Windows\System32\taskkill.exe','/PID',str(proc.pid),'/T','/F'],capture_output=True,check=False)
        stdout, stderr = proc.communicate(timeout=15)
    (out / 'stdout.bin').write_bytes(stdout); (out / 'stderr.bin').write_bytes(stderr)
    offline.shutdown(); offline.server_close()
    after = helper.globals_snapshot()
    logs = [json.loads(s) for s in (out / 'network.jsonl').read_text(encoding='utf-8').splitlines()] if (out / 'network.jsonl').exists() else []
    guards = [q for q in logs if q['kind'] == 'guard_loaded']
    # No keys are present; all external targets in the instrumented application
    # paths are rejected. This is not proof of an OS-level network sandbox.
    model_attempts = [q for q in logs if q['kind'] == 'request' and q['target'].startswith(('http:','https:')) and q['target'].endswith(('/chat/completions','/responses','/messages'))]
    code_after = {p:helper.sha(SPIKE / p) for p in code_before}
    summary = {'run_id': run_id, 'passed': proc.returncode == 0 and before == after and code_before == code_after and not model_attempts and len({q['pid'] for q in guards}) >= 4,
        'command': command, 'cwd': str(SPIKE), 'exit_code': proc.returncode, 'source_commit': PIN,
        'elapsed_seconds': round(time.monotonic()-started,3), 'timed_out': timed_out, 'production_unchanged': before == after,
        'production_before': before, 'production_after': after, 'model_requests': len(model_attempts),
        'runtime_kind': 'actual Electron Desktop, renderer/preload/host, two launches and native local settings persistence',
        'isolation': 'fresh profile + complete env; main/utility Node socket/fetch, Electron net and webRequest instrumentation; not OS sandbox',
        'guard_processes': guards, 'blocked_requests': sum(not q.get('allowed',True) for q in logs),
        'offline_endpoint': offline_origin, 'offline_endpoint_forwarding': False,
        'compiled': {p.relative_to(SOURCE).as_posix(): helper.sha(p) for p in files},
        'code_bindings': code_before, 'code_unchanged_during_run': code_before == code_after,
        'artifacts': [{'path':p.relative_to(ROOT).as_posix(),'bytes':p.stat().st_size,'sha256':helper.sha(p)} for p in out.iterdir() if p.is_file()]}
    helper.save(out / 'summary.json', summary)
    helper.save(out.parents[1] / 'summary-no-key-ui.json', summary)
    print(json.dumps({k:summary[k] for k in ('run_id','passed','exit_code','model_requests','blocked_requests')},ensure_ascii=False))
    raise SystemExit(0 if summary['passed'] else 1)


if __name__ == '__main__':
    main()
