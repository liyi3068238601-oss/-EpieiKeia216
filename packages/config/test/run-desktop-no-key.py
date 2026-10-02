"""No-Key native Desktop settings + synthetic local history, isolated and offline."""
import hashlib, importlib.util, json, os, pathlib, subprocess, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = pathlib.Path(__file__).resolve().parents[3]
ROOT = pathlib.Path(r'E:\Xiadie\Xiadie')
SOURCE = ROOT / '.runtime/P01/desktop-source'
DESKTOP = pathlib.Path(os.environ.get('P01_U08_DESKTOP', str(SOURCE/'packages/desktop')))
NODE = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
TEST = pathlib.Path(__file__).resolve().parent
helper_spec = importlib.util.spec_from_file_location('p01_no_key', ROOT / 'spikes/P01/run-no-key.py')
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)
def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes((json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode())
def sha(file): return hashlib.sha256(file.read_bytes()).hexdigest()

def main():
    assert __debug__
    assert subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip()==PIN
    assert not subprocess.check_output(['git','-C',str(SOURCE),'status','--porcelain'],text=True).strip()
    if DESKTOP != SOURCE/'packages/desktop':
        assert (DESKTOP/'xiadie-build.json').is_file(), 'Custom Desktop build must finish before starting UI'
    run_id = 'u08-no-key-' + str(time.time_ns())
    work = ROOT / '.runtime/P01' / run_id
    out = REPO / 'evidence/P01-U08/20261002-01/ui' / run_id
    out.mkdir(parents=True)
    for sub in ('home/AppData/Roaming','home/AppData/Local','data','temp','workspace','storage','userData','sessionData'):
        (work/sub).mkdir(parents=True)
    home, data, temp, workspace = [work/x for x in ('home','data','temp','workspace')]
    settings_file = home / '.zcode/v2/setting.json'
    save(settings_file, {'desktopChromiumHardwareAccelerationEnabled':False, 'localePreference':'en-US'})
    save(home/'.zcode/cli/config.json', {'permission':{'mode':'plan'},
        'features':{name:False for name in ('subagent','memory','skill','mcp')},
        'memory':{'use':False}, 'plugins':{'enabled':False}, 'hooks':{'enabled':False}})
    session_id = str(uuid.uuid4())
    user_marker = 'P01 U08 local history ' + session_id[:8]
    assistant_marker = 'P01 U08 persisted assistant ' + session_id[:8]
    fixture = work / 'synthetic-history.jsonl'
    fixture.parent.mkdir(parents=True,exist_ok=True)
    records = [{'type':'user','uuid':str(uuid.uuid4()),'sessionId':session_id,'cwd':str(workspace),
                'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'message':{'role':'user','content':user_marker}},
               {'type':'assistant','uuid':str(uuid.uuid4()),'sessionId':session_id,'cwd':str(workspace),
                'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'message':{'role':'assistant','model':'synthetic-only','content':[{'type':'text','text':assistant_marker}]}}]
    fixture.write_bytes(('\n'.join(json.dumps(x) for x in records)+'\n').encode())
    class Offline(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_GET(self): self.send_response(503); self.send_header('Content-Length','0'); self.end_headers()
        do_POST = do_GET
    offline = ThreadingHTTPServer(('127.0.0.1',0),Offline)
    threading.Thread(target=offline.serve_forever,daemon=True).start()
    origin = f'http://127.0.0.1:{offline.server_port}'
    # Use the actual profile implementation before any Desktop process starts.
    module_spec_path = work/'module-spec.json'
    bridge = TEST/'profile-spec.mjs'
    assert bridge.is_file(), 'U08 config module bridge must be present before UI execution'
    bridge_env = {k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC','PATHEXT')}
    bridge_env['PATH'] = str(NODE.parent)+r';C:\Program Files\Git\cmd;C:\Windows\System32'
    proc = subprocess.run([str(NODE),str(bridge),str(work),str(module_spec_path),origin],cwd=REPO,env=bridge_env,capture_output=True)
    (out/'profile-spec.stdout.log').write_bytes(proc.stdout); (out/'profile-spec.stderr.log').write_bytes(proc.stderr)
    save(out/'profile-spec-command.json',{'argv':[str(NODE),str(bridge),str(work),str(module_spec_path),origin],
        'cwd':str(REPO),'exit_code':proc.returncode})
    assert proc.returncode==0, 'U08 profile module bridge failed'
    module = json.loads(module_spec_path.read_bytes())
    env = module['env']
    assert env['HOME']==str(home) and env['ZCODE_DATA_BASE_DIR']==str(data)
    env.update({'ZCODE_DESKTOP_APPLICATION_NAME':run_id,'ZCODE_ENV':'test',
        'ZCODE_ENDPOINT_ORIGIN':origin,'ZCODE_BASE_URL':origin,
        'NODE_OPTIONS':'--require='+str(ROOT/'spikes/P01/desktop-guard.cjs'),
        'P01_GUARD_LOG':str(out/'network.jsonl'),'P01_GUARD_WRAPPERS':str(out/'utility-guards'),
        'P01_ALLOWED_HTTP_ORIGINS':json.dumps([origin])})
    listener_cmd=['powershell.exe','-NoProfile','-Command','@(Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress']
    listener_text=subprocess.check_output(listener_cmd,text=True,encoding='utf-8').strip()
    listeners=json.loads(listener_text) if listener_text else []
    if isinstance(listeners,dict): listeners=[listeners]
    listeners=[x for x in listeners if x['OwningProcess']!=os.getpid()]
    save(out/'listeners-before.json',listeners)
    launch_cwd = DESKTOP.parents[1] if DESKTOP != SOURCE/'packages/desktop' else SOURCE/'packages/desktop'
    spec={'source':str(SOURCE),'profile_root':str(work),'desktop':str(DESKTOP),'launch_cwd':str(launch_cwd),'electron':str(SOURCE/'node_modules/electron/dist/electron.exe'),
        'playwright':str(SOURCE/'node_modules/playwright-core'),'guard':str(ROOT/'spikes/P01/desktop-guard.cjs'),
        'env':env,'out':str(out),'settings_file':str(settings_file),'session_id':session_id,'workspace':str(workspace),
        'user_marker':user_marker,'assistant_marker':assistant_marker,
        'occupied_ports_before':sorted({x['LocalPort'] for x in listeners})}
    save(work/'spec.json',spec)
    before=helper.globals_snapshot()
    files=[TEST/'desktop-no-key.mjs',TEST/'run-desktop-no-key.py',TEST/'seed-history.mjs',bridge,ROOT/'spikes/P01/desktop-guard.cjs',
           DESKTOP/'out/main/index.js',DESKTOP/'out/host/index.js',
           DESKTOP/'out/preload/index.cjs',DESKTOP/'out/renderer/index.html',
           launch_cwd/'apps/zcode-cli/packages/cli/dist/zcode.cjs' if launch_cwd != SOURCE/'packages/desktop' else SOURCE/'apps/zcode-cli/packages/cli/dist/zcode.cjs']
    code_before={str(x):sha(x) for x in files}
    seed_command=[str(NODE),str(TEST/'seed-history.mjs'),str(work/'spec.json')]
    seeded=subprocess.run(seed_command,cwd=REPO,env=env,capture_output=True,timeout=40)
    (out/'seed.stdout.log').write_bytes(seeded.stdout); (out/'seed.stderr.log').write_bytes(seeded.stderr)
    save(out/'seed-command.json',{'argv':seed_command,'cwd':str(REPO),'exit_code':seeded.returncode})
    assert seeded.returncode==0, 'Native synthetic history seed failed'
    command=[str(NODE),str(TEST/'desktop-no-key.mjs'),str(work/'spec.json')]
    started=time.monotonic()
    process=subprocess.Popen(command,cwd=REPO,env={k:v for k,v in env.items() if k!='NODE_OPTIONS'},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    timed_out=False
    try: stdout,stderr=process.communicate(timeout=220)
    except subprocess.TimeoutExpired:
        timed_out=True
        subprocess.run([r'C:\Windows\System32\taskkill.exe','/PID',str(process.pid),'/T','/F'],capture_output=True)
        stdout,stderr=process.communicate(timeout=20)
    finally: offline.shutdown(); offline.server_close()
    (out/'stdout.log').write_bytes(stdout); (out/'stderr.log').write_bytes(stderr)
    after=helper.globals_snapshot()
    network=[json.loads(x) for x in (out/'network.jsonl').read_text().splitlines()] if (out/'network.jsonl').exists() else []
    calls=[x for x in network if x.get('kind')=='request' and x.get('target','').endswith(('/chat/completions','/responses','/messages'))]
    summary={'run_id':run_id,'passed':process.returncode==0 and before==after and not calls and not timed_out,
        'command':command,'cwd':str(REPO),'exit_code':process.returncode,'timed_out':timed_out,
        'elapsed_seconds':round(time.monotonic()-started,3),'source_commit':PIN,
        'production_unchanged':before==after,'production_before':before,'production_after':after,
        'reference_source_clean':not subprocess.check_output(['git','-C',str(SOURCE),'status','--porcelain'],text=True).strip(),
        'model_requests':len(calls),'guard_scope':'Node/Electron instrumentation, not an OS sandbox',
        'config_module':module,'code_bindings':code_before,'code_unchanged':code_before=={str(x):sha(x) for x in files},
        'desktop_assembly':str(DESKTOP),
        'fixture_sha256':sha(fixture),'real_credential_loaded':False,'DSH_started':False}
    summary['passed'] &= summary['code_unchanged'] and summary['reference_source_clean']
    save(out/'summary.json',summary)
    print(json.dumps({'passed':summary['passed'],'exit_code':process.returncode,'out':str(out)}))
    raise SystemExit(0 if summary['passed'] else 1)
if __name__=='__main__': main()
