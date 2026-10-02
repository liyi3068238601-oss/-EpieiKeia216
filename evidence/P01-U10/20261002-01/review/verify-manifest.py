from pathlib import Path
import hashlib, json, subprocess

ROOT = Path(r'E:\Xiadie\Xiadie')
WT = ROOT / r'.runtime\P01\worktrees\u10-review'
AUTHOR = '8d1d437ca5260d139541ac1237a554cf9ee6c419'
BASE = '1dee2d18b684f602aa6dacd3f6049f35cf14d262'
MANIFEST = 'evidence/P01-U10/20261002-01/manifest.json'
OUT = ROOT / r'.runtime\P01\u10-review\final-8d1d437\manifest-verification.json'

def read_long(path: Path) -> bytes:
    value = str(path.resolve())
    if not value.startswith('\\\\?\\'):
        value = '\\\\?\\' + value
    return Path(value).read_bytes()

def git(*args, input=None, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd, input=input)

assert git('rev-parse', 'HEAD', cwd=WT).decode().strip() == AUTHOR
assert not git('status', '--porcelain', cwd=WT).strip()
manifest_bytes = git('show', f'{AUTHOR}:{MANIFEST}')
assert manifest_bytes == read_long(WT / MANIFEST)
manifest = json.loads(manifest_bytes)
entries = manifest['files']
changed = set(git('diff', '--name-only', BASE, AUTHOR).decode().splitlines())
assert {e['path'] for e in entries} == changed - {MANIFEST}
batch_input = ('\n'.join(f"{AUTHOR}:{e['path']}" for e in entries) + '\n').encode()
batch = git('cat-file', '--batch', input=batch_input)
offset = 0
for e in entries:
    header_end = batch.index(b'\n', offset)
    oid, kind, size_s = batch[offset:header_end].decode().split(' ')
    size = int(size_s)
    assert kind == 'blob'
    offset = header_end + 1
    blob = batch[offset:offset + size]
    offset += size
    assert batch[offset:offset + 1] == b'\n'
    offset += 1
    disk = read_long(WT / e['path'])
    assert blob == disk, e['path']
    assert len(blob) == e['bytes'], e['path']
    assert hashlib.sha256(blob).hexdigest() == e['sha256'], e['path']
    assert oid == e['git_blob'], e['path']
assert offset == len(batch)
result = {
  'author_commit': AUTHOR,
  'baseline_commit': BASE,
  'reviewer_worktree': str(WT),
  'reviewer_worktree_clean': True,
  'manifest_path': str(WT / MANIFEST),
  'manifest_entries': len(entries),
  'changed_paths': len(changed),
  'manifest_bytes': len(manifest_bytes),
  'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
  'disk_git_manifest_mismatches': [],
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
