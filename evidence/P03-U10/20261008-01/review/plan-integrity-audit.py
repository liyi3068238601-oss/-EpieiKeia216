import hashlib, json, pathlib, zipfile
root = pathlib.Path(r'E:\Xiadie\Xiadie')
plan = root / 'planning/Xiadie_V2_v1.1'
manifest_path = plan / 'PACKAGE_MANIFEST.json'
manifest_bytes = manifest_path.read_bytes()
manifest = json.loads(manifest_bytes)
archive = root / 'Xiadie_V2_计划与执行包_v1.1.zip'
archive_bytes = archive.read_bytes()
def sha(b): return hashlib.sha256(b).hexdigest()
failures = []
verified = 0
with zipfile.ZipFile(archive) as zipped:
    names = zipped.namelist()
    for item in manifest['files']:
        rel = item['path']
        actual = (plan / rel).read_bytes()
        if len(actual) != item['bytes'] or sha(actual) != item['sha256']:
            failures.append({'path': rel, 'check': 'extracted-bytes'})
            continue
        matches = [name for name in names if name == rel or name.endswith('/' + rel)]
        if len(matches) != 1 or zipped.read(matches[0]) != actual:
            failures.append({'path': rel, 'check': 'archive-bytes', 'matches': len(matches)})
            continue
        verified += 1
out = pathlib.Path(r'E:\Xiadie\Xiadie\.runtime\P03\reviews\u10-independent-20261009\plan-integrity-audit.json')
record = {
    'schema': 'p03-plan-integrity-audit/v1',
    'plan_root': str(plan),
    'plan_manifest': {'path': str(manifest_path), 'bytes': len(manifest_bytes), 'sha256': sha(manifest_bytes)},
    'archive': {'path': str(archive), 'bytes': len(archive_bytes), 'sha256': sha(archive_bytes)},
    'required_count': len(manifest['files']),
    'verified_count': verified,
    'mismatches': failures,
    'boundary': 'Read-only raw-byte SHA-256 comparison of the authoritative extracted v1.1 plan against its original ZIP; hashes identify bytes, not licensing or authorization.'
}
if out.exists(): raise SystemExit('output_exists')
out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'verified_count': verified, 'required_count': len(manifest['files']), 'mismatches': len(failures), 'output': str(out)}, ensure_ascii=False))
