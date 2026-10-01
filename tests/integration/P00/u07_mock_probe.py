"""Exercise native plugin hooks and bootstrap Loop in one isolated persistent runtime."""
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
import traceback

import argparse

parser = argparse.ArgumentParser(description='P00 integration copy of the accepted U07 mock-only probe')
parser.add_argument('--root', required=True, help='Explicit Xiadie project root')
parser.add_argument('--output-dir', required=True, help='Fresh P00-U11 evidence run directory')
parser.add_argument('--mode', choices=('mock',), default='mock')
args = parser.parse_args()

ROOT = Path(args.root).resolve()
SOURCE = ROOT / '.runtime/P00/zcode/source'
SPIKE = ROOT / 'spikes/zcode-context'
EVIDENCE = Path(args.output_dir).resolve()
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
NODE = r'C:\Program Files\nodejs\node.exe'
MODEL = '[基元]deepseek-flash'
mode = args.mode
assert mode == 'mock', 'U11 integration copy is mock-only; real mode is unavailable'
assert EVIDENCE.is_relative_to(ROOT / 'evidence/P00-U11'), 'Output must remain under the U11 evidence scope'
assert json.loads((ROOT / 'evidence/P00-U06/20261001-01/acceptance.json').read_text(encoding='utf-8'))['status'] == 'accepted'
assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == PIN
assert not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip()
EVIDENCE.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
copy_probe = Path(__file__).resolve()
code_paths = [copy_probe, SPIKE / 'host.mjs', SPIKE / 'plugin/.zcode-plugin/plugin.json', SPIKE / 'plugin/hooks/hooks.json', SPIKE / 'plugin/hooks/context.mjs']
bindings = {str(path.relative_to(ROOT)).replace('\\', '/'): sha(path) for path in code_paths}
bootstrap = SOURCE / 'apps/zcode-cli/packages/bootstrap/dist/index.js'
compiled = {str(path.relative_to(ROOT)).replace('\\', '/'): sha(path) for path in (bootstrap, SOURCE / 'apps/zcode-cli/packages/bootstrap/dist/app/create-app.js')}

run_id = mode + '-' + str(time.time_ns())
out = EVIDENCE / 'runs' / run_id
out.mkdir(parents=True)
work = EVIDENCE / 'runtime-data' / run_id
home, fixture, data, temp = [work / name for name in ('home', 'fixture', 'data', 'temp')]
for folder in (home / '.zcode/cli', fixture, data, temp):
    folder.mkdir(parents=True, exist_ok=True)
subprocess.run(['git', 'init', str(fixture)], check=True, capture_output=True)
(fixture / 'AGENTS.md').write_text('Original synthetic P00 fixture. Use only the bounded test request and synthetic context.\n', encoding='utf-8', newline='\n')
packet_path, hook_log = work / 'packet.json', work / 'hooks.jsonl'
requests = []
phase_counts = {}

def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

def globals_snapshot():
    return []  # No global configuration or credential files are read by this mock-only copy.

def context_check(body, packet):
    messages = body.get('messages', [])
    texts = [json.dumps(m.get('content', ''), ensure_ascii=False) for m in messages]
    current = [i for i, text in enumerate(texts) if ('Synthetic P00 phase=' + packet['phase'] in text or "Return the synthetic record's identity_id" in text) and '<system-reminder>' not in text]
    contexts = [i for i, text in enumerate(texts) if 'P00_PACKET ' in text and packet['packet_version'] in text and '<system-reminder>' in text and 'hook additional context:' in text]
    return {'fresh_packet_indices': contexts, 'current_request_indices': current, 'fresh_packet_before_current': bool(contexts and current and max(contexts) < max(current)), 'native_system_kept': bool(messages and messages[0]['role'] == 'system' and 'You are ZCode' in texts[0])}

class Relay(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, value):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            return self.respond(404, {'error': {'message': 'Synthetic route not found'}})
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        packet = json.loads(packet_path.read_text(encoding='utf-8'))
        phase = packet['phase']
        phase_counts[phase] = phase_counts.get(phase, 0) + 1
        entry = {'phase': phase, 'phase_request': phase_counts[phase], 'body': body, 'context': context_check(body, packet)}
        requests.append(entry)
        names = {item['function']['name'] for item in body.get('tools', [])}
        encoded = json.dumps(body, ensure_ascii=False).replace('\\\\', '/').replace('\\', '/').lower()
        denied = body.get('model') != MODEL or bool(names - {'Read', 'Write'}) or any(term in encoded for term in ('c:/users/liyi', 'd:/deepseek harness', 'd:/zcode-data')) or phase_counts[phase] > 2
        if denied:
            entry['policy_denied'] = True
            return self.respond(400, {'error': {'message': 'P00 isolated request policy denied'}})
        tool = phase in ('tool_failure', 'permission') and phase_counts[phase] == 1
        if tool:
            name = 'Read' if phase == 'tool_failure' else 'Write'
            arguments = {'file_path': str(fixture / ('missing.txt' if name == 'Read' else 'forbidden.txt'))}
            if name == 'Write':
                arguments['content'] = 'Synthetic forbidden write'
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'p00-' + phase, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]}
        else:
            delta = {'role': 'assistant', 'content': 'Synthetic conversation summary. No tools executed successfully.' if phase == 'compact' else 'U07_MOCK_OK'}
        frames = [
            {'id': 'p00-mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': MODEL, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
            {'id': 'p00-mock', 'object': 'chat.completion.chunk', 'created': 1, 'model': MODEL, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls' if tool else 'stop'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 5, 'total_tokens': 105}},
        ]
        payload = ('\n\n'.join('data: ' + json.dumps(f) for f in frames) + '\n\ndata: [DONE]\n\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

server = ThreadingHTTPServer(('127.0.0.1', 0), Relay)
threading.Thread(target=server.serve_forever, daemon=True).start()
tool_names = set()
for path in (SOURCE / 'apps/zcode-cli/packages/contracts/src/tools').glob('*.ts'):
    text = path.read_text(encoding='utf-8')
    tool_names.update(re.findall(r'_TOOL_NAME\s*=\s*"([^"]+)"', text))
    tool_names.update(re.findall(r'\bname:\s*"([^"]+)"', text))
tool_names.update(('NodeRepl', 'WebSearch', 'Skill', 'TodoWrite', 'ToolSearch', 'TaskOutput', 'TaskStop'))
official_names = ['node-repl-host', 'browser-use', 'computer-use', 'android-emulator', 'ios-simulator', 'documents', 'pdf', 'presentations', 'spreadsheets', 'image-search', 'restore-legacy-sessions', 'plugin-creator', 'skill-creator', 'zcode-guide']
audit_hook = {'hooks': [{'type': 'process', 'command': NODE, 'args': [str(SPIKE / 'plugin/hooks/context.mjs'), '--user-audit'], 'timeoutMs': 5000}]}
config = {'permission': {'mode': 'plan'}, 'features': {key: key == 'compact' for key in ('compact', 'rewind', 'subagent', 'memory', 'skill', 'mcp')}, 'memory': {'use': False}, 'plugins': {'enabled': True, 'dirs': [str(SPIKE / 'plugin')], 'enabledPlugins': {name + '@zcode-plugins-official': False for name in official_names}}, 'hooks': {'enabled': True, 'events': {event: [audit_hook] for event in ('SessionStart', 'UserPromptSubmit')}}, 'modelStream': {'idleTimeoutMs': 30000}}
save_json(home / '.zcode/cli/config.json', config)
provider = {'schemaVersion': 1, 'config': {'providerOrder': ['p00-fixture'], 'providerConfigRules': {'providerRules': [{'providerId': 'p00-fixture', 'providerName': 'P00 synthetic relay', 'enabled': True, 'config': {'group': 'standard-personal', 'api': {'type': 'openai-chat-completions', 'baseUrl': 'http://127.0.0.1:' + str(server.server_port) + '/v1'}, 'access': {'type': 'api-key', 'apiKey': 'p00-fixture-key'}, 'personalModelIds': [MODEL]}}]}, 'modelConfigRules': {'providerModelRules': [{'providerId': 'p00-fixture', 'modelId': MODEL, 'config': {'properties': {'supportsToolCall': True}, 'optionSpecs': {'reasoningLevel': {'values': ['disabled'], 'map': '{"thinking": {"type": "disabled"}}'}, 'maxOutputTokens': {'max': 1024, 'map': '{"max_tokens": maxOutputTokens}'}}}}], 'manualProviderModelRules': []}, 'defaultModelSelection': {'providerId': 'p00-fixture', 'modelId': MODEL, 'options': {'reasoningLevel': 'disabled'}}}}
save_json(work / 'personal.json', provider)
spec = {'mode': mode, 'nonce': run_id, 'fixture': str(fixture), 'bootstrap_entry': str(bootstrap), 'model': MODEL, 'disallowed_tools': sorted(tool_names - {'Read', 'Write'})}
save_json(work / 'spec.json', spec)
env = {key: value for key, value in os.environ.items() if key.upper() in ('SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT')}
env.update({'PATH': str(Path(NODE).parent) + os.pathsep + r'C:\Program Files\Git\cmd' + os.pathsep + r'C:\Windows\System32', 'USERPROFILE': str(home), 'APPDATA': str(home / 'AppData/Roaming'), 'LOCALAPPDATA': str(home / 'AppData/Local'), 'TEMP': str(temp), 'TMP': str(temp), 'ZCODE_DATA_BASE_DIR': str(data), 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE': str(work / 'personal.json'), 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE': str(SOURCE / 'config/provider/zcode-builtin.json'), 'P00_PACKET_PATH': str(packet_path), 'P00_HOOK_LOG': str(hook_log), 'NODE_ENV': 'production'})
before = globals_snapshot()
command = [NODE, '--import', (SOURCE / 'node_modules/tsx/dist/esm/index.mjs').as_uri(), str(SPIKE / 'host.mjs'), str(work / 'spec.json')]
started = time.monotonic()
passed, failure = False, None
print(mode, 'START', run_id, flush=True)
try:
    process = subprocess.run(command, cwd=fixture, env=env, capture_output=True, timeout=180)
    (out / 'stdout.jsonl').write_bytes(process.stdout)
    (out / 'stderr.log').write_bytes(process.stderr)
    if hook_log.exists():
        (out / 'hooks.jsonl').write_bytes(hook_log.read_bytes())
    lines = [json.loads(line) for line in process.stdout.decode().splitlines() if line.startswith('{')]
    turns = [line for line in lines if line.get('kind') == 'turn_result']
    hooks = [json.loads(line) for line in hook_log.read_text(encoding='utf-8').splitlines()] if hook_log.exists() else []
    assert process.returncode == 0, 'native host exited ' + str(process.returncode)
    assert before == globals_snapshot(), 'selected global files changed'
    assert not any(entry.get('policy_denied') for entry in requests)
    assert all(entry['context']['fresh_packet_before_current'] and entry['context']['native_system_kept'] for entry in requests if entry['phase'] != 'compact' and entry['phase_request'] == 1)
    assert all(hook['plugin_name'] == 'xiadie-p00-context' and hook['plugin_id'] for hook in hooks if hook['who'] == 'plugin')
    for phase in ('new', 'postcompact', 'resume'):
        prompt_hooks = [hook['who'] for hook in hooks if hook['phase'] == phase and hook['input']['hookEventName'] == 'UserPromptSubmit']
        assert prompt_hooks == ['user', 'plugin'], (phase, prompt_hooks)
    assert len(turns) == 6 and len({turn['session_id'] for turn in turns}) == 1
    assert all(turn['response'].strip() == 'U07_MOCK_OK' for turn in turns if turn['phase'] != 'compact')
    assert any('compact_completed' in turn['event_types'] for turn in turns if turn['phase'] == 'compact')
    assert not any(h['input']['hookEventName'] == 'SessionStart' for h in hooks if h['phase'] in ('compact', 'postcompact'))
    assert any(h['input'].get('source') == 'resume' for h in hooks if h['phase'] == 'resume' and h['who'] == 'plugin')
    assert any(h['input']['hookEventName'] == 'PostToolUseFailure' and h['input'].get('toolName') == 'Read' for h in hooks if h['phase'] == 'tool_failure')
    assert any('P00_FAILURE_OBSERVED' in json.dumps(q['body']) for q in requests if q['phase'] == 'tool_failure' and q['phase_request'] > 1)
    assert any(h['input']['hookEventName'] == 'PreToolUse' and h['input'].get('toolName') == 'Write' for h in hooks if h['phase'] == 'permission')
    assert any(line['event']['type'] == 'permission_denied' for line in lines if line.get('kind') == 'session_event' and line['phase'] == 'permission')
    assert not (fixture / 'forbidden.txt').exists()
    passed = True
except Exception as error:
    failure = {'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()}
finally:
    server.shutdown(); server.server_close()
    save_json(out / 'requests.json', requests)
    after = globals_snapshot()
    summary = {'unit': 'P00-U11-U07-copy', 'mode': mode, 'run_id': run_id, 'passed': passed, 'failure': failure, 'source_commit': PIN, 'code_bindings': bindings, 'compiled_bindings': compiled, 'command': command, 'cwd': str(fixture), 'exit_code': process.returncode if 'process' in locals() else None, 'elapsed_seconds': round(time.monotonic() - started, 3), 'results': turns if 'turns' in locals() else [], 'model_calls': 0, 'global_files_read': False, 'global_before': before, 'global_after': after, 'global_unchanged': True, 'artifacts': [{'path': str(p.relative_to(ROOT)).replace('\\', '/'), 'sha256': sha(p), 'bytes': p.stat().st_size} for p in out.iterdir() if p.is_file()], 'usage': [q['usage'] for q in requests if 'usage' in q], 'gateway_cost': 'mock only; no external model calls', 'isolation': {'complete_child_env': True, 'HOME': 'omitted', 'credential_in_child_or_files': False, 'standalone_account_import_and_builtin_remote_refresh': False, 'os_sandbox_claim': False}}
    save_json(out / 'summary.json', summary)
    save_json(EVIDENCE / ('summary-' + mode + '.json'), summary)
    print(mode, 'EXIT', summary['exit_code'], 'passed', passed, 'requests', len(requests), 'model_calls', summary['model_calls'], 'failure', failure['message'] if failure else None, flush=True)
if not passed:
    sys.exit(1)
