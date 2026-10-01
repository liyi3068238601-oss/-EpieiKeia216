"""Independent coordinator replay of the author's initialize-only SDK PoC."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / '.runtime/P00/dsh'
SOURCE = BASE / 'source'
EVIDENCE = ROOT / 'evidence/P00-U02/20261001-01'
PIN = '639ed015397290b3745d163aafe02ffee4aa3f84'
assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == PIN
assert not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip()
env = {k: v for k, v in os.environ.items() if k.upper() in ('SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT')}
env.update({'PATH': r'C:\Program Files\nodejs;C:\Windows\System32', 'USERPROFILE': str(BASE / 'env/userprofile'), 'APPDATA': str(BASE / 'env/appdata'), 'LOCALAPPDATA': str(BASE / 'env/localappdata'), 'TEMP': str(BASE / 'env/temp'), 'TMP': str(BASE / 'env/temp'), 'TSX_TSCONFIG_PATH': str(SOURCE / 'apps/cli/tsconfig.json')})
records = []
for case, argument in (('normal', 'good'), ('failure', 'bad'), ('recovery', 'good')):
    command = [r'C:\Program Files\nodejs\node.exe', '--import', 'tsx/esm', str(ROOT / 'spikes/P00/dsh-runtime/init-only.ts'), argument]
    result = subprocess.run(command, cwd=SOURCE, env=env, capture_output=True, timeout=90)
    assert result.returncode == 0, result.stderr.decode('utf-8', errors='replace')
    output = json.loads(result.stdout)
    assert output['prompt'] == 'NOT_SENT' and output['modelCall'] == 'NOT_SENT'
    if argument == 'good':
        assert output['status'] == 'initialize_ok'
        assert output['result']['serverInfo'] == {'name': 'deepseek-harness-sdk-runtime', 'version': '0.0.1'}
    else:
        assert output['status'] == 'expected_initialize_failure'
        assert 'no adapter registered' in output['errorMessage']
    records.append({'case': case, 'command': command, 'cwd': str(SOURCE), 'exit_code': result.returncode, 'stdout': result.stdout.decode('utf-8'), 'stderr': result.stderr.decode('utf-8')})
    print(case, output['status'], 'exit', result.returncode, flush=True)
assert not subprocess.check_output(['git', '-C', str(SOURCE), 'status', '--porcelain'], text=True).strip()
bindings = []
for relative in ('spikes/P00/dsh-runtime/init-only.ts', 'spikes/P00/dsh-runtime/disable-tools.cordis.patch.yml', 'spikes/P00/dsh-runtime/package.json', 'evidence/P00-U02/20261001-01/dsh-runtime-report.md', 'evidence/P00-U02/20261001-01/dsh-runtime-config.yaml'):
    path = ROOT / relative
    bindings.append({'path': relative, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
receipt = {'task_id': 'P00-U02', 'reviewer': 'root', 'status': 'accepted_component_only', 'source_commit': PIN, 'source_tree_clean_before_after': True, 'bindings': bindings, 'executions': records, 'model_calls': 0, 'scope': 'Actual SDK source-fallback initialize and close; normal/bad route/fresh client recovery. No prompt, model, permission execution or process-tree cancellation claim.', 'findings': []}
(EVIDENCE / 'review-dsh-runtime.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
