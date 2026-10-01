"""Verify recorded Desktop port isolation without launching an application."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / 'evidence/P01-U02/20261001-01'


def binding(path):
    return {'path': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    summary_path = EVIDENCE / 'summary-no-key-ui.json'
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    assert summary['passed'] and summary['exit_code'] == 0
    run = EVIDENCE / 'runs' / summary['run_id']
    ui = json.loads((run / 'ui-result.json').read_text(encoding='utf-8'))
    before = json.loads((run / 'listeners-before.json').read_text(encoding='utf-8'))
    occupied = {q['LocalPort'] for q in before}
    logs = [json.loads(s) for s in (run / 'network.jsonl').read_text(encoding='utf-8').splitlines()]
    checked = []
    assert len(ui['snapshots']) == 2 and ui['passed']
    for snap in ui['snapshots']:
        pid = snap['paths']['main_pid']
        forks = [q for q in logs if q['kind'] == 'utility_fork' and q['pid'] == pid]
        assert any('/host/' in q['modulePath'].replace('\\', '/') for q in forks)
        assert any('/scheduler/' in q['modulePath'].replace('\\', '/') for q in forks)
        pids = {pid, *(q['child_pid'] for q in forks)}
        assert all(any(q['kind'] == 'guard_loaded' and q['pid'] == p for q in logs) for p in pids)
        assert all(any(q['kind'] == 'egress_canary_denied' and q['pid'] == p for q in logs) for p in pids)
        listeners = snap['listeners']
        assert len(listeners) >= 2
        assert all(q['OwningProcess'] in pids for q in listeners)
        assert all(q['LocalAddress'] in ('127.0.0.1', '::1') for q in listeners)
        assert not occupied.intersection(q['LocalPort'] for q in listeners)
        assert snap['paths']['remote_debugging_port_switch'] == '0'
        assert not snap['paths']['visible'] and snap['actual_settings_page']
        checked.append({'launch': snap['launch'], 'owned_pids': sorted(pids), 'listeners': listeners,
                        'overlap_with_existing_ports': [], 'fixed_9229_disabled': True,
                        'egress_canary_denied_for_each_owned_process': True})
    for rel, digest in summary['code_bindings'].items():
        assert binding(ROOT / 'spikes/P01' / rel)['sha256'] == digest, rel
    for item in summary['artifacts']:
        assert binding(ROOT / item['path']) == item, item['path']
    wrappers = sorted((run / 'utility-guards').glob('*.mjs'))
    assert len(wrappers) == 2
    result = {'status': 'pass', 'run_id': summary['run_id'], 'launches': checked,
              'existing_listener_count': len(before), 'model_requests': summary['model_requests'],
              'production_unchanged': summary['production_unchanged'],
              'scope': 'Recorded experiment Main/Host/Scheduler listener snapshots; future product startup must preserve this policy',
              'visual_acceptance': ui['visual_acceptance'],
              'artifacts': [binding(p) for p in [summary_path, run / 'ui-result.json',
                            run / 'listeners-before.json', run / 'network.jsonl', *wrappers,
                            EVIDENCE / 'desktop-build/manifest.json',
                            Path(__file__).resolve()]]}
    target = EVIDENCE / 'startup-port-verification.json'
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'launches': len(checked),
                      'ports': [[q['LocalPort'] for q in s['listeners']] for s in checked],
                      'utility_wrappers_bound': len(wrappers)}))


if __name__ == '__main__':
    main()
