"""No secrets, native settings/session control plane in a complete isolated env."""
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / '.runtime/P00/zcode/source'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
NODE = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n',
                    encoding='utf-8', newline='\n')


def globals_snapshot():
    paths = [r'C:\Users\liyi\.dsh\settings.yaml', r'C:\Users\liyi\.dsh\.credentials.yaml',
             r'C:\Users\liyi\.zcode\cli\config.json', r'C:\Users\liyi\.zcode\cli\db\db.sqlite',
             r'D:\Mofox\Neo-MoFox\bot-3541647704\neo-mofox\config\core.toml']
    # Never persist the production account identifier or file contents.
    return [{'label': f'production-{i}', 'exists': Path(p).exists(),
             'sha256': sha(p) if Path(p).exists() else None} for i, p in enumerate(paths)]


def main():
    receipt = json.loads((ROOT / 'evidence/P01-U01/20261001-01/acceptance.json').read_text(encoding='utf-8'))
    assert receipt['status'] == 'accepted'
    assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    assert not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip()
    run_id = 'no-key-' + str(time.time_ns())
    work = ROOT / '.runtime/P01' / run_id
    evidence = ROOT / 'evidence/P01-U02/20261001-01/runs' / run_id
    evidence.mkdir(parents=True)
    home, fixture, data, temp = [work / name for name in ('home', 'fixture', 'data', 'temp')]
    for p in (home / '.zcode/cli', fixture, data, temp):
        p.mkdir(parents=True)
    personal, db = work / 'personal.json', work / 'sessions.sqlite'
    save(personal, {'schemaVersion': 1, 'config': {
        'providerConfigRules': {'providerRules': []},
        'modelConfigRules': {'providerModelRules': [], 'manualProviderModelRules': []}}})
    spec = {'home': str(home), 'fixture': str(fixture), 'personal': str(personal), 'db': str(db),
            'bootstrap': str(SOURCE / 'apps/zcode-cli/packages/bootstrap/dist/index.js'),
            'provider': str(SOURCE / 'packages/provider/dist/index.js'),
            'storage': str(SOURCE / 'apps/zcode-cli/packages/adapters/dist/storage/index.js')}
    for key in ('bootstrap', 'provider', 'storage'):
        assert Path(spec[key]).is_file(), key
    save(work / 'spec.json', spec)
    env = {k: v for k, v in os.environ.items() if k.upper() in ('SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT')}
    env.update({'PATH': str(NODE.parent) + os.pathsep + r'C:\Program Files\Git\cmd' + os.pathsep + r'C:\Windows\System32',
                'USERPROFILE': str(home), 'APPDATA': str(home / 'AppData/Roaming'),
                'LOCALAPPDATA': str(home / 'AppData/Local'), 'TEMP': str(temp), 'TMP': str(temp),
                'ZCODE_DATA_BASE_DIR': str(data), 'ZCODE_SESSION_DB_PATH': str(db),
                'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE': str(personal),
                'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE': str(SOURCE / 'config/provider/zcode-builtin.json'),
                'NODE_ENV': 'production'})
    before = globals_snapshot()
    command = [str(NODE), '--import', (SOURCE / 'node_modules/tsx/dist/esm/index.mjs').as_uri(),
               str(ROOT / 'spikes/P01/no-key.mjs'), str(work / 'spec.json')]
    started = time.monotonic()
    proc = subprocess.run(command, cwd=fixture, env=env, capture_output=True, timeout=90)
    (evidence / 'stdout.bin').write_bytes(proc.stdout)
    (evidence / 'stderr.bin').write_bytes(proc.stderr)
    after = globals_snapshot()
    outcome = {'run_id': run_id, 'command': command, 'cwd': str(fixture), 'exit_code': proc.returncode,
               'elapsed_seconds': round(time.monotonic() - started, 3), 'source_commit': PIN,
               'compiled': {k: sha(spec[k]) for k in ('bootstrap', 'provider', 'storage')},
               'code_bindings': {p: sha(ROOT / p) for p in ('spikes/P01/no-key.mjs', 'spikes/P01/run-no-key.py')},
               'production_before': before, 'production_after': after, 'production_unchanged': before == after,
               'model_requests': 0, 'secret_values_parsed_or_passed_to_child': False,
               'production_metadata_reads': 'SHA-256 only; no config values parsed or printed',
               'isolation': 'complete child env + explicit provider/DB/home; application instrumentation, not OS sandbox',
               'desktop_ui': 'NOT_RUN; this attempt covers native control plane only',
               'artifacts': [{'path': p.relative_to(ROOT).as_posix(), 'bytes': p.stat().st_size, 'sha256': sha(p)}
                             for p in evidence.iterdir() if p.is_file()]}
    outcome['passed'] = proc.returncode == 0 and before == after
    save(evidence / 'summary.json', outcome)
    save(evidence.parents[1] / 'summary-no-key-control.json', outcome)
    print(json.dumps({'run_id': run_id, 'passed': outcome['passed'], 'exit_code': proc.returncode,
                      'production_unchanged': before == after, 'model_requests': 0,
                      'desktop_ui': 'NOT_RUN'}, ensure_ascii=False))
    if proc.returncode:
        print(proc.stderr.decode('utf-8', errors='replace')[-4000:])
    raise SystemExit(0 if outcome['passed'] else 1)


if __name__ == '__main__':
    main()
