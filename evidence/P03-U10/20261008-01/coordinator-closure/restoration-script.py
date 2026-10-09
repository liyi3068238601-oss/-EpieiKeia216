"""Restore only verified historical Git index cache snapshots, preserving drift."""
import datetime, hashlib, json, pathlib, stat, subprocess

root = pathlib.Path(r'E:\Xiadie\Xiadie')
archive = root / 'evidence/P03-U03/20261008-01/review'
retained = root / '.runtime/P03/reviews/u03-20261008'
proof = root / 'evidence/P03-U10/20261008-01/coordinator-closure'
assert not proof.exists()
receipt = json.loads((root / 'evidence/P03-U03/20261008-01/acceptance.json').read_bytes())
changes = []
sha = lambda raw: hashlib.sha256(raw).hexdigest()

for item in receipt['review_archive']:
    target = root / item['path']
    current = target.read_bytes()
    if len(current) == item['bytes'] and sha(current) == item['sha256']:
        continue
    assert target.name == 'index' and target.parent.name == '.git'
    assert target.resolve() == target and target.is_relative_to(archive)
    info = target.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    source = retained / target.relative_to(archive)
    assert source.resolve() == source and source.is_relative_to(retained)
    original = source.read_bytes()
    assert len(original) == len(current) == item['bytes'] == 145
    assert sha(original) == item['sha256']
    assert current[:12] == original[:12] and current[36:-20] == original[36:-20]
    assert hashlib.sha1(current[:-20]).digest() == current[-20:]
    assert hashlib.sha1(original[:-20]).digest() == original[-20:]
    changes.append((item, target, source, current, original))
assert len(changes) == 16
proof.mkdir()
records = []
for number, (item, target, source, current, original) in enumerate(changes, 1):
    before = proof / f'index-{number:02}-before.bin'
    frozen = proof / f'index-{number:02}-accepted.bin'
    for p, raw in ((before, current), (frozen, original)):
        with p.open('xb') as f:
            f.write(raw)
    # Guard the precise old bytes immediately before restoring the accepted copy.
    assert target.read_bytes() == current and source.read_bytes() == original
    target.write_bytes(original)
    assert target.read_bytes() == original
    records.append({'target': item, 'retained_source': str(source),
        'before': {'path': before.relative_to(root).as_posix(), 'bytes': len(current), 'sha256': sha(current)},
        'accepted_copy': {'path': frozen.relative_to(root).as_posix(), 'bytes': len(original), 'sha256': sha(original)},
        'changed_offsets': [i for i, (a, b) in enumerate(zip(current, original)) if a != b],
        'unchanged': 'Index header, entry blob, mode, path, size and extensions; only ctime/mtime stat-cache bytes and the checksum differed.'})
source_copy = proof / 'restoration-script.py'
with source_copy.open('xb') as f:
    f.write(pathlib.Path(__file__).read_bytes())
record = {'schema': 'p03-coordinator-index-snapshot-restoration/v1',
    'at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'head_before': subprocess.check_output(['git', '--no-optional-locks', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
    'restored': len(records), 'artifacts': records,
    'reason': 'Final full archival-byte check found only Git status stat-cache refresh in copied embedded test repositories. Every retained original matched its historical acceptance SHA before restoration.',
    'read_only_git': 'Final audit uses git --no-optional-locks; all original byte/hash checks remain enabled.',
    'reference': 'https://git-scm.com/docs/git-status#_background_refresh',
    'boundary': 'Historical acceptance records, review reports, fixture commits and source content are unchanged. Drift and exact accepted bytes are retained under new U10 evidence. These ignored embedded index snapshots are not product data.'}
with (proof / 'restoration.json').open('xb') as f:
    f.write((json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode())
print(json.dumps({'restored': len(records), 'preserved_before_and_accepted': len(records) * 2, 'proof': str(proof)}))
