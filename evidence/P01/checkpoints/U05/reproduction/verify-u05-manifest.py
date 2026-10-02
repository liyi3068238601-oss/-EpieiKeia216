import hashlib, json, pathlib, subprocess, sys

root = pathlib.Path(sys.argv[1]).resolve()
commit = sys.argv[2]
out = pathlib.Path(sys.argv[3])
assert not out.exists(), 'Do not overwrite a verification result'
manifest_path = 'evidence/P01-U05/20261001-01/manifest.json'
data = (root / manifest_path).read_bytes()
manifest = json.loads(data)
assert manifest['file_count'] == len(manifest['files'])
sha = lambda value: hashlib.sha256(value).hexdigest()
git = lambda *args: subprocess.check_output(['git', '-C', str(root), *args])
assert data == git('show', f'{commit}:{manifest_path}')
paths = [item['path'] for item in manifest['files']]
assert len(paths) == len(set(paths))
mismatches = []
for item in manifest['files']:
    p = root / item['path']
    assert p.resolve().is_relative_to(root)
    disk = p.read_bytes()
    blob = git('show', f"{commit}:{item['path']}")
    oid = git('rev-parse', f"{commit}:{item['path']}").decode().strip()
    if len(disk) != item['bytes'] or sha(disk) != item['sha256'] or disk != blob or oid != item['git_blob']:
        mismatches.append(item['path'])
changed = set(git('diff', '--name-only', manifest['baseline_commit'], commit).decode().splitlines())
excluded = {manifest_path, 'evidence/P01-U05/20261001-01/manifest.sha256'}
assert changed - excluded == set(paths), 'Manifest must bind every author change except itself and sidecar'
allowed = {
    'packages/context/src/index.ts', 'packages/context/test/context.test.mjs',
    'packages/context/test/contract.test.mjs', 'packages/context/test/integration.test.mjs',
    'packages/context/test/readonly.type-fixture.ts', 'packages/contracts/src/context.ts',
    'packages/contracts/src/index.ts', 'tools/run-tests.mjs', 'tsconfig.json',
}
assert all(p in allowed or p.startswith('evidence/P01-U05/20261001-01/') for p in changed)
sidecar = (root / 'evidence/P01-U05/20261001-01/manifest.sha256').read_text().split()[0]
assert sidecar == sha(data)
assert not mismatches
result = {'author_commit': commit, 'baseline_commit': manifest['baseline_commit'], 'cwd': str(root),
          'manifest': {'path': manifest_path, 'bytes': len(data), 'sha256': sha(data)},
          'files': len(paths), 'changed_files': len(changed), 'disk_and_commit_mismatches': mismatches,
          'complete_change_coverage': True, 'scope_check': 'pass'}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps(result, ensure_ascii=False))
