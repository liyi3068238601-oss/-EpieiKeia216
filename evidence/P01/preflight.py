"""Read-only admission check; model listing is metadata only, no generation."""
from pathlib import Path
import hashlib
import json
import subprocess
import httpx
import yaml

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).with_name('preflight.json')
if OUT.exists():
    raise SystemExit('Refusing to overwrite admission evidence')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

receipt_path = ROOT / 'evidence/P00-U12/20261001-01/acceptance.json'
receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
assert receipt['status'] == 'accepted' and receipt['gate_status'] == 'pass'
bindings = receipt['input_bindings'] + receipt['prior_accepted_units']
for item in bindings:
    path = ROOT / item['path']
    assert path.stat().st_size == item['bytes'] and sha(path) == item['sha256']

pins = []
for relative, expected in [
    ('.runtime/P00/zcode/source', '29628c9acdb81b703bbd4080c207a0e7ce5e276e'),
    ('.runtime/P00/dsh/source', '639ed015397290b3745d163aafe02ffee4aa3f84'),
    ('references/herta-4623df12', '4623df120adf99340ce5f7e25ed829466975e3ae'),
]:
    path = ROOT / relative
    commit = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
    status = subprocess.run(['git', '-C', str(path), 'status', '--porcelain'], capture_output=True, text=True)
    assert commit == expected and status.returncode == 0 and not status.stdout
    pins.append({'path': relative, 'commit': commit, 'clean': True})

gateway = {'generation_calls': 0, 'scope': 'configuration and GET /models metadata only'}
settings_path = Path(r'C:\Users\liyi\.dsh\settings.yaml')
secrets_path = Path(r'C:\Users\liyi\.dsh\.credentials.yaml')
before = {str(p): sha(p) for p in (settings_path, secrets_path)}
provider = yaml.safe_load(settings_path.read_text(encoding='utf-8'))['llm-pi-ai']['providers']['a7877']
base = provider['baseURL'].rstrip('/')
assert base == 'http://47.108.250.118:15555/v1'
key = yaml.safe_load(secrets_path.read_text(encoding='utf-8'))['refs'][provider['apiKeyEnv']]
assert isinstance(key, str) and key
expected_models = ['[\u57fa\u5143]deepseek-flash', '[\u57fa\u5143]glm-5.3-flash']
try:
    with httpx.Client(timeout=15, trust_env=False, follow_redirects=False) as client:
        response = client.get(base + '/models', headers={'Authorization': 'Bearer ' + key})
    gateway['http_status'] = response.status_code
    if response.status_code == 200:
        data = response.json()
        names = {v['id'] for v in data.get('data', []) if isinstance(v, dict) and isinstance(v.get('id'), str)}
        gateway['model_count'] = len(names)
        gateway['selected_candidates'] = [{'model': name, 'listed': name in names} for name in expected_models]
    else:
        gateway['error'] = 'metadata request did not return success; body not recorded'
except (httpx.HTTPError, ValueError):
    gateway['error'] = 'metadata request unavailable; no automatic retry'
finally:
    key = None
after = {str(p): sha(p) for p in (settings_path, secrets_path)}
assert before == after

record = {
    'stage': 'P01', 'status': 'admitted', 'baseline_commit': subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip(),
    'G00': {'status': 'pass', 'receipt': str(receipt_path.relative_to(ROOT)), 'sha256': sha(receipt_path), 'verified_prior_and_release_bindings': len(bindings)},
    'source_pins': pins, 'gateway_metadata': gateway,
    'global_config_read_only': {'paths': list(before), 'before': before, 'after': after, 'unchanged': True},
    'phase_model_authorization': 'pending for two-model P01 evaluation; existing P00 authorization is historical',
    'persona_assets': 'inventory in progress; no missing assets invented',
    'paid_model_calls': 0, 'DSH_started': False, 'Dream_started': False,
}
OUT.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('P01_ADMITTED; metadata only; 0 generation calls')
print(json.dumps(gateway, ensure_ascii=True))
