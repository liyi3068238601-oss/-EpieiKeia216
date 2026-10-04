import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(r'E:\Xiadie\Xiadie')
WORKTREE = ROOT / '.runtime/P02/worktrees/mature-integration'
BASELINE = '178379a8ad9c0c27f833a412ff06f7b0095bab79'
AUTHOR = '663de06378cc16328e4b87a682233b76d060d94a'
MANIFEST_REL = pathlib.Path('evidence/P02-U10/20261004-02/manifest.json')
MANIFEST = WORKTREE / MANIFEST_REL

def git(*args):
    return subprocess.check_output(['git', *args], cwd=WORKTREE)

assert git('rev-parse', 'HEAD').decode().strip() == AUTHOR
assert not git('status', '--porcelain').strip()
manifest_raw = MANIFEST.read_bytes()
manifest = json.loads(manifest_raw)
assert hashlib.sha256(manifest_raw).hexdigest() == '24b92096e9f80f6fd15ba130feebd68a53861de889911afb5a1d62801023cd67'
assert manifest['schema_version'] == 1 and manifest['task_id'] == 'P02-U10'
assert manifest['baseline_commit'] == BASELINE and manifest['branch'] == 'p02-mature-integration'
assert manifest['manifest_excludes_itself'] is True
entries = manifest['files']
assert len(entries) == 356
changed = [part.decode('utf-8') for part in git('diff', '--name-only', '-z', '--no-renames', BASELINE, AUTHOR).split(b'\0') if part]
assert len(changed) == 357 and len(set(changed)) == len(changed)
allowed = ('tests/integration/P02/', 'docs/evals/P02/', 'evidence/P02-U10/')
assert all(path.startswith(allowed) for path in changed), [path for path in changed if not path.startswith(allowed)]
assert MANIFEST_REL.as_posix() in changed
expected = {entry['path']: entry for entry in entries}
assert len(expected) == len(entries) and MANIFEST_REL.as_posix() not in expected
assert set(changed) - {MANIFEST_REL.as_posix()} == set(expected)
name_status = git('diff', '--name-status', '--no-renames', BASELINE, AUTHOR).decode().splitlines()
assert all(line.split('\t', 1)[0] in {'A', 'M'} for line in name_status)
requests = ''.join(f'{AUTHOR}:{path}\n' for path in sorted(expected)).encode('utf-8')
proc = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=WORKTREE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
stdout, stderr = proc.communicate(requests)
assert proc.returncode == 0, stderr.decode('utf-8', 'replace')
position = 0
mismatches = []
for name in sorted(expected):
    end = stdout.index(b'\n', position)
    oid, kind, size_text = stdout[position:end].decode('ascii').split(' ')
    size = int(size_text)
    position = end + 1
    raw = stdout[position:position + size]
    position += size
    assert stdout[position:position + 1] == b'\n'
    position += 1
    item = expected[name]
    disk = (WORKTREE / pathlib.PurePosixPath(name)).read_bytes()
    checks = {
        'git_blob': oid == item['git_blob'] and kind == 'blob',
        'git_bytes': len(raw) == item['bytes'] and hashlib.sha256(raw).hexdigest() == item['sha256'],
        'disk_bytes': len(disk) == item['bytes'] and hashlib.sha256(disk).hexdigest() == item['sha256'] and disk == raw,
    }
    if not all(checks.values()): mismatches.append({'path': name, 'checks': checks})
assert position == len(stdout)
assert not mismatches, mismatches[:5]
print(json.dumps({
  'schema': 'p02-u10-review-manifest-audit/v1',
  'authorCommit': AUTHOR, 'baselineCommit': BASELINE,
  'manifestSha256': hashlib.sha256(manifest_raw).hexdigest(),
  'manifestEntries': len(entries), 'changedPaths': len(changed),
  'scopePrefixes': list(allowed), 'pathsWithinScope': True,
  'gitBlobMatches': len(entries), 'gitRawBytesMatchManifest': len(entries),
  'worktreeBytesMatchGitAndManifest': len(entries), 'mismatches': [],
}, separators=(',', ':')))