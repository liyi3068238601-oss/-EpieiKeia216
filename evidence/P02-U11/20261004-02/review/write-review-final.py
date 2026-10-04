import json,pathlib,hashlib,subprocess,os,datetime
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie').resolve()
WT=ROOT/'.runtime/P02/worktrees/mature-freeze'
REV=ROOT/'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004'
ATT='20261004-02'; AUTHOR='e11e7343e8f3dd15f7420ceb14bdf7c6e3dec241'; BASE='b95cfd2be02959dd8c390e2b141d24d1093daf81'; MANIFEST_SHA='eaefb0ef6d844a6674959a4ae6db9e5befd4ccd9bc479fabe21dca915dceba3a'
E=WT/'evidence/P02-U11'/ATT
read=lambda p:pathlib.Path(p).read_bytes()
sha=lambda b:hashlib.sha256(b).hexdigest()
def entry(path,root,expected=None):
 p=pathlib.Path(path)
 if root=='author_worktree' and not p.is_absolute(): p=WT/p
 elif root=='baseline_repository' and not p.is_absolute(): p=ROOT/p
 elif root=='review_directory' and not p.is_absolute(): p=REV/p
 else: p=p.resolve()
 b=read(p)
 if expected and (len(b)!=expected['bytes'] or sha(b)!=expected['sha256']): raise RuntimeError(f'input differs: {p}')
 return {'path': str(path) if pathlib.Path(path).is_absolute() else pathlib.Path(path).as_posix(), 'root':root,'bytes':len(b),'sha256':sha(b)}
manifest_path=WT/f'evidence/P02-U11/{ATT}/manifest.json'
manifest_raw=read(manifest_path); manifest=json.loads(manifest_raw)
assert sha(manifest_raw)==MANIFEST_SHA and len(manifest['files'])==220
readback=json.loads(read(REV/'readback-audit-final.json'))
backup=json.loads(read(REV/'backup-readback.json'))
assert readback['decision']=='pass' and backup['decision']=='pass'
# Confirm root and author exact commit/clean state again before the final review report.
def git(cwd,*args): return subprocess.check_output(['git',*args],cwd=cwd).decode().strip()
assert git(ROOT,'rev-parse','HEAD')==BASE and not git(ROOT,'status','--porcelain','--untracked-files=all')
assert git(WT,'rev-parse','HEAD')==AUTHOR and not git(WT,'status','--porcelain','--untracked-files=all')
# Author artifacts are enumerated from the frozen exact manifest; include the manifest itself.
artifacts=[entry(row['path'],'author_worktree',row) for row in manifest['files']]
artifacts.append(entry(f'evidence/P02-U11/{ATT}/manifest.json','author_worktree',{'bytes':len(manifest_raw),'sha256':MANIFEST_SHA}))
review_files=[
 'author-verification.json','author-verification-command.json',
 'u11-independent-audit.py','u11-independent-audit-v2.py','u11-independent-audit-v3.py',
 'readback-audit.json','readback-audit-v2.json','readback-audit-final.json',
 'readback-audit-v1-command.json','readback-audit-v2-command.json','readback-audit-final-command.json',
 'backup-readback.py','backup-readback.json','backup-readback-command.json',
]
for name in review_files: artifacts.append(entry(name,'review_directory'))
# Immutable status/planning/prerequisite evidence, all ten accepted U01-U10 receipts and reviews.
status_path=ROOT/'evidence/P02/status.json'; status=json.loads(read(status_path)); pre=json.loads(read(E/'prerequisite-audit.json'))
immutable=[entry('evidence/P02/status.json','baseline_repository',{'bytes':len(read(status_path)),'sha256':sha(read(status_path))})]
for key in ['plan_manifest','source_lock','card','historical_g01']:
 row=pre[key]; immutable.append(entry(row['path'],'baseline_repository',row))
for row in pre['plan_files']:
 immutable.append(entry(row['path'],'baseline_repository',row))
for i in range(1,11):
 task=status['tasks'][i-1]
 assert task['id']==f'P02-U{i:02d}' and task['status']=='accepted'
 for binding in [task['acceptance'],task['review']['evidence']]:
  immutable.append(entry(binding['path'],'baseline_repository',binding))
# Bind each selected source/prompt/schema/resource/config/test file used by the U10 candidate.
mat=json.loads(read(E/'candidate-material-audit.json'))
for row in mat['inputs']:
 immutable.append(entry(row['path'],'baseline_repository',{'bytes':row['bytes'],'sha256':row['sha256']}))
# Candidate descriptor, executable SQLite addon, package/license, and upstream legal files.
desc_path=pathlib.Path(mat['descriptor']['path'])
desc=json.loads(read(desc_path)); candidate_root=pathlib.Path(desc['assemblyRoot']); sqlite=desc['sqliteRuntime']
def cpath(value):
 p=pathlib.Path(value); return p if p.is_absolute() else candidate_root/p
immutable.append(entry(desc_path,'absolute'))
for value in [sqlite['addonPath'],sqlite['licensePath'],str(pathlib.Path(sqlite['packageRoot'])/'package.json')]: immutable.append(entry(cpath(value),'absolute'))
freeze=json.loads(read(WT/'docs/releases/0.2.0/freeze.json'))
for legal in [freeze['upstream_license'],freeze['third_party_notices']]: immutable.append(entry(cpath(legal['path']),'absolute',{'bytes':cpath(legal['path']).stat().st_size,'sha256':legal['sha256']}))
# Raw originals for all 139 archived runner/proof artifacts and 42 copied runtime sidecars.
proof=json.loads(read(E/'candidate-proof-index.json'))
for item in proof['artifacts']:
 immutable.append(entry(item['original'],'absolute',{'bytes':item['bytes'],'sha256':item['sha256']}))
rawidx=json.loads(read(E/'runtime-raw-candidate09/index.json'))
for item in rawidx['files']:
 immutable.append(entry(item['source'],'absolute',{'bytes':item['bytes'],'sha256':item['sha256']}))
# Dedupe immutable inputs by normalized absolute target while retaining a stable path spelling.
def norm(item):
 p=pathlib.Path(item['path'])
 if not p.is_absolute():
  base={'baseline_repository':ROOT,'author_worktree':WT,'review_directory':REV}.get(item['root'],ROOT)
  p=base/p
 return os.path.normcase(str(p.resolve()))
unique={}
for item in immutable:
 key=norm(item)
 if key in unique:
  prior=unique[key]
  if (prior['bytes'],prior['sha256'])!=(item['bytes'],item['sha256']): raise RuntimeError(f'conflicting immutable binding: {item["path"]}')
 else: unique[key]=item
immutable=list(unique.values())
# Review decisions derive from fresh actual records; previous reviewer-script blocks are preserved as harness errors.
checks=[
 {'id':'author-commit-manifest-and-scope','status':'pass','detail':'Exact author e11e7343e8f3dd15f7420ceb14bdf7c6e3dec241 at baseline b95cfd2be02959dd8c390e2b141d24d1093daf81; manifest sha eaef... covers 220 files / 221 changed paths, accepted scope only; fresh verify-author clean with no mismatches.'},
 {'id':'canonical-prerequisites-and-immutable-plan','status':'pass','detail':'U01-U10 acceptance and independent review artifacts each matched their canonical path, bytes and SHA; status binds U11 running/G02 pending/next_stage_started=false; all 423 planning file hashes and plan/source-lock/card/G01 metadata matched.'},
 {'id':'candidate-material-and-runtime-dependency','status':'pass','detail':'All 103 repository inputs matched U10 material commit and baseline Git blobs plus descriptor; accepted U10 candidate closure receipts were reused (6717 items, no redundant full rehash). Better SQLite 13.0.3 / SQLite 3.53.4 package, owned Windows addon SHA and dependency/upstream legal file hashes were independently checked.'},
 {'id':'fresh-desktop-six-plus-three-and-runtime-identity','status':'pass','detail':'Fresh U11 full 6/6 and degradation 3/3 passed. For all nine, main/browser PID was bound to UI/network/effects snapshots, launcher PID remained distinct, actual Electron 41.0.3 ELECTRON_RUN_AS_NODE=1 qualification was used, and every instantiated P02 ledger had actual CLI PID-bound Better process.dlopen probe plus verified owned CLI alias. disabled_native had no P02 admission/probe; its Native fallback is explicitly separate.'},
 {'id':'candidate-and-raw-evidence-preservation','status':'pass','detail':'Candidate descriptor/6717-file closure stayed pinned before/after every scenario and after both suites. All 139 archived proof artifacts and all 42 runtime sidecars were re-read against originals byte-for-byte and matched their SHA index.'},
 {'id':'registry-scope-and-backup-recovery','status':'pass','detail':'Both suites recorded read-only snapshots of nine selected registry keys with equal pre/post hashes. Success backup/restore report was byte-provenanced from the archived original; snapshot-v1 backup and restored database SHA matched, v1 schema/integrity/FK checks passed and canonical table counts/hashes were present.'},
 {'id':'historical-docs-commands-and-limitations','status':'pass','detail':'The previous 20261003-01 README/freeze copies match their original Git blobs byte-for-byte. Current source/prompt/schema/license/requirements and rollback claims are bound; all indexed commands and preserved failures were checked, and final outer record is in manifest. Actual reader legacy fixed-Node wording is disqualified; no unit161/Native8 rerun, P03 start, model/DSH/credentials, or registry writes are claimed.'},
 {'id':'reviewer-harness-attempts','status':'pass','detail':'Initial readback-audit.json and readback-audit-v2.json are retained with their scripts/commands as superseded reviewer-harness blocks caused by mistaken assumptions about probe path prefix, command-index count/path and overlapping group counts. Corrected readback-audit-final.json passed all 11 checks; these retired reviewer assertions are not product/run failures.'},
]
report={
 'schema':'p02-independent-review/v1','created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'task':'P02-U11','decision':'pass',
 'review_target':{'author_commit':AUTHOR,'baseline_commit':BASE,'author_worktree':str(WT),'attempt':ATT,'manifest_path':f'evidence/P02-U11/{ATT}/manifest.json','manifest_sha256':MANIFEST_SHA,'manifest_files':220},
 'reviewer':'Codex independent readback','scope':['Read-only review of accepted P02-U11 author tree, freeze documents, canonical inputs, candidate runtime reports, archived raw sidecars and prior accepted U10 candidate closure.','No source/worktree/status mutation, UI/test execution, model/DSH use or registry/global-setting writes.'],
 'checks':checks,
 'reviewer_readback':{'decision':'pass','report_path':str(REV/'readback-audit-final.json'),'report_sha256':sha(read(REV/'readback-audit-final.json')),'checks_passed':11,'scenario_passes':9,'candidate_proof_archived':139,'runtime_sidecars':42,'backup_readback_path':str(REV/'backup-readback.json'),'backup_readback_sha256':sha(read(REV/'backup-readback.json')),'superseded_harness_reports':[{'path':str(REV/'readback-audit.json'),'sha256':sha(read(REV/'readback-audit.json')),'classification':'reviewer harness assumption error, not product failure'},{'path':str(REV/'readback-audit-v2.json'),'sha256':sha(read(REV/'readback-audit-v2.json')),'classification':'reviewer harness manifest path assumption error, not product failure'}]},
 'limitations':['Main-process side-effect guard is test-harness instrumentation, not an OS sandbox; standalone Native startup effects are not qualified by it.','disabled_native bypasses the P02 durable wrapper; its two loopback requests are Native fallback and are not P02 ledger facts.','The independent Node ledger verifier retains a legacy phrase calling the CLI a fixed Node CLI; raw report is preserved but explicitly disqualified from identifying the actual CLI process.','The candidate09 onboarding-timeout fallback was not observed in this run.','Native session storage still uses node:sqlite. No paid model route, real credentials, DSH, installer/portable packaging, ordinary unguarded Native startup, human visual acceptance, physical power loss, or universal OS/filesystem crash behavior was tested.','This reviewer did not rerun unit161 or Native8; those accepted U10 evidence inputs were reused. G02 remains pending; P03 has not started.'],
 'artifacts':artifacts,'immutable_inputs':immutable
}
out=REV/'review-final.json'
if out.exists(): raise SystemExit('refusing to overwrite '+str(out))
out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'decision':report['decision'],'artifact_count':len(artifacts),'immutable_input_count':len(immutable),'report_path':str(out),'report_sha256':sha(read(out))},ensure_ascii=False))
