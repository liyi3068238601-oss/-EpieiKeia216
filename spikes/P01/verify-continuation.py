"""Malformed streams and fabricated tool results must not open a paid second slot."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPIKE = ROOT / 'spikes/P01'
module_spec = importlib.util.spec_from_file_location('p01_probe', SPIKE / 'probe.py')
probe = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(probe)


def frames_for(name='Read', ids=('call-1',)):
    return [{'choices': [{'index': 0, 'delta': {'tool_calls': [
        {'index': index, 'id': ident, 'type': 'function', 'function': {'name': name}}
        for index, ident in enumerate(ids)]}, 'finish_reason': None}]},
        {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]}]


def main():
    done = b'data: [DONE]\n\n'
    fragmented = frames_for('Re')
    fragmented.insert(1, {'choices': [{'index': 0, 'delta': {'tool_calls': [
        {'index': 0, 'function': {'name': 'ad'}}]}, 'finish_reason': None}]})
    checks = {
        'completed_Read': probe.completed_read_tool_ids(frames_for(), done) == {'call-1'},
        'fragmented_Read_name': probe.completed_read_tool_ids(fragmented, done) == {'call-1'},
        'unsupported_tool_rejected': not probe.completed_read_tool_ids(frames_for('Shell'), done),
        'duplicate_ids_rejected': not probe.completed_read_tool_ids(frames_for(ids=('call-1','call-1')), done),
        'incomplete_stream_rejected': not probe.completed_read_tool_ids(frames_for(), b''),
        'embedded_DONE_text_rejected': not probe.completed_read_tool_ids(frames_for(), b'data: {"content":"data: [DONE]"}\n\n'),
    }
    messages = [{'role': 'tool', 'tool_call_id': 'call-1', 'content': 'synthetic value'}]
    native = {'phase': 'real-read', 'tool_call_id': 'call-1', 'tool_name': 'Read', 'event_type': 'tool_call_result'}
    checks.update({
        'native_result_continues': probe.native_tool_continuation({'call-1'}, messages, [native], 'real-read'),
        'fabricated_body_without_native_event_rejected': not probe.native_tool_continuation({'call-1'}, messages, [], 'real-read'),
        'wrong_tool_id_rejected': not probe.native_tool_continuation({'call-2'}, messages, [native], 'real-read'),
        'wrong_phase_rejected': not probe.native_tool_continuation({'call-1'}, messages, [native], 'another-phase'),
        'wrong_tool_name_rejected': not probe.native_tool_continuation({'call-1'}, messages, [{**native,'tool_name':'Shell'}], 'real-read'),
        'scheduled_only_rejected': not probe.native_tool_continuation({'call-1'}, messages, [{**native,'event_type':'tool_call_scheduled'}], 'real-read'),
        'observed_native_error_can_be_reported': probe.native_tool_continuation({'call-1'}, messages, [{**native,'event_type':'tool_call_error'}], 'real-read'),
    })
    if not all(checks.values()):
        raise RuntimeError('Continuation guard counterexample failed: ' + ', '.join(k for k,v in checks.items() if not v))
    bindings = []
    for p in [SPIKE/'probe.py',SPIKE/'host.mjs',Path(__file__).resolve()]:
        bindings.append({'path':p.relative_to(ROOT).as_posix(),'bytes':p.stat().st_size,
                         'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
    result = {'status':'pass','scenario':'synthetic guard counterexamples; not a model route pass',
              'checks':checks,'actual_model_calls':0,'artifacts':bindings}
    (ROOT/'evidence/P01-U02/20261001-01/continuation-guard-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'status':'pass','checks':len(checks),'actual_model_calls':0}))


if __name__ == '__main__':
    main()
