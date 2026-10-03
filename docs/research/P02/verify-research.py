"""Recheck the explicitly indexed, read-only P02-U01 source snapshots."""
import argparse
import csv
import hashlib
import json
import pathlib
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--source-root', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
source_root = pathlib.Path(a.source_root).resolve()
document_root = pathlib.Path(__file__).resolve().parent
records = []
for row in csv.DictReader((document_root / 'runtime-inputs.sha256.csv').open(encoding='utf-8-sig', newline='')):
    records.append((pathlib.Path(row['path']), int(row['bytes']), row['sha256']))
for line in (document_root / 'sqlite-local-sha256.txt').read_text(encoding='utf-8').splitlines():
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    digest, name = line.split('  ', 1)
    assert len(digest) == 64 and all(c in '0123456789abcdef' for c in digest)
    records.append((source_root / name, None, digest))
local = json.loads((document_root / 'coordinator-local-source-index.json').read_bytes())
for row in local['files']:
    records.append((source_root / row['path'], row['bytes'], row['sha256']))
for path, size, digest in records:
    path = path.resolve()
    assert path.is_relative_to(source_root), f'Indexed source outside owned root: {path}'
    raw = path.read_bytes()
    assert size is None or len(raw) == size, str(path)
    assert hashlib.sha256(raw).hexdigest() == digest, str(path)
pins = {
    'references/zcode-29628c9': '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
    '.runtime/P01/desktop-source': '29628c9acdb81b703bbd4080c207a0e7ce5e276e',
    'references/herta-4623df12': '4623df120adf99340ce5f7e25ed829466975e3ae',
    'references/dsh-639ed015': '639ed015397290b3745d163aafe02ffee4aa3f84',
}
for name, pin in pins.items():
    tree = source_root / name
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=tree).decode().strip() == pin
    assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=tree).strip()
result = {'status': 'pass', 'checks': 'Source hashes, pinned commits and clean reference trees only.',
          'source_root': str(source_root), 'indexed_file_observations_verified': len(records),
          'pinned_clean_trees_verified': len(pins), 'product_test': 'NOT_RUN', 'model_calls': 0,
          'mismatches': []}
pathlib.Path(a.output).write_bytes((json.dumps(result, indent=2) + '\n').encode())
print(json.dumps(result))
