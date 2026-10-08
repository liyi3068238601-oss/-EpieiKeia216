import collections, hashlib, json, pathlib, subprocess, sys
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
    if rec:
        meta, name = rec.split(b'\t', 1)
        mode, kind, oid = meta.decode('ascii').split(' ')
        if kind == 'blob':
            blob_by_path[name.decode('utf-8')] = oid
tracked, ignored, external = [], [], []
for item in summary['compileInputs']:
    path = pathlib.Path(item['path'])
    disk = path.read_bytes()
    if not path.is_relative_to(source):
        external.append((item, disk))
        continue
    rel = path.relative_to(source).as_posix()
    if rel in blob_by_path:
        tracked.append((rel, item, blob_by_path[rel], disk))
    else:
        ignored.append((rel, item, disk))
blob_input = ''.join(oid + '\n' for _, _, oid, _ in tracked).encode('ascii')
proc = subprocess.run(['git', '-C', str(source), 'cat-file', '--batch'], input=blob_input, capture_output=True, check=True)
raw, pos, mismatches = proc.stdout, 0, []
tracked_hashes = []
for rel, item, oid, disk in tracked:
    end = raw.index(b'\n', pos)
    blob_oid, kind, size_s = raw[pos:end].decode('ascii').split(' ')
    size = int(size_s)
    pos = end + 1
    blob = raw[pos:pos+size]
    pos += size + 1
    entry = {'path': rel, 'bytes': len(disk), 'recorded_sha256': item['sha256'],
             'disk_sha256': hashlib.sha256(disk).hexdigest(), 'blob_sha256': hashlib.sha256(blob).hexdigest()}
    tracked_hashes.append(entry)
    if blob_oid != oid or disk != blob or len(disk) != item['bytes'] or entry['disk_sha256'] != item['sha256']:
        mismatches.append(entry)
ignored_hashes = []
for rel, item, disk in ignored:
    ignored_by = subprocess.run(['git', '-C', str(source), 'check-ignore', '-q', '--', rel]).returncode == 0
    entry = {'path': rel, 'bytes': len(disk), 'recorded_sha256': item['sha256'],
             'disk_sha256': hashlib.sha256(disk).hexdigest(), 'git_ignored': ignored_by}
    ignored_hashes.append(entry)
    if not ignored_by or len(disk) != item['bytes'] or entry['disk_sha256'] != item['sha256']:
        mismatches.append(entry)
external_hashes = []
for item, disk in external:
    entry = {'path': item['path'], 'bytes': len(disk), 'recorded_sha256': item['sha256'], 'disk_sha256': hashlib.sha256(disk).hexdigest()}
    external_hashes.append(entry)
    if len(disk) != item['bytes'] or entry['disk_sha256'] != item['sha256']:
        mismatches.append(entry)
assert (len(summary['compileInputs']), len(tracked), len(ignored), len(external)) == (280, 183, 96, 1)
lock = source / 'pnpm-lock.yaml'
lock_bytes = lock.read_bytes()
lock_text = lock_bytes.decode('utf-8')
locked = {f'{name}@{version}': f'{name}@{version}:' in lock_text for name, version in [('zod','4.6.5'),('marked','16.4.2'),('esbuild','0.27.7')]}
packages = {name: json.loads((source / 'node_modules' / name / 'package.json').read_text(encoding='utf-8'))['version'] for name in ['zod','marked','esbuild']}
if not all(locked.values()) or packages != {'zod':'4.6.5','marked':'16.4.2','esbuild':'0.27.7'}:
    mismatches.append({'locked':locked,'installed':packages})
key_suffixes = ('memoryService.ts','projectMemoryStableRead.ts','paths.ts','project-root.ts','index-content.ts')
result = {'status':'pass' if not mismatches else 'fail','native_pin':pin,'source_head':head,'source_clean':not status,
          'compile_input_count':len(summary['compileInputs']),'tracked_git_blob_inputs':len(tracked),
          'ignored_node_modules_inputs':len(ignored),'synthetic_entry_inputs':len(external),
          'tracked_blob_matches':len(tracked_hashes)-sum(1 for m in mismatches if 'blob_sha256' in m),
          'ignored_input_hash_matches':len(ignored_hashes)-sum(1 for m in mismatches if 'git_ignored' in m),
          'external_input_hash_matches':len(external_hashes)-sum(1 for m in mismatches if 'path' in m and 'blob_sha256' not in m and 'git_ignored' not in m),
          'dependency_versions':packages,'dependency_versions_present_in_pinned_lock':locked,
          'pnpm_lock_sha256':hashlib.sha256(lock_bytes).hexdigest(),'key_git_blob_inputs':[x for x in tracked_hashes if x['path'].endswith(key_suffixes)],
          'mismatches':mismatches}
print(json.dumps(result, ensure_ascii=False, separators=(',',':')))
if mismatches:
    sys.exit(1)
