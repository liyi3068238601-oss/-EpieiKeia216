import json,pathlib,hashlib,subprocess,os,datetime
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie').resolve(); WT=ROOT/'.runtime/P02/worktrees/mature-freeze'; REV=ROOT/'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004'
ATT='20261004-02'; AUTHOR='e11e7343e8f3dd15f7420ceb14bdf7c6e3dec241'; BASE='b95cfd2be02959dd8c390e2b141d24d1093daf81'; MSHA='eaefb0ef6d844a6674959a4ae6db9e5befd4ccd9bc479fabe21dca915dceba3a'; E=WT/'evidence/P02-U11'/ATT
read=lambda p:pathlib.Path(p).read_bytes(); sha=lambda b:hashlib.sha256(b).hexdigest()
def git(cwd,*args): return subprocess.check_output(['git',*args],cwd=cwd).decode().strip()
def file_entry(path,root,expected=None):
 p=pathlib.Path(path)
 if root=='author_worktree' and not p.is_absolute(): p=WT/p
 elif root=='baseline_repository' and not p.is_absolute(): p=ROOT/p
 elif root=='review_directory' and not p.is_absolute(): p=REV/p
 else: p=p.resolve()
 b=read(p)
 if expected and (len(b)!=expected['bytes'] or sha(b)!=expected['sha256']): raise RuntimeError(f'file changed: {p}')
 return {'path':str(path) if pathlib.Path(path).is_absolute() else pathlib.Path(path).as_posix(),'root':root,'bytes':len(b),'sha256':sha(b)}
# Preserve the successfully verified expanded report as historical review output, then issue the compact report.
old=REV/'review-final.json'; expanded=REV/'review-final-expanded.json'
if old.exists():
 if expanded.exists(): raise SystemExit('expanded report already exists')
 old.replace(expanded)
manifest_path=WT/f'evidence/P02-U11/{ATT}/manifest.json'; mraw=read(manifest_path); manifest=json.loads(mraw)
if sha(mraw)!=MSHA or len(manifest['files'])!=220: raise RuntimeError('author manifest changed')
rowmap={r['path']:r for r in manifest['files']}
# Recheck exact clean target without touching either tree.
if git(ROOT,'rev-parse','HEAD')!=BASE or git(ROOT,'status','--porcelain','--untracked-files=all'): raise RuntimeError('baseline tree moved or dirty')
if git(WT,'rev-parse','HEAD')!=AUTHOR or git(WT,'status','--porcelain','--untracked-files=all'): raise RuntimeError('author tree moved or dirty')
# Focused files let the manifest and author verifier carry the rest of the exact scope.
author_paths=[
 'docs/releases/0.2.0/README.md','docs/releases/0.2.0/freeze.json','docs/releases/0.2.0/history/20261003-01/README.md','docs/releases/0.2.0/history/20261003-01/freeze.json',
 f'evidence/P02-U11/{ATT}/result.md',f'evidence/P02-U11/{ATT}/baseline.json',f'evidence/P02-U11/{ATT}/prerequisite-audit.json',f'evidence/P02-U11/{ATT}/candidate-material-audit.json',f'evidence/P02-U11/{ATT}/candidate-proof-index.json',f'evidence/P02-U11/{ATT}/runtime-raw-candidate09/index.json',f'evidence/P02-U11/{ATT}/historical-release-copy.json',f'evidence/P02-U11/{ATT}/command-index.json',f'evidence/P02-U11/{ATT}/source-decision.md',f'evidence/P02-U11/{ATT}/rollback.md',f'evidence/P02-U11/{ATT}/diff.json',
 f'evidence/P02-U11/{ATT}/candidate-proof/candidate-descriptor.json',f'evidence/P02-U11/{ATT}/candidate-proof/runs/full/summary.json',f'evidence/P02-U11/{ATT}/candidate-proof/runs/degradation/summary.json',f'evidence/P02-U11/{ATT}/candidate-proof/runs/full/scenarios/success/scenario-result.json',f'evidence/P02-U11/{ATT}/candidate-proof/runs/full/scenarios/success/ledger-verification.json',f'evidence/P02-U11/{ATT}/candidate-proof/runs/full/p02-desktop-runner.json',f'evidence/P02-U11/{ATT}/candidate-proof/runs/degradation/p02-desktop-runner.json',
]
artifacts=[]
for p in author_paths:
 if p not in rowmap: raise RuntimeError(f'expected author manifest entry missing: {p}')
 artifacts.append(file_entry(p,'author_worktree',rowmap[p]))
artifacts.append(file_entry(f'evidence/P02-U11/{ATT}/manifest.json','author_worktree',{'bytes':len(mraw),'sha256':MSHA}))
review_files=[
 'author-verification.json','author-verification-command.json',
 'readback-audit-final.json','u11-independent-audit-v3.py','readback-audit-final-command.json',
 'backup-readback.json','backup-readback.py','backup-readback-command.json',
 'readback-audit.json','u11-independent-audit.py','readback-audit-v1-command.json',
 'readback-audit-v2.json','u11-independent-audit-v2.py','readback-audit-v2-command.json',
 'write-review-final-compact.py',
]
if expanded.exists(): review_files.append('review-final-expanded.json')
for name in review_files: artifacts.append(file_entry(name,'review_directory'))
# Immutable prerequisites and selected runtime/license inputs: compact paths, full verification remains in readback audit.
status_path=ROOT/'evidence/P02/status.json'; status=json.loads(read(status_path)); pre=json.loads(read(E/'prerequisite-audit.json'))
immutable=[file_entry('evidence/P02/status.json','baseline_repository',{'bytes':len(read(status_path)),'sha256':sha(read(status_path))})]
for key in ['plan_manifest','source_lock','card','historical_g01']:
 r=pre[key]; immutable.append(file_entry(r['path'],'baseline_repository',r))
for i in range(1,11):
 task=status['tasks'][i-1]
 if task['id']!=f'P02-U{i:02d}' or task['status']!='accepted': raise RuntimeError('canonical accepted prerequisite mismatch')
 for b in [task['acceptance'],task['review']['evidence']]: immutable.append(file_entry(b['path'],'baseline_repository',b))
# Immutable source rows that show event-store/backup implementation and the builder/runtime qualification chain.
mat=json.loads(read(E/'candidate-material-audit.json'))
selected_inputs={'packages/storage/events/src/sqlite.ts','packages/storage/events/src/index.ts','packages/storage/backup/src/index.ts','migrations/001-event-store.ts','tests/integration/P02/build-candidate.mjs','tests/integration/P02/desktop.py','tests/integration/P02/desktop-ui.mjs','tests/integration/P02/verify-ledger.mjs','tests/integration/P02/registry-write-guard.cjs','tests/integration/P02/desktop-main-guard.cjs','tests/integration/P02/factory-entry.mjs','tests/integration/P02/durable-host.mjs','package.json','pnpm-lock.yaml'}
for r in mat['inputs']:
 if r['path'] in selected_inputs: immutable.append(file_entry(r['path'],'baseline_repository',{'bytes':r['bytes'],'sha256':r['sha256']}))
# Candidate-specific descriptor and actual licensed addon/metadata. No 6,717-file rehash here.
desc_path=pathlib.Path(mat['descriptor']['path']); desc=json.loads(read(desc_path)); croot=pathlib.Path(desc['assemblyRoot']); sqlite=desc['sqliteRuntime']
def cp(v):
 p=pathlib.Path(v); return p if p.is_absolute() else croot/p
immutable.append(file_entry(desc_path,'absolute'))
for p in [cp(sqlite['addonPath']),cp(sqlite['licensePath']),cp(pathlib.Path(sqlite['packageRoot'])/'package.json')]: immutable.append(file_entry(p,'absolute'))
freeze=json.loads(read(WT/'docs/releases/0.2.0/freeze.json'))
for legal in [freeze['upstream_license'],freeze['third_party_notices']]:
 p=cp(legal['path']); immutable.append(file_entry(p,'absolute',{'bytes':p.stat().st_size,'sha256':legal['sha256']}))
# Deduplicate path+same hash; avoid enumerating the already audited 423/139/42 rows here.
def normalized(item):
 p=pathlib.Path(item['path'])
 if not p.is_absolute(): p={'baseline_repository':ROOT,'author_worktree':WT,'review_directory':REV}.get(item['root'],ROOT)/p
 return os.path.normcase(str(p.resolve()))
unique={}
for item in immutable:
 k=normalized(item)
 if k in unique and (unique[k]['bytes'],unique[k]['sha256'])!=(item['bytes'],item['sha256']): raise RuntimeError('conflicting immutable entry')
 unique.setdefault(k,item)
immutable=list(unique.values())
readback=json.loads(read(REV/'readback-audit-final.json')); backup=json.loads(read(REV/'backup-readback.json'))
if readback['decision']!='pass' or backup['decision']!='pass': raise RuntimeError('readback audit not pass')
report={
 'schema':'p02-independent-review/v1','created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'task':'P02-U11','decision':'pass',
 'review_target':{'author_commit':AUTHOR,'baseline_commit':BASE,'author_worktree':str(WT),'attempt':ATT,'manifest_path':f'evidence/P02-U11/{ATT}/manifest.json','manifest_sha256':MSHA,'manifest_files':220},
 'reviewer':'Codex independent readback','scope':'Read-only verification of U11 exact author tree, canonical prerequisites, reused U10 candidate source binding, fresh full6/degradation3 runtime evidence, backup readback and bounded support claims.',
 'checks':[
  {'id':'manifest-scope-clean-author','status':'pass','detail':'Exact e11e7343 author at b95cfd2 baseline; manifest eaefb0ef covers 220 files and 221 paths in allowed docs/evidence scope; author verify clean with zero mismatches.'},
  {'id':'canonical-ten-and-423-plan','status':'pass','detail':'U01-U10 receipts/reviews accepted and hash matched; canonical status remains U11 running/G02 pending/P03 not started; 423 planning files checked against source manifest and immutable references.'},
  {'id':'103-candidate-material-and-mature-binding','status':'pass','detail':'All 103 source inputs were checked against baseline/material Git blobs and descriptor; U10 candidate descriptor 6d66ef... plus accepted 6717-file closure reused, no full closure rehash. Better 13.0.3 / SQLite 3.53.4 / addon and legal hashes matched.'},
  {'id':'fresh-runtime-nine-and-raw-evidence','status':'pass','detail':'Fresh 6/6+3/3 scenarios pass; all nine main/CLI PID, guard, alias and applicable real addon probes agree. 139 archived proof files and 42 runtime sidecars were compared with originals byte-for-byte; both suites’ nine-key pre/post snapshots match.'},
  {'id':'success-backup-and-restoration','status':'pass','detail':'Success ledger verification report is raw-byte provenanced; backup/restore passed snapshot-v1-only, backup/restored DB SHA equal, user/schema version 1, integrity and FK checks ok; canonical table counts and hashes present.'},
  {'id':'source-docs-license-history-and-limits','status':'pass','detail':'README/freeze/result/source-decision/rollback requirements align with source/prompt/schema and license bindings; old 20261003-01 README/freeze are byte-identical Git blobs. Actual CLI qualification is Electron41 ELECTRON_RUN_AS_NODE=1, not fixed Node; reader’s stale phrase is explicitly disqualified.'},
  {'id':'reviewer-script-failure-preserved','status':'pass','detail':'Two earlier reviewer harness reports remain archived. Their blocks came from reviewer-side schema/path/count assertions corrected by the final readback script; no product/run failure is attributed to them.'},
 ],
 'reviewer_readback':{'report_path':str(REV/'readback-audit-final.json'),'sha256':sha(read(REV/'readback-audit-final.json')),'script_path':str(REV/'u11-independent-audit-v3.py'),'script_sha256':sha(read(REV/'u11-independent-audit-v3.py')),'command_path':str(REV/'readback-audit-final-command.json'),'backup_readback_path':str(REV/'backup-readback.json'),'backup_readback_sha256':sha(read(REV/'backup-readback.json')),'scenario_passes':'9/9','proof_archives':'139 byte-identical','runtime_sidecars':'42 byte-identical'},
 'limitations':['Main-process effect guard is test-harness instrumentation, not an OS sandbox; ordinary Native startup is not qualified by it.','disabled_native bypasses the P02 durable wrapper; its two loopback requests are Native fallback, not P02 ledger facts.','Independent Node ledger verifier contains a legacy “fixed Node CLI” phrase; actual identity is supported by Desktop runner and PID-bound addon probes.','The new onboarding-timeout fallback was not observed in this run.','Native session storage remains on node:sqlite; no paid model route, real credentials, DSH, installer/portable package, human visual acceptance, physical power loss, or universal OS/filesystem crash behavior was tested.','Unit161 and Native8 were accepted U10 evidence and not rerun; G02 is still pending and P03 has not started.'],
 'artifacts':artifacts,'immutable_inputs':immutable
}
out=REV/'review-final.json'
if out.exists(): raise SystemExit('review-final exists')
out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'decision':'pass','artifacts':len(artifacts),'immutable_inputs':len(immutable),'report':str(out),'sha256':sha(read(out))},ensure_ascii=False))
