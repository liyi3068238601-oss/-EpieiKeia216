"""Read-only source/approval verifier. Emits metadata, never persona/config values."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def git(path, *args):
    return subprocess.run(['git', '-C', str(path), *args], check=True,
                          capture_output=True, text=True, encoding='utf-8').stdout.strip()


def binding(rel):
    data = (ROOT / rel).read_bytes()
    return {'path': rel, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    sources = []
    for path, sha in [('.runtime/P00/zcode/source', '29628c9acdb81b703bbd4080c207a0e7ce5e276e'),
                      ('.runtime/P00/dsh/source', '639ed015397290b3745d163aafe02ffee4aa3f84'),
                      ('references/herta-4623df12', '4623df120adf99340ce5f7e25ed829466975e3ae')]:
        head = git(ROOT / path, 'rev-parse', 'HEAD')
        status = git(ROOT / path, 'status', '--porcelain')
        assert head == sha and not status, path
        sources.append({'path': path, 'commit': head, 'clean': True})
    prefix = '.runtime/P00/zcode/source/'
    files = [prefix + p for p in [
        'LICENSE', 'README.md', 'package.json', 'apps/zcode-cli/README.md',
        'apps/zcode-cli/package.json', 'packages/desktop/package.json',
        'apps/zcode-cli/packages/adapters/src/plugins/hook-sources.ts',
        'apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts',
        'apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts',
        'apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts',
        'apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts',
        'apps/zcode-cli/packages/bootstrap/src/app/types.ts',
        'apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts',
        'apps/zcode-cli/packages/bootstrap/src/plugins.ts',
        'apps/zcode-cli/packages/adapters/src/config/file-config.adapter.ts',
        'apps/zcode-cli/packages/contracts/src/events/session.events.ts',
        'packages/ui/src/settings/PluginConfigControls.tsx',
        'packages/ui/src/login/LoginApiKeyForm.tsx',
        'packages/provider-node/src/personal-provider-config-repository.ts',
        'packages/services/test/providerConfigMigration.test.ts',
        'packages/services/src/zcode-agent/zcodeAgent.ts',
    ]]
    files += ['references/herta-4623df12/' + p for p in [
        'LICENSE', 'README.md', 'packages/herta/package.json',
        'packages/herta/src/narrative/static-prefix.ts',
        'packages/herta/src/narrative/actor-prompt.ts',
        'packages/herta/src/narrative/static-prefix.test.ts',
        'packages/herta/src/narrative/actor-prompt.test.ts',
    ]]
    receipt = json.loads((ROOT / 'evidence/P00-U12/20261001-01/acceptance.json').read_text(encoding='utf-8'))
    assert receipt['status'] == 'accepted'
    auth = json.loads((ROOT / 'evidence/P01/authorization.json').read_text(encoding='utf-8'))
    assert auth['status'] == 'authorized' and auth['initial_request_limit'] == 18
    ledger = json.loads((ROOT / 'docs/research/P01/persona-versions.json').read_text(encoding='utf-8'))
    assert ledger['user_reply'] == '本次使用精简版，但所有版本都保留'
    assert ledger['current_version'] == 'v3' and len(ledger['versions']) == 4
    for version in ledger['versions']:
        assert binding(version['path'])['sha256'] == version['sha256'], version['version']
    private = ledger['versions'][0]['path']
    assert subprocess.run(['git', '-C', str(ROOT), 'check-ignore', '--quiet', '--', private]).returncode == 0
    tracked = git(ROOT / '.runtime/P00/zcode/source', 'ls-files').splitlines()
    tests = [p for p in tracked if '/test/' in p or p.endswith(('.test.ts', '.test.tsx'))]
    report = {
        'task': 'P01-U01', 'status': 'research_checks_pass', 'cwd': str(ROOT),
        'baseline_commit': git(ROOT, 'rev-parse', 'HEAD'), 'sources': sources,
        'prerequisite': binding('evidence/P00-U12/20261001-01/acceptance.json'),
        'task_card': binding('planning/Xiadie_V2_v1.1/tasks/P01-U01.md'),
        'source_files': [binding(p) for p in files], 'tracked_test_paths': tests,
        'persona_versions': len(ledger['versions']), 'private_archive_git_ignored': True,
        'model_generation_requests': 0, 'product_tests_run': False,
        'scope': 'source/version/receipt and persona archive checks only; not U02 or product acceptance',
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
