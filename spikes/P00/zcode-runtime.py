"""Pinned ZCode CLI against an isolated mock, then an authorized memory-only gateway relay."""
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

import httpx
import yaml

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / '.runtime/P00/zcode'
SOURCE = BASE / 'source'
EVIDENCE = ROOT / 'evidence/P00-U02/20261001-01'
MODEL = '[基元]deepseek-flash'
NODE = r'C:\Program Files\nodejs\node.exe'
CLI = SOURCE / 'apps/zcode-cli/packages/cli/dist/zcode.cjs'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == PIN
assert not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip()
runner_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
hook_hash = hashlib.sha256((ROOT / 'spikes/P00/zcode-hook.mjs').read_bytes()).hexdigest()
mode = sys.argv[1] if len(sys.argv) > 1 else 'mock'
assert mode in ('mock', 'real')
requests = []
tool_names = set()
for path in (SOURCE / 'apps/zcode-cli/packages/contracts/src/tools').glob('*.ts'):
    content = path.read_text(encoding='utf-8')
    tool_names.update(re.findall(r'_TOOL_NAME\s*=\s*"([^"]+)"', content))
    tool_names.update(re.findall(r'\bname:\s*"([^"]+)"', content))
tool_names.update(('NodeRepl', 'WebSearch', 'Skill', 'TodoWrite', 'ToolSearch', 'TaskOutput', 'TaskStop'))
relay_key = None
relay_endpoint = None
if mode == 'real':
    mock = json.loads((EVIDENCE / 'zcode-mock-summary.json').read_text(encoding='utf-8'))
    assert mock['passed'] and mock['model_calls'] == 0
    assert mock['source_commit'] == PIN
    assert mock['runner_sha256'] == runner_hash
    assert mock['hook_sha256'] == hook_hash
    assert mock['cli_sha256'] == hashlib.sha256(CLI.read_bytes()).hexdigest()
    settings = yaml.safe_load(Path(r'C:\Users\liyi\.dsh\settings.yaml').read_text(encoding='utf-8'))
    provider = settings['llm-pi-ai']['providers']['a7877']
    credentials = yaml.safe_load(Path(r'C:\Users\liyi\.dsh\.credentials.yaml').read_text(encoding='utf-8'))
    relay_key = credentials['refs'][provider['apiKeyEnv']]
    relay_endpoint = provider['baseURL'].rstrip('/')
    assert relay_endpoint == 'http://47.108.250.118:15555/v1'
    assert isinstance(relay_key, str) and relay_key

class Relay(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        entry = {'model': body.get('model'), 'body': body, 'mode': mode, 'received_at': time.time()}
        requests.append(entry)
        serial = len(requests)
        encoded = json.dumps(body, ensure_ascii=False)
        normalized = encoded.replace('\\\\', '/').replace('\\', '/').lower()
        hook_phrase = 'P00_CONTEXT: synthetic fixture only; requested marker P00_ZCODE_OK.'
        hook_messages = [message for message in body.get('messages', [])[:-1] if hook_phrase in json.dumps(message.get('content', ''), ensure_ascii=False) and '<system-reminder>' in json.dumps(message.get('content', ''), ensure_ascii=False) and 'hook additional context:' in json.dumps(message.get('content', ''), ensure_ascii=False)]
        hook_events = {event for event in ('SessionStart', 'UserPromptSubmit') if any(event + ' hook additional context:' in json.dumps(message.get('content', ''), ensure_ascii=False) for message in hook_messages)}
        entry['hook_context_messages'] = len(hook_messages)
        denied = (body.get('model') != MODEL or bool(body.get('tools')) or any(term in normalized for term in ('c:/users/liyi', 'd:/zcode-data', 'd:/deepseek harness')) or len(hook_messages) != 2 or len(hook_events) != 2 or not isinstance(body.get('max_tokens'), int) or not 1 <= body['max_tokens'] <= 1024)
        if denied or (mode == 'real' and serial > 3):
            entry['policy_denied'] = True
            self.respond(400, {'error': {'message': 'P00 isolated request policy denied', 'type': 'invalid_request_error'}})
            return
        if mode == 'mock' and self.server.case == 'failure':
            entry['injected_failure'] = True
            self.respond(400, {'error': {'message': 'P00_SYNTHETIC_FAILURE', 'type': 'invalid_request_error'}})
            return
        if mode == 'real':
            entry['upstream_attempted'] = True
            (EVIDENCE / 'model-call-ledger.json').write_text(json.dumps([{'model': item['model'], 'received_at': item['received_at'], 'upstream_attempted': item.get('upstream_attempted', False)} for item in requests], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            try:
                with httpx.Client(timeout=120, trust_env=False, follow_redirects=False) as client:
                    response = client.post(relay_endpoint + '/chat/completions', headers={'Authorization': 'Bearer ' + relay_key}, json=body)
            except httpx.HTTPError as error:
                entry['upstream_transport_error_type'] = type(error).__name__
                self.respond(502, {'error': {'message': 'P00 gateway transport error', 'type': 'gateway_error'}})
                return
            entry['upstream_status'] = response.status_code
            if response.status_code != 200:
                self.respond(response.status_code, {'error': {'message': 'P00 gateway returned HTTP ' + str(response.status_code), 'type': 'gateway_error'}})
                return
            payload = response.content
            entry['response_sha256'] = hashlib.sha256(payload).hexdigest()
            entry['response_bytes'] = len(payload)
            (EVIDENCE / ('zcode-real-response-' + str(serial) + '.sse')).write_bytes(payload)
            for line in payload.decode('utf-8').splitlines():
                if line.startswith('data: {'):
                    frame = json.loads(line[6:])
                    if frame.get('usage'):
                        entry['usage'] = frame['usage']
        else:
            frames = [
                {'id': 'p00-mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': MODEL, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'P00_ZCODE_OK'}, 'finish_reason': None}]},
                {'id': 'p00-mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': MODEL, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 5, 'total_tokens': 105}},
            ]
            payload = ('\n\n'.join('data: ' + json.dumps(frame) for frame in frames) + '\n\ndata: [DONE]\n\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def respond(self, status, value):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

server = ThreadingHTTPServer(('127.0.0.1', 0), Relay)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
cases = ['normal', 'failure', 'recovery'] if mode == 'mock' else ['normal']
results = []
hook_script = ROOT / 'spikes/P00/zcode-hook.mjs'
try:
    for case in cases:
        server.case = case
        run_root = BASE / ('runs-' + mode) / (case + '-' + str(time.time_ns()))
        home = run_root / 'home'
        fixture = run_root / 'fixture'
        data = run_root / 'data'
        temp = run_root / 'temp'
        for folder in (home / '.zcode/cli', fixture, data, temp):
            folder.mkdir(parents=True, exist_ok=True)
        if not (fixture / '.git').exists():
            subprocess.run(['git', 'init', str(fixture)], check=True, capture_output=True)
        (fixture / 'AGENTS.md').write_text('P00 synthetic fixture. Reply with the requested marker; do not use tools.\n', encoding='utf-8')
        hook_log = run_root / 'hooks.jsonl'
        hooks = {event: [{'hooks': [{'type': 'process', 'command': NODE, 'args': [str(hook_script), str(hook_log)], 'timeoutMs': 5000}]}] for event in ('SessionStart', 'UserPromptSubmit')}
        config = {'permission': {'mode': 'plan'}, 'features': {key: False for key in ('compact', 'rewind', 'subagent', 'memory', 'skill', 'mcp')}, 'memory': {'use': False}, 'plugins': {'enabled': False}, 'hooks': {'enabled': True, 'events': hooks}, 'modelStream': {'idleTimeoutMs': 30000}}
        (home / '.zcode/cli/config.json').write_text(json.dumps(config), encoding='utf-8')
        provider_path = run_root / 'personal.json'
        provider = {'schemaVersion': 1, 'config': {'providerOrder': ['p00-fixture'], 'providerConfigRules': {'providerRules': [{'providerId': 'p00-fixture', 'providerName': 'P00 synthetic relay', 'enabled': True, 'config': {'group': 'standard-personal', 'api': {'type': 'openai-chat-completions', 'baseUrl': 'http://127.0.0.1:' + str(server.server_port) + '/v1'}, 'access': {'type': 'api-key', 'apiKey': 'p00-fixture-key'}, 'personalModelIds': [MODEL]}}]}, 'modelConfigRules': {'providerModelRules': [{'providerId': 'p00-fixture', 'modelId': MODEL, 'config': {'properties': {'supportsToolCall': True}, 'optionSpecs': {'reasoningLevel': {'values': ['disabled'], 'map': '{"thinking": {"type": "disabled"}}'}, 'maxOutputTokens': {'max': 1024, 'map': '{"max_tokens": maxOutputTokens}'}}}}], 'manualProviderModelRules': []}, 'defaultModelSelection': {'providerId': 'p00-fixture', 'modelId': MODEL, 'options': {'reasoningLevel': 'disabled'}}}}
        provider_path.write_text(json.dumps(provider, ensure_ascii=False), encoding='utf-8')
        env = {key: value for key, value in os.environ.items() if key.upper() in ('SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT')}
        env.update({'PATH': str(Path(NODE).parent) + os.pathsep + r'C:\Program Files\Git\cmd' + os.pathsep + r'C:\Windows\System32', 'USERPROFILE': str(home), 'APPDATA': str(home / 'AppData/Roaming'), 'LOCALAPPDATA': str(home / 'AppData/Local'), 'TEMP': str(temp), 'TMP': str(temp), 'ZCODE_DATA_BASE_DIR': str(data), 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE': str(provider_path), 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE': str(SOURCE / 'config/provider/zcode-builtin.json'), 'NODE_ENV': 'production'})
        command = [NODE, str(CLI), '--cwd', str(fixture), '--mode', 'plan', '--disallowed-tools', ','.join(sorted(tool_names)), '--output-format', 'stream-json', '--prompt', 'This is a synthetic P00 integration test. Read the P00_CONTEXT marker supplied by hooks. Reply exactly P00_ZCODE_OK. No tools.']
        print(mode, case, 'START', flush=True)
        start_count = len(requests)
        started = time.monotonic()
        try:
            process = subprocess.run(command, cwd=fixture, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
            result = {'case': case, 'command': command, 'cwd': str(fixture), 'exit_code': process.returncode, 'elapsed_seconds': round(time.monotonic() - started, 3), 'request_count': len(requests) - start_count}
            result['config_sha256'] = hashlib.sha256((home / '.zcode/cli/config.json').read_bytes()).hexdigest()
            result['personal_fixture_sha256'] = hashlib.sha256(provider_path.read_bytes()).hexdigest()
            for suffix, payload in (('stdout', process.stdout), ('stderr', process.stderr)):
                path = EVIDENCE / ('zcode-' + mode + '-' + case + '-' + suffix + '.log')
                path.write_bytes(payload)
                result[suffix] = {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)}
            events = [json.loads(line) for line in process.stdout.decode('utf-8').splitlines() if line.strip().startswith('{')]
            result['events_last'] = events[-1] if events else None
            result['marker_present'] = any(event.get('response', '').strip() == 'P00_ZCODE_OK' for event in events if isinstance(event.get('response'), str))
            result['failure_present'] = b'P00_SYNTHETIC_FAILURE' in process.stdout + process.stderr
            if hook_log.exists():
                payload = hook_log.read_bytes()
                path = EVIDENCE / ('zcode-' + mode + '-' + case + '-hooks.jsonl')
                path.write_bytes(payload)
                result['hooks'] = {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(payload).hexdigest()}
            results.append(result)
            print(mode, case, 'EXIT', process.returncode, 'requests', result['request_count'], 'marker', result['marker_present'], flush=True)
        except subprocess.TimeoutExpired as error:
            results.append({'case': case, 'timed_out': True, 'request_count': len(requests) - start_count})
            print(mode, case, 'TIMEOUT', flush=True)
            break
finally:
    server.shutdown()
    server.server_close()
    request_path = EVIDENCE / ('zcode-' + mode + '-requests.json')
    request_path.write_text(json.dumps(requests, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    passed = len(results) == len(cases) and all(item.get('exit_code') == 0 and item.get('marker_present') and item.get('request_count', 0) > 0 for item in results if item['case'] != 'failure') and all(item.get('exit_code') not in (None, 0) and item.get('failure_present') and not item.get('marker_present') and item.get('request_count', 0) > 0 for item in results if item['case'] == 'failure') and not any(item.get('policy_denied') for item in requests)
    summary = {'source_commit': PIN, 'source_tree_clean': True, 'cli_sha256': hashlib.sha256(CLI.read_bytes()).hexdigest(), 'runner_sha256': runner_hash, 'hook_sha256': hook_hash, 'mode': mode, 'passed': passed, 'recovery_scope': 'fresh CLI process and fresh fixture after injected model HTTP400; no same-session recovery claim', 'results': results, 'model_calls': sum(item.get('upstream_attempted', False) for item in requests), 'request_count': len(requests), 'request_artifact': {'path': str(request_path.relative_to(ROOT)), 'sha256': hashlib.sha256(request_path.read_bytes()).hexdigest()}, 'cost': 'gateway billing not returned; no monetary estimate' if mode == 'real' else '0; mock only', 'isolation': {'HOME': 'omitted', 'USERPROFILE': 'per-case synthetic home', 'cwd': 'per-case fixture with own Git root', 'real_credential_in_child': False, 'real_credential_persisted': False}}
    (EVIDENCE / ('zcode-' + mode + '-summary.json')).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('SUMMARY', mode, 'passed', passed, flush=True)
    if not passed:
        sys.exit(1)
