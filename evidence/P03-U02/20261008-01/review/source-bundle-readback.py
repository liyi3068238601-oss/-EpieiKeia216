import hashlib, json, pathlib, subprocess, sys
root = pathlib.Path(r'E:\Xiadie\Xiadie')
pin = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
source = root / '.runtime/P01/desktop-source'
experiment = root / '.runtime/P03/experiments/u02-review-topology-20261008-01'
summary = json.loads((experiment / 'summary.json').read_text(encoding='utf-8'))
head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
status = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True)
assert head == pin and not status, {'head': head, 'status': status}
tree = subprocess.check_output(['git', '-C', str(source), 'ls-tree', '-r', '-z', pin])
blob_by_path = {}
for rec in tree.split(b'\0'):
    if not rec:
        continue
    meta, name = rec.split(b'\t', 1)
    mode, kind, oid = meta.decode('ascii').split(' ')
    if kind == 'blob':
        blob_by_path[name.decode('utf-8')] = oid
items = summary['compileInputs']
source_items = []
external_items = []
for item in items:
    p = pathlib.Path(item['path'])
    try:
        rel = p.relative_to(source).as_posix()
    except ValueError:
        external_items.append(item)
        continue
    assert rel in blob_by_path, f'compile input is not in pinned tree: {rel}'
    source_items.append((rel, item, blob_by_path[rel], p.read_bytes()))
blob_input = ''.join(oid + '\n' for _, _, oid, _ in source_items).encode('ascii')
proc = subprocess.run(['git', '-C', str(source), 'cat-file', '--batch'], input=blob_input, capture_output=True, check=True)
raw = proc.stdout
pos = 0
matches, mismatches = [], []
for rel, item, oid, disk in source_items:
    end = raw.index(b'\n', pos)
    oid2, kind, size_s = raw[pos:end].decode('ascii').split(' ')
    size = int(size_s)
    pos = end + 1
    blob = raw[pos:pos+size]
    pos += size + 1
    check = {'path': rel, 'bytes': len(disk), 'recorded_sha256': item['sha256'],
             'disk_sha256': hashlib.sha256(disk).hexdigest(), 'git_blob_sha256': hashlib.sha256(blob).hexdigest(),
             'git_blob_oid': oid2}
    if oid2 != oid or disk != blob or len(disk) != item['bytes'] or hashlib.sha256(disk).hexdigest() != item['sha256']:
        mismatches.append(check)
    matches.append(check)
for item in external_items:
    p = pathlib.Path(item['path'])
    data = p.read_bytes()
    check = {'path': str(p), 'bytes': len(data), 'recorded_sha256': item['sha256'], 'disk_sha256': hashlib.sha256(data).hexdigest()}
    if len(data) != item['bytes'] or check['disk_sha256'] != item['sha256']:
        mismatches.append(check)
assert len(items) == 280 and len(source_items) == 279 and len(external_items) == 1
result = {'status': 'pass' if not mismatches else 'fail', 'native_pin': pin, 'source_head': head,
          'source_clean': not status, 'compile_input_count': len(items), 'pinned_native_source_count': len(source_items),
          'synthetic_entry_count': len(external_items), 'pinned_source_matches': len(matches)-len([m for m in mismatches if 'git_blob_oid' in m]),
          'external_entry_matches': len(external_items)-len([m for m in mismatches if 'git_blob_oid' not in m]),
          'mismatches': mismatches,
          'key_inputs': [x for x in matches if x['path'].endswith(('memoryService.ts','projectMemoryStableRead.ts','paths.ts','project-root.ts','index-content.ts'))]}
print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
if mismatches:
    sys.exit(1)
