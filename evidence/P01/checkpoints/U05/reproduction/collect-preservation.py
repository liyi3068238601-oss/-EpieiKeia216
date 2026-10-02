import datetime, hashlib, json, pathlib, subprocess, sys, zipfile

root = pathlib.Path(r'E:\Xiadie\Xiadie')
out = root / '.runtime/P01/pause' / (sys.argv[1] if len(sys.argv) > 1 else 'preservation.json')
assert out.resolve().is_relative_to((root / '.runtime/P01/pause').resolve())
assert not out.exists(), 'Preserve prior check output'
sha = lambda data: hashlib.sha256(data).hexdigest()
zip_path = root / 'Xiadie_V2_计划与执行包_v1.1.zip'
zip_sha = sha(zip_path.read_bytes())
assert zip_sha == '3fcc323f433c222a3b4c651d0661dfd0f1eeb4577ded0e07436821fc7e9c22ab'
plan = root / 'planning/Xiadie_V2_v1.1'
compared, mismatch = [], []
with zipfile.ZipFile(zip_path) as archive:
    for item in archive.infolist():
        if item.is_dir():
            continue
        name = item.filename.replace('\\', '/')
        marker = 'Xiadie_V2_v1.1/'
        assert marker in name, name
        rel = name.split(marker, 1)[1]
        p = plan / rel
        assert p.resolve().is_relative_to(plan.resolve())
        original = archive.read(item)
        actual = p.read_bytes()
        compared.append({'path': p.relative_to(root).as_posix(), 'bytes': len(actual), 'sha256': sha(actual)})
        if actual != original:
            mismatch.append(rel)
assert len(compared) == 424 and not mismatch
ledger = json.loads((root / 'docs/research/P01/persona-versions.json').read_text(encoding='utf-8'))
versions = []
for item in ledger['versions']:
    data = (root / item['path']).read_bytes()
    matched = len(data) == item['bytes'] and sha(data) == item['sha256']
    assert matched
    versions.append({'version': item['version'], 'path': item['path'], 'bytes': len(data), 'sha256': sha(data), 'unchanged': matched, 'private': item['version'] == 'v0'})
original_path = pathlib.Path(r'D:\Mofox\Neo-MoFox\bot-3541647704\neo-mofox\config\core.toml')
original = original_path.read_bytes()
assert sha(original) == ledger['source_file_sha256']
sources = []
for rel, expected in [
    ('references/zcode-29628c9', '29628c9acdb81b703bbd4080c207a0e7ce5e276e'),
    ('references/dsh-639ed015', '639ed015397290b3745d163aafe02ffee4aa3f84'),
    ('references/herta-4623df12', '4623df120adf99340ce5f7e25ed829466975e3ae'),
    ('.runtime/P01/desktop-source', '29628c9acdb81b703bbd4080c207a0e7ce5e276e'),
]:
    p = root / rel
    head = subprocess.check_output(['git', '-C', str(p), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(p), 'status', '--porcelain'], text=True)
    assert head == expected and not dirty
    sources.append({'path': rel, 'commit': head, 'clean': True})
calls_path = root / 'evidence/P01/model-calls.jsonl'
calls = [json.loads(line) for line in calls_path.read_text(encoding='utf-8').splitlines() if line.strip()]
assert len(calls) == 4
result = {
    'checked_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Read-only preservation/hash checks; private source bytes only hashed, not copied or printed',
    'authoritative_zip': {'path': zip_path.name, 'sha256': zip_sha},
    'plan_files_checked': len(compared), 'plan_mismatches': mismatch,
    'plan_files': compared, 'persona_versions': versions,
    'original_production_persona': {'bytes': len(original), 'sha256': sha(original), 'unchanged': True},
    'fixed_sources': sources,
    'model_calls': {'path': calls_path.relative_to(root).as_posix(), 'bytes': calls_path.stat().st_size, 'sha256': sha(calls_path.read_bytes()), 'generation_calls': len(calls)},
}
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'plan_files': len(compared), 'mismatches': len(mismatch), 'versions': len(versions), 'fixed_sources': len(sources), 'generation_calls': len(calls), 'out': str(out)}))
