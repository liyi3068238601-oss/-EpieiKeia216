import hashlib, json, pathlib, subprocess, sys
root=pathlib.Path(r'E:\Xiadie\Xiadie')
wt=pathlib.Path(sys.argv[1]); baseline=sys.argv[2]; author=sys.argv[3]; ev=wt/'evidence/P02-U05/20261003-01'
sha=lambda b:hashlib.sha256(b).hexdigest()
git=lambda *args:subprocess.check_output(['git',*args],cwd=wt)
manifest_raw=(ev/'manifest.json').read_bytes(); manifest=json.loads(manifest_raw); baseline_doc=json.loads((ev/'baseline.json').read_bytes()); index=json.loads((ev/'command-index.json').read_bytes())
changed=set(git('diff','--name-only',baseline,author).decode().splitlines())
manifest_names={item['path'] for item in manifest['files']}
scoped=lambda p:(p.startswith('packages/storage/events/') or p.startswith('migrations/') or p in {'tsconfig.json','tools/run-tests.mjs'} or p.startswith('evidence/P02-U05/'))
wrong_scope=sorted(p for p in changed if not scoped(p))
coverage_ok=manifest_names==changed-{'evidence/P02-U05/20261003-01/manifest.json'}
run_root=pathlib.Path(index['source']); command_mismatches=[]
for item in index['files']:
    archived=ev/item['path']; original=run_root/pathlib.Path(item['path']).name
    for label,p in [('archive',archived),('run',original)]:
        if not p.is_file(): command_mismatches.append({'path':str(p),'issue':'missing'}); continue
        data=p.read_bytes()
        if len(data)!=item['bytes'] or sha(data)!=item['sha256']:
            command_mismatches.append({'path':str(p),'issue':'bytes-or-sha'})
base_inputs=[]
for item in [baseline_doc['card'],baseline_doc['source_lock'],baseline_doc['prerequisites'][0]['acceptance']]:
    data=git('show',f"{baseline}:{item['path']}")
    record={'path':item['path'],'bytes':len(data),'sha256':sha(data),'baseline_bytes_match':len(data)==item['bytes'],'baseline_sha_match':sha(data)==item['sha256']}
    if record['baseline_bytes_match'] and record['baseline_sha_match']:
        try:
            current=(root/item['path']).read_bytes()
            record['root_path_matches']=len(current)==len(data) and sha(current)==sha(data)
        except FileNotFoundError: record['root_path_matches']=False
    base_inputs.append(record)
head=git('rev-parse','HEAD').decode().strip(); branch=git('branch','--show-current').decode().strip(); clean=not git('status','--porcelain').strip()
ancestor=subprocess.run(['git','merge-base','--is-ancestor',baseline,author],cwd=wt).returncode==0
implementation_files=set(git('diff','--name-only','33d2c121db735f89bf639dd36c54724f0ed4a4f4',author).decode().splitlines())
history_ok=bool(implementation_files) and all(p.startswith('evidence/P02-U05/') for p in implementation_files)
result={
 'schema':'p02-u05-freeze-index-audit/v1','head':head,'branch':branch,'clean':clean,
 'baseline_is_ancestor':ancestor,'manifest_sha256':sha(manifest_raw),'manifest_files':len(manifest['files']),
 'changed_paths':len(changed),'manifest_coverage_exact':coverage_ok,'scope_mismatches':wrong_scope,
 'command_index_count':index['count'],'command_entries':len(index['files']),'command_record_mismatches':command_mismatches,
 'baseline_inputs':base_inputs,'post_implementation_changes_evidence_only':history_ok,
 'post_implementation_changed_paths':sorted(implementation_files)}
result['passed']= (head==author and branch=='p02-u05' and clean and ancestor and len(manifest['files'])==55 and len(changed)==56 and coverage_ok and not wrong_scope and sha(manifest_raw)=='f3c888a158c75ea27c2daf9d248fab8422a3b07971869cc6ec13fee6666c5f57' and index['count']==42 and len(index['files'])==42 and not command_mismatches and all(x['baseline_bytes_match'] and x['baseline_sha_match'] for x in base_inputs) and history_ok)
print(json.dumps(result,ensure_ascii=False,indent=2))
if not result['passed']: sys.exit(1)
