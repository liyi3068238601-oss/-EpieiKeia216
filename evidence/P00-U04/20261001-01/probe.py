"""Read-only source/toolchain lock probe; no dependency installation or model call."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import datetime
import hashlib
import json
import importlib.metadata
import subprocess
import sys
import httpx

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
NODE = Path(r'C:\Program Files\nodejs\node.exe')
records = []

def sha(data):
    return hashlib.sha256(data).hexdigest()

def command(args):
    p = subprocess.run(args, cwd=ROOT, capture_output=True, timeout=45)
    records.append({'command': [str(x) for x in args], 'cwd': str(ROOT),
                    'exit_code': p.returncode, 'stdout_bytes': len(p.stdout), 'stdout_sha256': sha(p.stdout),
                    'stdout': p.stdout.decode('utf-8', 'replace') if len(p.stdout) < 2048 else 'Large source output retained in pinned Git object; byte count and SHA above.',
                    'stderr': p.stderr.decode('utf-8', 'replace')})
    assert p.returncode == 0, args
    return p.stdout

def git(repo, *args):
    return command(['git', '-C', str(repo), *args])

definitions = [
    ('zcode', 'zai-org/ZCode', 'zcode-29628c9', '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
     ['mise.toml', '.nvmrc', 'apps/zcode-cli/package.json', 'apps/zcode-cli/packages/cli/package.json'], 'README.md'),
    ('dsh', 'deepseek-ai/deepseek-harness', 'dsh-639ed015', '639ed015397290b3745d163aafe02ffee4aa3f84',
     ['packages/sdk/client/package.json', 'packages/sdk/protocol/package.json', 'packages/sdk/server/package.json'], 'README.md'),
    ('herta', 'PersonaCLI/Herta', 'herta-4623df12', '4623df120adf99340ce5f7e25ed829466975e3ae',
     ['mise.toml', '.node-version', 'packages/gui/package.json', 'packages/knowledge/package.json'],
     'packages/knowledge/src/dream/config.ts'),
]
sources = []
for name, repo_name, folder, pin, extra, fetched_file in definitions:
    repo = ROOT / 'references' / folder
    assert git(repo, 'rev-parse', 'HEAD').decode().strip() == pin
    assert not git(repo, 'status', '--porcelain').strip()
    files = []
    for rel in ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'LICENSE', *extra]:
        disk = (repo / rel).read_bytes()
        blob = git(repo, 'show', f'{pin}:{rel}')
        files.append({'path': f'references/{folder}/{rel}', 'bytes': len(disk),
                      'filesystem_sha256': sha(disk), 'git_blob_sha256': sha(blob),
                      'fixed_url': f'https://github.com/{repo_name}/blob/{pin}/{rel}'})
    package = json.loads((repo / 'package.json').read_text(encoding='utf-8'))
    sources.append({'id': name, 'repository': f'https://github.com/{repo_name}.git', 'commit': pin,
                    'tree': git(repo, 'rev-parse', 'HEAD^{tree}').decode().strip(),
                    'root_package_version': package['version'], 'package_manager': package.get('packageManager'),
                    'node_engine': package.get('engines', {}).get('node'), 'files': files,
                    'fixed_refetch_file': fetched_file,
                    'rollback': {'checkout': f'git checkout --detach {pin}',
                                 'recreate': f'git clone --no-hardlinks https://github.com/{repo_name}.git NEW_EMPTY_ISOLATED_PATH; checkout exact commit; frozen install with per-source pnpm; never reset a user checkout'},
                    'transitive_dependencies': 'Exact pnpm-lock.yaml blob SHA above; no floating latest installation is permitted.'})

def refetch(item):
    definition = next(d for d in definitions if d[0] == item['id'])
    _, repo_name, folder, pin, _, rel = definition
    url = f'https://raw.githubusercontent.com/{repo_name}/{pin}/{rel}'
    with httpx.Client(timeout=25, follow_redirects=False, trust_env=False) as client:
        response = client.get(url)
    assert response.status_code == 200, (url, response.status_code)
    blob = subprocess.check_output(['git', '-C', str(ROOT / 'references' / folder), 'show', f'{pin}:{rel}'])
    assert response.content == blob, url
    return {'url': url, 'http_status': response.status_code, 'bytes': len(response.content),
            'remote_sha256': sha(response.content), 'git_blob_sha256': sha(blob), 'byte_exact_match': True}

with ThreadPoolExecutor(max_workers=3) as pool:
    fetched = list(pool.map(refetch, sources))
for item, result in zip(sources, fetched):
    item['fixed_refetch'] = result
    head = command(['git', 'ls-remote', item['repository'], 'HEAD']).decode().strip()
    item['floating_check'] = {'observed_remote_head': head.split()[0], 'selected_commit': item['commit'],
                              'follow_latest': False, 'decision': 'Selected immutable pin retained regardless of remote movement.'}

abi = json.loads(command([str(NODE), '-p', 'JSON.stringify({version:process.version,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})']))
tools = []
for name, version, rel in [('zcode', '10.33.2', '.runtime/P00/zcode/tools/package/bin/pnpm.cjs'),
                           ('dsh', '11.7.0', '.runtime/P00/dsh/tools/bin/pnpm.mjs')]:
    path = ROOT / rel
    actual = command([str(NODE), str(path), '--version']).decode().strip()
    assert actual == version
    tools.append({'runtime': name, 'pnpm_version': actual, 'entry': rel, 'entry_sha256': sha(path.read_bytes()),
                  'install_integrity_receipt': 'evidence/P00-U02/20261001-01/' + ('zcode-tool-download.json' if name == 'zcode' else 'dsh-runtime-run.json')})

lock = {'schema_version': 1, 'status': 'ready_for_review', 'product_version': '0.0.0', 'plan_document_version': '1.1',
        'created_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'baseline_commit': command(['git', 'rev-parse', 'HEAD']).decode().strip(), 'sources': sources,
        'experiment_toolchain': {'node_executable': str(NODE), 'node_executable_sha256': sha(NODE.read_bytes()),
                                 'node': abi, 'pnpm': tools, 'global_pnpm_used': False,
                                 'python': {'version': sys.version, 'executable': sys.executable,
                                            'executable_sha256': sha(Path(sys.executable).read_bytes()),
                                            'existing_test_driver_dependencies': {name: importlib.metadata.version(name) for name in ['httpx', 'PyYAML']},
                                            'dependency_policy': 'Existing test tools only; no Python product runtime or installation was introduced. Restore drivers with these exact versions in an isolated uv environment if needed.'}},
        'upstream_toolchain_notes': {
            'zcode': 'mise.toml/.nvmrc/CLI manifest pin Node 24.14.0 and pnpm 10.33.2. P00 actually used Node 24.16.0; this delta is recorded, not erased.',
            'dsh': 'Per-source pnpm 11.7.0; declared Node range accepts actual Node 24.16.0. SDK source fallback only; native/desktop build NOT_RUN.',
            'herta': 'pnpm 9.15.0; .node-version/mise reference Node 22; engine range in source above. Pure functions only, no install/native execution. Any future SQLite/Electron runtime needs its own exact Node/Electron ABI and native rebuild.'},
        'process_boundaries': 'ZCode native main runtime; dedicated DSH process; Herta bounded pure-function/design reference. Do not force three runtime dependency graphs into one process.',
        'native_abi_policy': 'Observed Node ABI 137/N-API 10 applies only to this Node executable. Electron, node-addon-system and better-sqlite3 compatibility/package ABI are NOT_RUN; no cross-runtime binary reuse accepted.',
        'floating_policy': 'No latest/^/~ dependency is resolved outside the pinned source lockfiles. Manifest ranges inside pinned upstream trees are constrained by those exact lockfiles; upgrades require a new reviewed lock and replay.',
        'limitations': ['This locks P00 source and experiment inputs, not a Windows product distribution or Herta runtime.', 'Node is an existing global binary invoked by explicit path; child configuration/data and pnpm tools are isolated, not an OS sandbox.']}
(ROOT / 'docs/sources.lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
(OUT / 'commands.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
(OUT / 'verification.json').write_text(json.dumps({'status': 'ready_for_review', 'source_count': len(sources),
    'fixed_refetch': fetched, 'node_abi': abi, 'lock_sha256': sha((ROOT / 'docs/sources.lock.json').read_bytes()),
    'probe_sha256': sha(Path(__file__).read_bytes()), 'model_calls': 0, 'source_writes': 0}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print('P00-U04: three fixed links byte-exact, isolated pnpm versions exact, source trees clean')
