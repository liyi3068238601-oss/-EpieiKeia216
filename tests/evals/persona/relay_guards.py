"""Deterministic gates for the P01 synthetic evaluation transport."""
import hashlib
import json
import os
from pathlib import Path

ASSET_SHA = 'a688c669c4f556495131ac69cdc868a5b2ee93614eff814fc0793b1690c99bb4'
MODELS = ('deepseek-flash', 'deepseek-v4-pro')


class GuardRejection(PermissionError):
    """A fixed diagnostic produced by our own deterministic validation."""


def require(condition, message):
    if not condition:
        raise GuardRejection(message)


def safe_failure_message(error):
    # OS PermissionError may contain a filename or other external text.
    return str(error) if type(error) is GuardRejection else 'transport or parsing failure'


def message_text(messages):
    parts = []
    for message in messages:
        content = message.get('content')
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(p['text'] for p in content if isinstance(p, dict) and isinstance(p.get('text'), str))
    return '\n'.join(parts)


def validate_request(body, model, scenario, index, context, receipts, first_ids):
    require(model in MODELS and body.get('model') == model, 'model not authorized')
    require(body.get('stream') is True, 'streaming required')
    require(body.get('thinking') == {'type': 'disabled'}, 'hidden reasoning disabled')
    require(type(body.get('max_tokens')) is int and 1 <= body['max_tokens'] <= 1024, 'output cap invalid')
    require(1 <= index <= scenario['max_requests'], 'scenario request cap exceeded')
    require(context.get('scenario_id') == scenario['id'] and context.get('request_index') == index,
            'native delegation observation missing or stale')
    packet = context.get('canonical_packet')
    receipt = context.get('receipt', {})
    require(isinstance(packet, str) and packet, 'approved packet missing')
    require(receipt.get('character', {}).get('contentSha256') == ASSET_SHA, 'wrong runtime character asset')
    require(receipt.get('character', {}).get('id') == 'xiadie' and receipt.get('character', {}).get('version') == 'v3', 'wrong character version')
    require(receipt.get('event') == 'UserPromptSubmit' and receipt.get('version') == 1 and bool(receipt.get('nonce')), 'native Hook receipt missing')
    require(receipt.get('packetSha256') == hashlib.sha256(packet.encode()).hexdigest(), 'packet receipt mismatch')
    require(bool(context.get('session_id')) and bool(context.get('turn_id')) and
            receipt.get('sessionId') == context['session_id'] and receipt.get('turnId') == context['turn_id'],
            'Hook session or turn mismatch')
    messages = body.get('messages', [])
    require(bool(messages) and messages[0].get('role') == 'system' and 'ZCode' in str(messages[0].get('content')), 'native system missing')
    text = message_text(messages)
    require(packet in text, 'approved packet not present in native request')
    normalized = text.replace('\\', '/').lower()
    require(not any(x in normalized for x in ('c:/users/liyi', 'd:/mofox', 'd:/zcode-data', 'd:/deepseek harness')), 'private production path detected')
    tools = body.get('tools', [])
    require(all(t.get('type') == 'function' and t.get('function', {}).get('name') == 'Read' for t in tools), 'non-Read tool denied')
    if index == 1:
        require(not any(m.get('role') == 'tool' for m in messages), 'fresh session contains tool replay')
        return
    require(index == 2 and len(first_ids) == 1 and scenario.get('target'), 'only one native Read continuation allowed')
    returned = {m.get('tool_call_id') for m in messages if m.get('role') == 'tool'}
    require(returned == first_ids, 'continuation tool IDs differ')
    matching = [r for r in receipts if r.get('scenario_id') == scenario['id'] and
                r.get('session_id') == context['session_id'] and r.get('turn_id') == context['turn_id'] and
                r.get('tool_call_id') in first_ids and r.get('tool_name') == 'Read' and
                r.get('event_type') in ('tool_call_result', 'tool_call_error', 'hook_run_blocked')]
    require({r['tool_call_id'] for r in matching} == first_ids, 'native terminal receipt missing')
    expected_success = scenario['id'] == 'technical_read'
    require(all((r.get('event_type') == 'tool_call_result' and r.get('result_success') is True) == expected_success for r in matching),
            'native tool outcome differs from scenario')


def completed_read_calls(frames, payload):
    if b'data: [DONE]' not in payload.splitlines():
        return set()
    if not any(c.get('finish_reason') == 'tool_calls' for f in frames for c in f.get('choices', [])):
        return set()
    calls = {}
    for frame in frames:
        for choice in frame.get('choices', []):
            if choice.get('index', 0) != 0:
                return set()
            for item in choice.get('delta', {}).get('tool_calls', []):
                i = item.get('index')
                if type(i) is not int or i < 0:
                    return set()
                call = calls.setdefault(i, {'id':'', 'type':'', 'name':''})
                for field in ('id', 'type'):
                    if item.get(field):
                        if call[field] and call[field] != item[field]:
                            return set()
                        call[field] = item[field]
                call['name'] += item.get('function', {}).get('name', '')
    if not calls or any(x['type'] != 'function' or x['name'] != 'Read' or not x['id'] for x in calls.values()):
        return set()
    ids = {x['id'] for x in calls.values()}
    return ids if len(ids) == len(calls) else set()


def validate_read_targets(frames, payload, workspace, scenario):
    calls = {}
    for frame in frames:
        for choice in frame.get('choices', []):
            for item in choice.get('delta', {}).get('tool_calls', []):
                index = item.get('index')
                require(type(index) is int and index >= 0, 'invalid tool index')
                function = item.get('function', {})
                calls[index] = calls.get(index, '') + function.get('arguments', '')
    if not calls:
        return set()
    ids = completed_read_calls(frames, payload)
    require(len(calls) == 1 and len(ids) == 1 and scenario.get('target') in ('readme.txt','missing.txt'),
            'unexpected tool call for scenario')
    arguments = json.loads(next(iter(calls.values())))
    require(isinstance(arguments,dict) and set(arguments) <= {'file_path','offset','limit'} and isinstance(arguments.get('file_path'),str),
            'unexpected Read arguments')
    for key in ('offset','limit'):
        if key in arguments:
            require(type(arguments[key]) is int and (0 if key == 'offset' else 1) <= arguments[key] <= 9007199254740991,
                    'invalid Read range')
    workspace = Path(workspace).resolve()
    requested = Path(arguments['file_path'])
    candidate = Path(os.path.abspath(requested if requested.is_absolute() else workspace/requested))
    expected = workspace/scenario['target']
    require(os.path.normcase(str(candidate)) == os.path.normcase(str(expected)),
            'Read target outside named synthetic fixture')
    require(candidate.resolve() == expected and expected.parent == workspace,
            'Read target outside named synthetic fixture')
    return ids


def validate_child_config(config, profile_root, origin, mode=None, model=None, system_env=None):
    root = Path(profile_root).resolve()
    require(isinstance(config,dict) and set(config)=={'env','profile','credential_decision','paths'}, 'unexpected bridge output fields')
    env = config.get('env', {})
    expected = {'HOME':'home','USERPROFILE':'home','APPDATA':'home/AppData/Roaming',
                'LOCALAPPDATA':'home/AppData/Local','TEMP':'temp','TMP':'temp',
                'ZCODE_DATA_BASE_DIR':'data','ZCODE_STORAGE_DIR':'storage','ZCODE_DESKTOP_HOME_DIR':'home',
                'ZCODE_DESKTOP_USER_DATA_DIR':'userData','ZCODE_DESKTOP_SESSION_DATA_DIR':'sessionData'}
    allowed = set(expected) | {'PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT',
                              'ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT','ZCODE_ENDPOINT_ORIGIN','ZCODE_BASE_URL'}
    require(isinstance(env,dict) and set(env) <= allowed, 'unexpected child environment key')
    require(all(isinstance(v,str) for v in env.values()), 'invalid child environment value')
    if system_env is not None:
        canonical_system={k.upper():v for k,v in system_env.items()}
        for key in ('PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'):
            require(env.get(key)==canonical_system.get(key),'child changed inherited system environment')
    for key,relative in expected.items():
        require(env.get(key)==str(root/relative), 'child environment escaped owned profile')
    require(env.get('ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT')=='1' and env.get('ZCODE_ENDPOINT_ORIGIN')==origin
            and env.get('ZCODE_BASE_URL')==origin, 'child endpoint isolation invalid')
    profile=config.get('profile',{})
    require(isinstance(profile,dict) and set(profile) <= {'schemaVersion','providerId','modelId','networkMode','credentialRef'},
            'unexpected profile field')
    require(profile.get('schemaVersion')==1 and profile.get('providerId')=='deepseek-official' and
            profile.get('modelId') in MODELS and profile.get('networkMode')=='offline', 'unexpected profile settings')
    if model is not None: require(profile['modelId']==model,'profile model differs')
    decision=config['credential_decision']
    authorized={'decision':'authorized','credentialRef':'existing-zcode:deepseek-official'}
    require(decision in ({'decision':'no-key'},authorized),'unexpected credential decision')
    if decision==authorized:
        require(profile.get('credentialRef')==authorized['credentialRef'] and mode in (None,'real'), 'unexpected credential reference')
    else:
        require('credentialRef' not in profile and mode in (None,'mock'),'unexpected credential reference')
    expected_paths={name:str(root/relative) for name,relative in {
        'root':'','profileFile':'profile.json','home':'home','data':'data','temp':'temp','workspace':'workspace',
        'storage':'storage','userData':'userData','sessionData':'sessionData',
        'appData':'home/AppData/Roaming','localAppData':'home/AppData/Local'}.items()}
    require(config['paths']==expected_paths, 'unexpected bridge path fields')


def public_sse(payload):
    """Retain public text/tool/usage fields without persisting hidden reasoning."""
    frames, saved = [], []
    for line in payload.decode('utf-8').splitlines():
        if line.startswith('data: {'):
            frame = json.loads(line[6:])
            frames.append(frame)
            clean = {k:frame[k] for k in ('id','object','created','model','usage') if k in frame}
            clean['choices'] = []
            for choice in frame.get('choices', []):
                item = {k:choice[k] for k in ('index','finish_reason') if k in choice}
                for container in ('delta', 'message'):
                    if isinstance(choice.get(container), dict):
                        source=choice[container]
                        item[container] = {k:source[k] for k in ('role','content') if k in source and (source[k] is None or isinstance(source[k],str))}
                        if isinstance(source.get('tool_calls'),list):
                            item[container]['tool_calls'] = []
                            for call in source['tool_calls']:
                                require(isinstance(call,dict),'invalid tool response')
                                clean_call={k:call[k] for k in ('index','id','type') if k in call}
                                if isinstance(call.get('function'),dict):
                                    clean_call['function']={k:call['function'][k] for k in ('name','arguments') if k in call['function'] and isinstance(call['function'][k],str)}
                                item[container]['tool_calls'].append(clean_call)
                clean['choices'].append(item)
            saved.append('data: ' + json.dumps(clean, ensure_ascii=False))
        elif line == 'data: [DONE]':
            saved.append(line)
    return frames, ('\n\n'.join(saved)+'\n\n').encode()
