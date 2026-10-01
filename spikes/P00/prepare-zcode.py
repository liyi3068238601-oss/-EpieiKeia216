"""Install/build the pinned CLI in an ignored, independent checkout."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / '.runtime/P00/zcode'
SOURCE = BASE / 'source'
TOOLS = BASE / 'tools'
EVIDENCE = ROOT / 'evidence/P00-U02/20261001-01'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
VERSION = '10.33.2'
BASE.mkdir(parents=True, exist_ok=True)
TOOLS.mkdir(exist_ok=True)
EVIDENCE.mkdir(parents=True, exist_ok=True)
for part in ('home', 'temp', 'cache', 'store', 'data'):
    (BASE / part).mkdir(exist_ok=True)
node = Path(r'C:\Program Files\nodejs\node.exe')
env = {k: v for k, v in os.environ.items() if k.upper() in {'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'}}
env.update({'PATH': str(TOOLS) + os.pathsep + str(node.parent) + os.pathsep + r'C:\Program Files\Git\cmd' + os.pathsep + r'C:\Windows\System32', 'USERPROFILE': str(BASE / 'home'), 'APPDATA': str(BASE / 'home/AppData/Roaming'), 'LOCALAPPDATA': str(BASE / 'home/AppData/Local'), 'TEMP': str(BASE / 'temp'), 'TMP': str(BASE / 'temp'), 'XDG_CACHE_HOME': str(BASE / 'cache'), 'ZCODE_DATA_BASE_DIR': str(BASE / 'data'), 'HUSKY': '0', 'CI': 'true', 'NPM_CONFIG_USERCONFIG': str(BASE / 'home/empty.npmrc'), 'NPM_CONFIG_CACHE': str(BASE / 'cache'), 'PNPM_HOME': str(TOOLS)})
(BASE / 'home/empty.npmrc').touch(exist_ok=True)
record_path = EVIDENCE / 'zcode-preparation.json'
records = json.loads(record_path.read_text(encoding='utf-8'))['commands'] if record_path.exists() else []

def run(command, cwd, label):
    log = EVIDENCE / ('zcode-' + label + '.log')
    print(label, 'START', flush=True)
    with log.open('w', encoding='utf-8') as output:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
    records.append({'command': command, 'cwd': str(cwd), 'exit_code': result.returncode, 'log': str(log.relative_to(ROOT)), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()})
    save()
    print(label, 'EXIT', result.returncode, flush=True)
    if result.returncode:
        print(log.read_text(encoding='utf-8')[-5000:], flush=True)
        raise SystemExit(result.returncode)

def save():
    record_path.write_text(json.dumps({'source_commit': PIN, 'runtime_root': str(BASE), 'node_version': subprocess.check_output([str(node), '--version'], text=True).strip(), 'pnpm_version': VERSION, 'environment': {'inherited_allowlist': ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'], 'HOME': 'omitted', 'USERPROFILE': env['USERPROFILE'], 'ZCODE_DATA_BASE_DIR': env['ZCODE_DATA_BASE_DIR'], 'real_credentials': 'omitted'}, 'commands': records}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

if not SOURCE.exists():
    run(['git', 'clone', '--no-hardlinks', str(ROOT / 'references/zcode-29628c9'), str(SOURCE)], ROOT, 'clone')
assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == PIN
package = TOOLS / 'package/bin/pnpm.cjs'
if not package.exists():
    with urllib.request.urlopen('https://registry.npmjs.org/pnpm/' + VERSION, timeout=30) as response:
        metadata = json.load(response)
    distribution = metadata['dist']
    assert distribution['tarball'].startswith('https://registry.npmjs.org/pnpm/-/')
    with urllib.request.urlopen(distribution['tarball'], timeout=60) as response:
        payload = response.read()
    algorithm, expected = distribution['integrity'].split('-', 1)
    assert algorithm == 'sha512'
    assert base64.b64encode(hashlib.sha512(payload).digest()).decode() == expected
    archive = TOOLS / ('pnpm-' + VERSION + '.tgz')
    archive.write_bytes(payload)
    with tarfile.open(archive) as tar:
        tar.extractall(TOOLS, filter='data')
    (EVIDENCE / 'zcode-tool-download.json').write_text(json.dumps({'name': 'pnpm', 'version': VERSION, 'url': distribution['tarball'], 'integrity': distribution['integrity'], 'sha256': hashlib.sha256(payload).hexdigest(), 'verified': True, 'official_docs': ['https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/settings.md', 'https://github.com/pnpm/pnpm.io/blob/main/docs/cli/install.md']}, indent=2) + '\n', encoding='utf-8')
(TOOLS / 'pnpm.cmd').write_text('@"' + str(node) + '" "' + str(package) + '" %*\r\n', encoding='utf-8')
command = [str(node), str(package), '--config.manage-package-manager-versions=false']
mode = sys.argv[1] if len(sys.argv) > 1 else 'install'
if mode == 'install':
    run(command + ['--filter', '@zcode/cli...', 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', str(BASE / 'store'), '--reporter', 'append-only'], SOURCE, 'install')
elif mode == 'build':
    run(command + ['--filter', '@zcode/cli...', '--workspace-concurrency=2', 'build'], SOURCE, 'build')
elif mode == 'version':
    run([str(node), str(SOURCE / 'apps/zcode-cli/packages/cli/dist/zcode.cjs'), '--version'], SOURCE, 'version')
else:
    raise SystemExit('Unknown preparation mode')
