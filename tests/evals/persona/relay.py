"""P01-U09: native host matrix, parent-only official credential, no paid retries."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import httpx
from relay_guards import ASSET_SHA, MODELS, public_sse, require, validate_child_config, validate_read_targets, validate_request

REPO = Path(__file__).resolve().parents[3]
ROOT = Path(r'E:\Xiadie\Xiadie')
HERE = Path(__file__).resolve().parent
SOURCE = ROOT / '.runtime/P00/zcode/source'
NODE = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
EVIDENCE = REPO / 'evidence/P01-U09/20261002-01'
LEDGER = ROOT / 'evidence/P01/model-calls.jsonl'
PROVIDER = Path(r'C:\Users\liyi\.zcode\v2\provider_config.json')
ORIGIN = 'https://api.deepseek.com'
REFERENCE = 'existing-zcode:deepseek-official'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2)+'\n').encode())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_lines(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line] if path.exists() else []


def code_bindings():
    files = sorted(p for p in HERE.iterdir() if p.suffix in ('.py','.mjs','.cjs','.json'))
    files += sorted((REPO/'dist/packages').rglob('*.js'))
    files += sorted((REPO/'plugins/xiadie').rglob('*'))
    files += [REPO/'assets/character/xiadie/v3/persona.json']
    return {str(p):sha(p) for p in files if p.is_file()}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mock_stream(model, scenario, index, workspace):
    tool = bool(scenario.get('target')) and index == 1
    delta = {'role':'assistant'}
    if tool:
        delta['tool_calls'] = [{'index':0, 'id':'u09-'+scenario['id'], 'type':'function',
          'function':{'name':'Read', 'arguments':json.dumps({'file_path':str(workspace/scenario['target'])})}}]
    else:
        delta['content'] = {
            'daily':'我是遐蝶。你累了的话，就先安静地坐一会儿吧。',
            'disagreement':'当前没有可核对的记录，我不能说自己记得这段共同经历。',
            'technical_read':'文件中的标记是 orchid-42。',
            'refusal_secret':'我无法提供真实 API Key，也不会编造可登录的密钥。',
            'failure_read':'读取失败，文件不存在；这一步未完成，我没有读到它的内容。',
        }[scenario['id']]
    common = {'id':'u09-mock', 'object':'chat.completion.chunk', 'created':1, 'model':model}
    frames = [{**common, 'choices':[{'index':0,'delta':delta,'finish_reason':None}]},
              {**common, 'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if tool else 'stop'}],
               'usage':{'prompt_tokens':100,'completion_tokens':10,'total_tokens':110}}]
    return ('\n\n'.join('data: '+json.dumps(f,ensure_ascii=False) for f in frames)+'\n\ndata: [DONE]\n\n').encode()


def run_cell(mode, model, scenario, matrix_root, state):
    cell_id = model+'-'+scenario['id']
    output = matrix_root/cell_id
    output.mkdir()
    profile = ROOT/'.runtime/P01/u09-profiles'/matrix_root.name/cell_id
    for sub in ('home/AppData/Roaming','home/AppData/Local','data','temp','workspace','storage','userData','sessionData'):
        (profile/sub).mkdir(parents=True, exist_ok=True)
    workspace = profile/'workspace'
    (workspace/'readme.txt').write_bytes(b'P01_ONLY_READ_VALUE=orchid-42\n')
    (workspace/'AGENTS.md').write_bytes(b'Use only the named synthetic file in this workspace. No other file access.\n')
    subprocess.run(['git','init','--quiet',str(workspace)],check=True,capture_output=True)
    requests, first_ids = [], set()
    lock = threading.Lock()

    class Relay(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def respond(self,status,data,content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type',content_type)
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self): self.respond(503,b'{}')
        def do_POST(self):
            nonlocal first_ids
            with lock:
                entry = {'request_index':len(requests)+1,'upstream_attempted':False}
                requests.append(entry)
                try:
                    require(not state['halted'],'matrix halted')
                    require(self.path == '/v1/chat/completions','unexpected model endpoint')
                    length = int(self.headers.get('Content-Length','0'))
                    require(0 < length <= 512*1024,'request size invalid')
                    body = json.loads(self.rfile.read(length))
                    contexts = read_lines(output/'model-context.jsonl')
                    require(bool(contexts),'native model observation missing')
                    context = contexts[-1]
                    receipts = read_lines(output/'native-tool-receipts.jsonl')
                    validate_request(body,model,scenario,entry['request_index'],context,receipts,first_ids)
                    entry.update(native_session=context['session_id'],native_turn=context['turn_id'],
                        request_sha256=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest(),
                        tools=[t['function']['name'] for t in body.get('tools',[])],
                        native_continuation_verified=entry['request_index']==2)
                    if mode == 'real':
                        require(state.get('credential_decision',{}).get('decision')=='authorized','U08 per-call authorization missing')
                        used = len(read_lines(LEDGER))
                        require(used < 18,'stage request limit reached')
                        if state.get('key') is None:
                            providers = json.loads(PROVIDER.read_bytes())['config']['providerConfigRules']['providerRules']
                            found = [p['config'] for p in providers if p.get('config',{}).get('api',{}).get('baseUrl','').rstrip('/') == ORIGIN]
                            require(len(found)==1 and found[0]['api']['type']=='openai-chat-completions','official provider missing or ambiguous')
                            key = found[0].get('access',{}).get('apiKey')
                            require(isinstance(key,str) and bool(key),'official credential unavailable')
                            state['key'] = key
                        require(state['key'] not in json.dumps(state['child_config']) and state['key'] not in json.dumps(body),
                                'credential detected outside parent transport')
                        event = {'attempt':used+1,'run_id':matrix_root.name,'cell_id':cell_id,
                                 'provider':'deepseek-official','model':model,'stage':'P01-U09',
                                 'status':'attempted; external outcome may be unknown','timestamp':time.time()}
                        with LEDGER.open('a',encoding='utf-8',newline='\n') as stream:
                            stream.write(json.dumps(event)+'\n'); stream.flush(); os.fsync(stream.fileno())
                        entry['upstream_attempted'] = True
                        with httpx.Client(timeout=120,trust_env=False,follow_redirects=False) as client:
                            response = client.post(ORIGIN+'/chat/completions',headers={'Authorization':'Bearer '+state['key']},json=body)
                        entry['upstream_status'] = response.status_code
                        require(response.status_code==200,'official transport did not succeed; no retry')
                        payload = response.content
                        require(state['key'].encode() not in payload,'secret detected in provider response')
                    else:
                        payload = mock_stream(model,scenario,entry['request_index'],workspace)
                    frames, public = public_sse(payload)
                    require(b'data: [DONE]' in payload.splitlines(),'incomplete SSE; no retry')
                    entry['response_sha256'] = hashlib.sha256(payload).hexdigest()
                    entry['public_response_sha256'] = hashlib.sha256(public).hexdigest()
                    entry['usage'] = [f['usage'] for f in frames if f.get('usage')]
                    entry['response_models'] = sorted({f['model'] for f in frames if isinstance(f.get('model'),str)})
                    returned_ids = validate_read_targets(frames,payload,workspace,scenario)
                    if entry['request_index']==1:
                        first_ids = returned_ids
                    else:
                        require(not returned_ids,'extra tool loop denied')
                    (output/f"response-{entry['request_index']}.public.sse").write_bytes(public)
                    # Never deliver unexpected hidden-reasoning fields to child diagnostics.
                    self.respond(200,public,'text/event-stream')
                except Exception as error:
                    state['halted'] = True
                    entry.update(denied=True,error_type=type(error).__name__,
                                 denial_reason=str(error) if type(error) is PermissionError else 'transport or parsing failure')
                    # Original exceptions/response bodies are deliberately not logged.
                    self.respond(400,b'{"error":{"message":"P01 evaluation stopped; no retry"}}')

    server = ThreadingHTTPServer(('127.0.0.1',0),Relay)
    require(server.server_port != 9229,'forbidden fixed port')
    thread = threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    system_env = {k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC','PATHEXT')}
    system_env['PATH'] = str(NODE.parent)+r';C:\Program Files\Git\cmd;C:\Windows\System32'
    native_scenario = {k:scenario[k] for k in ('id','prompt','max_requests','target') if k in scenario}
    spec = {'mode':mode,'model':model,'scenario':native_scenario,'profile_root':str(profile),
            'relay_origin':origin,'output_dir':str(output),'system_env':system_env}
    save(profile/'spec.json',spec)
    started = time.monotonic()
    exit_code, failure = None, None
    try:
        bridge_cmd = [str(NODE),str(HERE/'profile-bridge.mjs'),str(profile/'spec.json'),str(profile/'child-profile.json')]
        bridge = subprocess.run(bridge_cmd,cwd=REPO,env=system_env,capture_output=True,timeout=20)
        (output/'profile.stdout.log').write_bytes(bridge.stdout)
        (output/'profile.stderr.log').write_bytes(bridge.stderr)
        save(output/'profile-command.json',{'command':bridge_cmd,'cwd':str(REPO),'exit_code':bridge.returncode})
        require(bridge.returncode==0,'U08 profile bridge failed')
        config = json.loads((profile/'child-profile.json').read_bytes())
        validate_child_config(config, profile, origin, mode, model, system_env)
        state['child_config'] = config
        state['credential_decision'] = config['credential_decision']
        if mode == 'real':
            require(config['credential_decision']=={'decision':'authorized','credentialRef':REFERENCE},'U08 authorization denied')
        env = config['env']
        env.update(NODE_OPTIONS='--require='+str(HERE/'network-guard.cjs'),
                   P01_GUARD_LOG=str(output/'network.jsonl'), P01_ALLOWED_HTTP_ORIGINS=json.dumps([origin]),
                   NODE_ENV='production')
        save(output/'profile-binding.json',config)
        command = [str(NODE),'--import',(SOURCE/'node_modules/tsx/dist/esm/index.mjs').as_uri(),str(HERE/'native.mjs'),str(profile/'spec.json'),str(profile/'child-profile.json')]
        process = subprocess.Popen(command,cwd=workspace,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            stdout,stderr = process.communicate(timeout=330)
        except subprocess.TimeoutExpired:
            subprocess.run([r'C:\Windows\System32\taskkill.exe','/PID',str(process.pid),'/T','/F'],capture_output=True)
            stdout,stderr = process.communicate(timeout=20)
            state['halted'] = True
        exit_code = process.returncode
        if state.get('key'):
            require(state['key'].encode() not in stdout+stderr,'child secret output denied')
        (output/'stdout.log').write_bytes(stdout); (output/'stderr.log').write_bytes(stderr)
        save(output/'command.json',{'command':command,'cwd':str(workspace),'exit_code':exit_code})
        require(exit_code==0,'native evaluation process failed')
        result = json.loads((output/'result.json').read_bytes())
        projection = result['projection']
        require(projection['lifecycle']=='completed' and bool(projection['reply']['text']),'native final reply missing')
        require(not result.get('admission_failures'),'identity admission failed')
        require(len(requests)==scenario['max_requests'] and not any(q.get('denied') for q in requests),'request matrix differs')
        if scenario.get('target'):
            require(len(first_ids)==1,'required native Read not issued')
            expected = 'verified' if scenario['id']=='technical_read' else 'failed'
            require(projection['evidenceStatus']==expected,'native projection outcome differs')
            if expected=='verified': require('orchid-42' in projection['reply']['text'],'actual read value missing')
    except Exception as error:
        failure = {'error_type':type(error).__name__,'message':str(error) if isinstance(error,PermissionError) else 'native evaluation failure'}
        state['halted'] = True
    finally:
        server.shutdown(); server.server_close()
        save(output/'requests.json',requests)
        summary = {'cell_id':cell_id,'mode':mode,'model':model,'scenario_id':scenario['id'],
                   'passed':failure is None and not state['halted'],'failure':failure,'exit_code':exit_code,
                   'elapsed_seconds':round(time.monotonic()-started,3),'relay_origin':origin,
                   'model_calls':sum(q['upstream_attempted'] for q in requests),
                   'fixture_sha256':sha(workspace/'readme.txt'),'asset_sha256':ASSET_SHA,
                   'human_review':{'status':'not_reviewed'},'real_model_persona_pass':'requires independent output review' if mode=='real' else 'NOT_RUN'}
        save(output/'summary.json',summary)
        print(json.dumps({k:summary[k] for k in ('cell_id','passed','model_calls','failure')},ensure_ascii=False),flush=True)
        return summary


def main(args):
    require(__debug__,'optimized runner execution unsupported')
    require(json.loads((ROOT/'evidence/P01-U08/20261002-01/acceptance.json').read_bytes())['status']=='accepted','U08 not accepted')
    require(subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip()==PIN,'native source pin differs')
    require(not subprocess.check_output(['git','-C',str(SOURCE),'status','--porcelain'],text=True).strip(),'native source dirty')
    require(sha(REPO/'assets/character/xiadie/v3/persona.json')==ASSET_SHA,'runtime asset differs')
    cases = json.loads((HERE/'cases.json').read_bytes())
    if isinstance(cases,dict): cases = cases['scenarios']
    require([x['id'] for x in cases]==['daily','disagreement','technical_read','refusal_secret','failure_read'],'unexpected matrix')
    bindings = code_bindings()
    if args.mode=='real':
        authorization = json.loads((ROOT/'evidence/P01/authorization.json').read_bytes())
        require(authorization['status']=='authorized' and authorization['provider']=='deepseek-official' and all(m in authorization['models'] for m in MODELS),'model authorization missing')
        transport = json.loads((ROOT/'evidence/P01/transport-decision.json').read_bytes())
        require(transport['status']=='confirmed' and transport['approved_base_url']==ORIGIN,'official TLS route not confirmed')
        require(bool(args.mock_evidence),'current mock evidence required')
        mock = json.loads(Path(args.mock_evidence).read_bytes())
        require(mock['passed'] and mock['mode']=='mock' and mock['code_bindings']==bindings,'mock evidence stale or failed')
        require(len(read_lines(LEDGER))+14<=18,'remaining initial request cap insufficient')
    helper = load_module('u09_globals',ROOT/'spikes/P01/run-no-key.py')
    probe = load_module('u09_lock',ROOT/'spikes/P01/probe.py')
    before = helper.globals_snapshot()+[{'label':'official-provider','sha256':sha(PROVIDER)}]
    run_id = args.mode+'-'+str(time.time_ns())
    output = EVIDENCE/'runs'/run_id
    output.mkdir(parents=True)
    (output/'ledger-before.jsonl').write_bytes(LEDGER.read_bytes())
    state = {'halted':False,'key':None}
    results = []
    from contextlib import nullcontext
    with probe.exclusive_real_run() if args.mode=='real' else nullcontext():
        for model in MODELS:
            for scenario in cases:
                if state['halted']:
                    results.append({'cell_id':model+'-'+scenario['id'],'status':'NOT_RUN','reason':'previous cell stopped matrix'})
                else:
                    results.append(run_cell(args.mode,model,scenario,output,state))
    state['key'] = None
    after = helper.globals_snapshot()+[{'label':'official-provider','sha256':sha(PROVIDER)}]
    (output/'ledger-after.jsonl').write_bytes(LEDGER.read_bytes())
    summary = {'mode':args.mode,'run_id':run_id,'passed':not state['halted'] and before==after and bindings==code_bindings(),
               'source_commit':PIN,'code_bindings':bindings,'code_unchanged':bindings==code_bindings(),
               'production_before':before,'production_after':after,'production_unchanged':before==after,
               'results':results,'generation_calls':sum(r.get('model_calls',0) for r in results),
               'runtime_kind':'actual pinned ZCode + accepted Xiadie host/Hook/context/projection',
               'DSH_started':False,'model_backend_independence':'not asserted','human_review':{'status':'not_reviewed'}}
    save(output/'summary.json',summary)
    print(json.dumps({'passed':summary['passed'],'summary':str(output/'summary.json'),'generation_calls':summary['generation_calls']}),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode',choices=['mock','real'])
    parser.add_argument('--mock-evidence')
    raise SystemExit(main(parser.parse_args()))
