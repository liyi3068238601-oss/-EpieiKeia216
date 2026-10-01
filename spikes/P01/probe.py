"""Native ZCode plugin/Loop PoC: synthetic tools first, authorized routes later."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import msvcrt
from contextlib import contextmanager

import httpx

from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.runtime/P00/zcode/source'
SPIKE = ROOT / 'spikes/P01'
EVIDENCE = ROOT / 'evidence/P01-U02/20261001-01'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
NODE = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
MODELS = ['deepseek-flash', 'deepseek-v4-pro']
OFFICIAL_PROVIDER_CONFIG = Path(r'C:\Users\liyi\.zcode\v2\provider_config.json')
CODE = ['probe.py', 'host.mjs', 'plugin/.zcode-plugin/plugin.json', 'plugin/hooks/hooks.json', 'plugin/hooks/context.mjs']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def require(condition, message):
    # Authorization and execution preconditions must survive Python -O.
    if not condition:
        raise PermissionError(message)


def completed_read_tool_ids(frames, payload):
    if b'data: [DONE]' not in payload.splitlines() or not any(c.get('finish_reason') == 'tool_calls' for f in frames for c in f.get('choices', [])):
        return set()
    calls = {}
    for frame in frames:
        for choice in frame.get('choices', []):
            if choice.get('index', 0) != 0:
                return set()
            for delta in choice.get('delta', {}).get('tool_calls', []):
                index = delta.get('index')
                if not isinstance(index, int) or index < 0:
                    return set()
                call = calls.setdefault(index, {'id': '', 'type': '', 'name': ''})
                for field in ('id', 'type'):
                    if delta.get(field):
                        if call[field] and call[field] != delta[field]:
                            return set()
                        call[field] = delta[field]
                call['name'] += delta.get('function', {}).get('name', '')
    if not calls or any(c['type'] != 'function' or c['name'] != 'Read' or not c['id'] for c in calls.values()):
        return set()
    ids = {c['id'] for c in calls.values()}
    return ids if len(ids) == len(calls) else set()


def native_tool_continuation(ids, messages, receipts, phase):
    returned = {m.get('tool_call_id') for m in messages if m.get('role') == 'tool'}
    observed = {r.get('tool_call_id') for r in receipts
                if r.get('phase') == phase and r.get('tool_name') == 'Read'
                and r.get('event_type') in ('tool_call_result', 'tool_call_error', 'hook_run_blocked')}
    return bool(ids) and ids <= returned and ids <= observed


helper_spec = spec_from_file_location('p01_no_key_helper', SPIKE / 'run-no-key.py')
helper = module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)


@contextmanager
def exclusive_real_run():
    # A Windows process lock protects the shared stage budget across invocations.
    path = ROOT / '.runtime/P01/model-run.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as lock:
        if path.stat().st_size == 0:
            lock.write(b'0'); lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def run(mode, model):
    require(json.loads((ROOT / 'evidence/P01-U01/20261001-01/acceptance.json').read_text(encoding='utf-8'))['status'] == 'accepted', 'P01-U01 is not accepted')
    require(subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == PIN, 'ZCode source pin changed')
    require(not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip(), 'ZCode source is not clean')
    code = {p: sha(SPIKE / p) for p in CODE}
    key = url = None
    if mode == 'real':
        auth = json.loads((ROOT / 'evidence/P01/authorization.json').read_text(encoding='utf-8'))
        require(auth['status'] == 'authorized' and auth['provider'] == 'deepseek-official' and model in auth['models'], 'P01 model is not authorized')
        transport = json.loads((ROOT / 'evidence/P01/transport-decision.json').read_text(encoding='utf-8'))
        require(transport['status'] == 'confirmed', 'Model transport choice is pending; no credentials may be loaded or sent')
        require(__debug__, 'P01 integration probes require assertion validation; optimized execution is unsupported')
        ui = json.loads((EVIDENCE / 'summary-no-key-ui.json').read_text(encoding='utf-8'))
        require(ui['passed'], 'Real generation follows actual no-Key settings UI proof')
        mock = json.loads((EVIDENCE / 'summary-mock.json').read_text(encoding='utf-8'))
        require(mock['passed'] and mock.get('python_assertions_enabled') is True and mock['code_bindings'] == code, 'Current native mock evidence is missing or stale')
        url = transport['approved_base_url'].rstrip('/')
        require(url == 'https://api.deepseek.com' and transport['provider'] == 'deepseek-official', 'Official HTTPS transport is not approved')
        providers = json.loads(OFFICIAL_PROVIDER_CONFIG.read_text(encoding='utf-8'))['config']['providerConfigRules']['providerRules']
        matching = [p['config'] for p in providers if p.get('config', {}).get('api', {}).get('baseUrl', '').rstrip('/') == url]
        require(len(matching) == 1 and matching[0]['api']['type'] == 'openai-chat-completions', 'Official provider is missing or ambiguous')
        key = matching[0].get('access', {}).get('apiKey')
        require(isinstance(key, str) and bool(key), 'Official credential is unavailable')
    else:
        require(__debug__, 'P01 integration probes require assertion validation; optimized execution is unsupported')
    run_id = mode + '-' + str(time.time_ns())
    work = ROOT / '.runtime/P01' / run_id
    out = EVIDENCE / 'runs' / run_id
    out.mkdir(parents=True)
    home, fixture, data, temp = [work / n for n in ('home', 'fixture', 'data', 'temp')]
    for p in (home / '.zcode/cli', fixture, data, temp, work / 'outside'):
        p.mkdir(parents=True)
    subprocess.run(['git', 'init', str(fixture)], check=True, capture_output=True)
    (fixture / 'readme.txt').write_text('P01_ONLY_READ_VALUE=orchid-42\n', encoding='utf-8')
    (fixture / 'AGENTS.md').write_text('Original P01 synthetic fixture. Do not read outside this fixture.\n', encoding='utf-8')
    (work / 'outside/canary.txt').write_text('P01_OUTSIDE_CANARY_MUST_NOT_BE_READ', encoding='utf-8')
    junction = fixture / 'junction'
    # Only create a new junction inside this fresh, owned workspace; no recursive delete.
    ps = "New-Item -ItemType Junction -Path '" + str(junction).replace("'", "''") + "' -Target '" + str(work / 'outside').replace("'", "''") + "' | Out-Null"
    subprocess.run(['powershell', '-NoProfile', '-Command', ps], check=True, capture_output=True)
    packet, hook_log = work / 'packet.json', work / 'hooks.jsonl'
    native_receipt_file = work / 'native-tool-receipts.jsonl'
    ledger = ROOT / 'evidence/P01/model-calls.jsonl'
    requests = []
    counts = {}
    request_lock = threading.Lock()
    first_response_tools = {}

    class Relay(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers(); self.wfile.write(data)

        def do_POST(self):
            with request_lock:
                return self.handle_post()

        def handle_post(self):
            if self.path != '/v1/chat/completions':
                return self.respond(404, {'error': {'message': 'P01 synthetic route missing'}})
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            phase = json.loads(packet.read_text(encoding='utf-8'))['phase']
            counts[phase] = counts.get(phase, 0) + 1
            names = {t['function']['name'] for t in body.get('tools', [])}
            text = json.dumps(body, ensure_ascii=False)
            entry = {'phase': phase, 'phase_request': counts[phase], 'body': body,
                     'native_system_kept': bool(body.get('messages') and body['messages'][0]['role'] == 'system' and 'You are ZCode' in str(body['messages'][0]['content'])),
                     'role_context_present': 'P01_ROLE_CONTEXT' in text and 'P01-research-v3' in text,
                     'provider_tools': sorted(names)}
            requests.append(entry)
            normalized = text.replace('\\\\', '/').replace('\\', '/').lower()
            denied = body.get('model') != model or bool(names - {'Read'}) or counts[phase] > 2
            denied |= any(t in normalized for t in ('c:/users/liyi', 'd:/mofox', 'd:/deepseek harness', 'd:/zcode-data'))
            if phase != 'disabled':
                denied |= not entry['role_context_present']
            else:
                denied |= entry['role_context_present']
            if denied:
                entry['policy_denied'] = True
                return self.respond(400, {'error': {'message': 'P01 isolated request policy denied'}})
            if counts[phase] == 2:
                receipts = [json.loads(s) for s in native_receipt_file.read_text(encoding='utf-8').splitlines()] if native_receipt_file.exists() else []
                if not native_tool_continuation(first_response_tools.get(phase, set()), body.get('messages', []), receipts, phase):
                    entry['policy_denied'] = True
                    return self.respond(400, {'error': {'message': 'P01 replay rejected: no observed native Read continuation'}})
                entry['native_continuation_verified'] = True
            if mode == 'real':
                used = len(ledger.read_text(encoding='utf-8').splitlines()) if ledger.exists() else 0
                if used >= 18 or not isinstance(body.get('max_tokens'), int) or not 1 <= body['max_tokens'] <= 1024:
                    entry['policy_denied'] = True
                    return self.respond(400, {'error': {'message': 'P01 authorized request cap reached'}})
                event = {'attempt': used + 1, 'run_id': run_id, 'provider': 'deepseek-official', 'model': model, 'stage': 'P01-U02', 'status': 'attempted; external outcome may be unknown', 'timestamp': time.time()}
                with ledger.open('a', encoding='utf-8', newline='\n') as f:
                    f.write(json.dumps(event, ensure_ascii=False) + '\n'); f.flush(); os.fsync(f.fileno())
                entry['upstream_attempted'] = True
                try:
                    with httpx.Client(timeout=120, trust_env=False, follow_redirects=False) as client:
                        response = client.post(url + '/chat/completions', headers={'Authorization': 'Bearer ' + key}, json=body)
                except httpx.HTTPError as e:
                    entry['upstream_error_type'] = type(e).__name__
                    return self.respond(400, {'error': {'message': 'P01 transport failed; paid retry not authorized'}})
                entry['upstream_status'] = response.status_code
                if response.status_code != 200:
                    return self.respond(400, {'error': {'message': 'P01 gateway HTTP ' + str(response.status_code)}})
                payload = response.content
                if key.encode() in payload:
                    return self.respond(400, {'error': {'message': 'P01 response rejected by secret check'}})
                (out / f'response-{len(requests)}.sse').write_bytes(payload)
                frames = []
                for line in payload.decode('utf-8').splitlines():
                    if line.startswith('data: {'):
                        frame = json.loads(line[6:])
                        frames.append(frame)
                        if frame.get('usage'):
                            entry['usage'] = frame['usage']
                entry['response_model_ids'] = sorted({f['model'] for f in frames if isinstance(f.get('model'), str)})
                entry['response_sha256'] = hashlib.sha256(payload).hexdigest()
            else:
                tool = phase != 'compact' and counts[phase] == 1
                target = fixture / 'readme.txt'
                if phase == 'read-fail': target = fixture / 'missing.txt'
                if phase == 'scope-denied': target = work / 'outside/canary.txt'
                if phase == 'symlink-denied': target = junction / 'canary.txt'
                delta = {'role': 'assistant'}
                if tool:
                    delta['tool_calls'] = [{'index': 0, 'id': 'p01-' + phase, 'type': 'function', 'function': {'name': 'Read', 'arguments': json.dumps({'file_path': str(target)})}}]
                else:
                    delta['content'] = 'Synthetic summary of fixture-only work.' if phase == 'compact' else ('This read failed or was denied; it is not complete.' if phase in ('read-fail','scope-denied','symlink-denied') else 'Fixture value: orchid-42.')
                frames = [{'id': 'p01-mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': model, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                          {'id': 'p01-mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if tool else 'stop'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 8, 'total_tokens': 108}}]
                payload = ('\n\n'.join('data: ' + json.dumps(f) for f in frames) + '\n\ndata: [DONE]\n\n').encode()
            if counts[phase] == 1:
                first_response_tools[phase] = completed_read_tool_ids(frames, payload)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers(); self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Relay)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tool_names = set()
    for p in (SOURCE / 'apps/zcode-cli/packages/contracts/src/tools').glob('*.ts'):
        text = p.read_text(encoding='utf-8')
        tool_names.update(re.findall(r'_TOOL_NAME\s*=\s*"([^"]+)"', text))
        tool_names.update(re.findall(r'\bname:\s*"([^"]+)"', text))
    tool_names.update(('NodeRepl','WebSearch','Skill','TodoWrite','ToolSearch','TaskOutput','TaskStop'))
    official = ['node-repl-host','browser-use','computer-use','android-emulator','ios-simulator','documents','pdf','presentations','spreadsheets','image-search','restore-legacy-sessions','plugin-creator','skill-creator','zcode-guide']
    user_config = home / '.zcode/cli/config.json'
    save(user_config, {'permission': {'mode': 'plan'}, 'features': {k: k == 'compact' for k in ('compact','rewind','subagent','memory','skill','mcp')},
                       'memory': {'use': False}, 'plugins': {'enabled': True, 'dirs': [str(SPIKE / 'plugin')], 'enabledPlugins': {n + '@zcode-plugins-official': False for n in official}},
                       'hooks': {'enabled': True}, 'modelStream': {'idleTimeoutMs': 120000}})
    personal = work / 'personal.json'
    provider = {'schemaVersion': 1, 'config': {'providerOrder': ['p01-fixture'], 'providerConfigRules': {'providerRules': [{'providerId': 'p01-fixture', 'providerName': 'P01 synthetic relay', 'enabled': True, 'config': {'group': 'standard-personal', 'api': {'type': 'openai-chat-completions', 'baseUrl': 'http://127.0.0.1:' + str(server.server_port) + '/v1'}, 'access': {'type': 'api-key', 'apiKey': 'p01-fixture-only'}, 'personalModelIds': [model]}}]},
                'modelConfigRules': {'providerModelRules': [{'providerId': 'p01-fixture', 'modelId': model, 'config': {'properties': {'supportsToolCall': True}, 'optionSpecs': {'reasoningLevel': {'values': ['disabled'], 'map': '{"thinking":{"type":"disabled"}}'}, 'maxOutputTokens': {'max': 1024, 'map': '{"max_tokens":maxOutputTokens}'}}}}], 'manualProviderModelRules': []},
                'defaultModelSelection': {'providerId': 'p01-fixture', 'modelId': model, 'options': {'reasoningLevel': 'disabled'}}}}
    save(personal, provider)
    role_path = ROOT / 'docs/research/P01/persona-from-mofox-v3.md'
    ledger_versions = json.loads((ROOT / 'docs/research/P01/persona-versions.json').read_text(encoding='utf-8'))
    require(sha(role_path) == ledger_versions['versions'][-1]['sha256'], 'Approved persona hash changed')
    role = role_path.read_text(encoding='utf-8').split('## 建议采用的核心人设\n', 1)[1].split('## 虚构风格示例', 1)[0]
    spec = {'mode': mode, 'model': model, 'fixture': str(fixture), 'home': str(home), 'role': role,
            'user_config': str(user_config), 'project_config': str(fixture / '.zcode/config.json'),
            'bootstrap': str(SOURCE / 'apps/zcode-cli/packages/bootstrap/dist/index.js'),
            'fs_adapter': str(SOURCE / 'apps/zcode-cli/packages/adapters/dist/fs/index.js'),
            'contracts': str(SOURCE / 'apps/zcode-cli/packages/contracts/dist/index.js'),
            'disallowed_tools': sorted(tool_names - {'Read'})}
    save(work / 'spec.json', spec)
    env = {k: v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC','PATHEXT')}
    env.update({'PATH': str(NODE.parent) + os.pathsep + r'C:\Program Files\Git\cmd' + os.pathsep + r'C:\Windows\System32', 'USERPROFILE': str(home), 'APPDATA': str(home / 'AppData/Roaming'), 'LOCALAPPDATA': str(home / 'AppData/Local'), 'TEMP': str(temp), 'TMP': str(temp),
                'ZCODE_DATA_BASE_DIR': str(data), 'ZCODE_SESSION_DB_PATH': str(work / 'sessions.sqlite'),
                'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE': str(personal), 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE': str(SOURCE / 'config/provider/zcode-builtin.json'),
                'P01_PACKET_PATH': str(packet), 'P01_HOOK_LOG': str(hook_log), 'P01_NATIVE_TOOL_RECEIPTS': str(native_receipt_file), 'NODE_ENV': 'production'})
    command = [str(NODE), '--import', (SOURCE / 'node_modules/tsx/dist/esm/index.mjs').as_uri(), str(SPIKE / 'host.mjs'), str(work / 'spec.json')]
    before = helper.globals_snapshot() + [{'label': 'production-official-provider', 'exists': OFFICIAL_PROVIDER_CONFIG.exists(), 'sha256': sha(OFFICIAL_PROVIDER_CONFIG)}]
    started = time.monotonic(); failure = None; passed = False
    try:
        proc = subprocess.run(command, cwd=fixture, env=env, capture_output=True, timeout=400)
        (out / 'stdout.jsonl').write_bytes(proc.stdout); (out / 'stderr.bin').write_bytes(proc.stderr)
        if hook_log.exists(): (out / 'hooks.jsonl').write_bytes(hook_log.read_bytes())
        if native_receipt_file.exists(): (out / 'native-tool-receipts.jsonl').write_bytes(native_receipt_file.read_bytes())
        assert proc.returncode == 0, 'Native host process failed'
        events = [json.loads(s) for s in proc.stdout.decode('utf-8').splitlines() if s.startswith('{')]
        turns = [e for e in events if e.get('type') == 'turn_result']
        by_phase = {e['phase']: e for e in turns}
        phases = ['read-ok','read-fail','scope-denied','symlink-denied','compact','resume','disabled'] if mode == 'mock' else ['real-read']
        assert list(by_phase) == phases
        for phase in phases:
            if phase == 'compact':
                assert any(e['event_type'] == 'compact_completed' for e in by_phase[phase]['observed_events'])
                continue
            success = phase not in ('read-fail','scope-denied','symlink-denied')
            tool_events = [e for e in by_phase[phase]['observed_events'] if e['event_type'] in ('tool_call_result','tool_call_error','hook_run_blocked') and e.get('tool_call_id')]
            assert tool_events, phase + ': missing native tool evidence'
            native_success = any(e.get('result', {}).get('success') is True for e in tool_events)
            assert native_success == success, phase
            assert any(e['event_type'] == 'turn_complete' for e in by_phase[phase]['observed_events']), phase + ': native turn incomplete'
            assert by_phase[phase]['response'], phase + ': empty assistant response'
            if phase == 'scope-denied':
                assert any(e['event_type'] == 'hook_run_blocked' for e in tool_events)
            if phase == 'symlink-denied':
                assert any(e['event_type'] == 'tool_call_error' and e.get('error_type') == 'FileSystemPortError' for e in tool_events)
        hooks = [json.loads(s) for s in hook_log.read_text(encoding='utf-8').splitlines()] if hook_log.exists() else []
        if mode == 'mock':
            assert by_phase['read-ok']['session_id'] == by_phase['resume']['session_id']
            # This pinned Hook exports a temporary per-event transcript, not the
            # restored session history. Prove persistence from the native request.
            assert any(h['phase'] == 'resume' and h['event'] == 'SessionStart' for h in hooks), 'resume SessionStart Hook missing'
            resumed = next(q for q in requests if q['phase'] == 'resume')
            assert 'Synthetic summary of fixture-only work.' in json.dumps(resumed['body']), 'native resume did not hydrate persisted compact summary'
            assert not any(h['phase'] == 'disabled' for h in hooks), 'disabled plugin still invoked Hook'
            assert all(any(h['phase'] == phase and h['event'] == 'UserPromptSubmit' for h in hooks) for phase in phases if phase not in ('disabled','compact')), 'per-turn role Hook missing'
        assert (work / 'outside/canary.txt').read_text(encoding='utf-8') == 'P01_OUTSIDE_CANARY_MUST_NOT_BE_READ'
        assert all('P01_OUTSIDE_CANARY_MUST_NOT_BE_READ' not in json.dumps(e) for e in events)
        assert all(q['native_system_kept'] and not q.get('policy_denied') for q in requests)
        if mode == 'real':
            assert 'orchid-42' in by_phase['real-read']['response'], 'real assistant did not report the actual fixture value'
            assert '遐蝶' in by_phase['real-read']['response'], 'real assistant did not use the approved role identity'
            assert key not in proc.stdout.decode('utf-8') and key not in proc.stderr.decode('utf-8'), 'secret output rejected'
        passed = True
    except Exception as e:
        failure = {'type': type(e).__name__, 'message': str(e)}
    finally:
        server.shutdown(); server.server_close()
        save(out / 'requests.json', requests)
        after = helper.globals_snapshot() + [{'label': 'production-official-provider', 'exists': OFFICIAL_PROVIDER_CONFIG.exists(), 'sha256': sha(OFFICIAL_PROVIDER_CONFIG)}]
        summary = {'mode': mode, 'model': model, 'run_id': run_id, 'passed': passed and before == after, 'python_assertions_enabled': __debug__,
                   'failure': failure, 'source_commit': PIN, 'code_bindings': code, 'role_sha256': sha(role_path),
                   'command': command, 'cwd': str(fixture), 'exit_code': proc.returncode if 'proc' in locals() else None,
                   'elapsed_seconds': round(time.monotonic()-started,3), 'production_unchanged': before == after,
                   'production_before': before, 'production_after': after,
                   'turns': turns if 'turns' in locals() else [], 'model_calls': sum(bool(q.get('upstream_attempted')) for q in requests),
                   'usage': [q['usage'] for q in requests if q.get('usage')], 'gateway_cost': 'not returned by official API; usage recorded' if mode == 'real' else 'no paid model calls',
                   'runtime_kind': 'actual pinned ZCode bootstrap, provider, plugin Hook, Loop, executor and SQLite; mock/real provider recorded separately',
                   'artifacts': [{'path': p.relative_to(ROOT).as_posix(), 'bytes': p.stat().st_size, 'sha256': sha(p)} for p in out.iterdir() if p.is_file()]}
        save(out / 'summary.json', summary)
        save(EVIDENCE / ('summary-mock.json' if mode == 'mock' else 'summary-real-' + ('flash' if model == MODELS[0] else 'pro') + '.json'), summary)
        print(json.dumps({'run_id':run_id,'passed':summary['passed'],'exit_code':summary['exit_code'],'model_calls':summary['model_calls'],'failure':failure},ensure_ascii=False),flush=True)
    return summary['passed']


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv)>1 else 'mock'
    require(mode in ('mock','real'), 'Unknown P01 probe mode')
    model = MODELS[int(sys.argv[2])] if len(sys.argv)>2 else MODELS[0]
    if mode == 'real':
        with exclusive_real_run():
            passed = run(mode, model)
    else:
        passed = run(mode, model)
    raise SystemExit(0 if passed else 1)
