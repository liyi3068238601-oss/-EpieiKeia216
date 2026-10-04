import hashlib,json,pathlib,datetime,sys
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie')
WT=ROOT/'.runtime/P02/worktrees/mature-freeze'
E=WT/'evidence/P02-U11/20261004-02'
def sha(b): return hashlib.sha256(b).hexdigest()
checks=[]
def check(name,ok,detail): checks.append({'id':name,'status':'pass' if ok else 'fail','detail':detail})
source_report=E/'candidate-proof/runs/full/scenarios/success/ledger-verification.json'
report=json.loads(source_report.read_bytes())
idx=json.loads((E/'candidate-proof-index.json').read_bytes())
rows=[x for x in idx['artifacts'] if x['path'].replace('\\','/')=='candidate-proof/runs/full/scenarios/success/ledger-verification.json']
copy_ok=False
source_path=None
if len(rows)==1:
 r=rows[0]; source_path=pathlib.Path(r['original']); original=source_path.read_bytes(); archived=source_report.read_bytes()
 copy_ok=(len(original)==r['bytes'] and sha(original)==r['sha256'] and archived==original)
check('success-ledger-report-provenance',copy_ok,f'proof index match count={len(rows)} source bytes identical={copy_ok}')
br=report.get('backup_restore',{})
v=br.get('verification',{})
expected={'facts':5,'observations':5,'origins':5,'receipts':5,'captures':1,'materials':1}
counts={k:v.get(k,{}).get('count') for k in expected}
table_hashes={k:v.get(k,{}).get('sha256') for k in expected}
backup_ok=(report.get('passed') is True and br.get('passed') is True and br.get('mode')=='snapshot-v1-only' and
 br.get('backupSha256')==br.get('restoredDatabaseSha256') and bool(br.get('backupSha256')) and
 v.get('userVersion')==1 and v.get('schemaVersion')==1 and v.get('integrityCheck')=='ok' and v.get('foreignKeyCheck')=='ok' and counts==expected and all(isinstance(x,str) and len(x)==64 for x in table_hashes.values()))
check('backup-restore-root-and-ledger-integrity',backup_ok,f'ledger passed={report.get("passed")} backup passed={br.get("passed")} backup/restored SHA equal={br.get("backupSha256")==br.get("restoredDatabaseSha256")} versions={v.get("userVersion")}/{v.get("schemaVersion")} integrity={v.get("integrityCheck")} foreign_keys={v.get("foreignKeyCheck")} counts={counts}')
for label in ['backupPath','restoredDatabasePath']:
 p=pathlib.Path(br.get(label,''))
 try: p.resolve().relative_to(ROOT/'.runtime/P02/experiments/mature-freeze/full-candidate09')
 except Exception: backup_ok=False
check('backup-paths-owned-run',backup_ok,'backup and restored root paths remain in this fresh owned success run')
obj={'schema':'p02-u11-backup-readback/v1','created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'author_commit':'e11e7343e8f3dd15f7420ceb14bdf7c6e3dec241','candidate_descriptor_sha256':'6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74','source_archived_report':str(source_report),'source_original':str(source_path) if source_path else None,'report_sha256':sha(source_report.read_bytes()),'decision':'pass' if all(c['status']=='pass' for c in checks) else 'block','checks':checks,'backup_restore':br,'verification_summary':{'counts':counts,'table_sha256':table_hashes}}
out=ROOT/'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004/backup-readback.json'
if out.exists(): raise SystemExit('refusing overwrite')
out.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'decision':obj['decision'],'checks':checks,'report_sha256':obj['report_sha256'],'output':str(out)},ensure_ascii=False))
if obj['decision']!='pass': sys.exit(1)
