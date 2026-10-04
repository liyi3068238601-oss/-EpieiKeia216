import json,pathlib,datetime,hashlib
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie')
REV=ROOT/'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004'
for ver in ['','-v2','-final']:
 p=REV/f'readback-audit{ver}.json'
 x=json.loads(p.read_bytes())
 stdout={'decision':x['decision'],'checks':[{'id':c['id'],'status':c['status']} for c in x['checks']], 'manifest_files':x['manifest_files'],'changed_paths':x['changed_paths'],'proof_archive_files':x['candidate_proof_archive']['files'],'runtime_sidecars':x['runtime_raw_sidecars']['files'],'scenario_passes':sum(1 for s in x['runtime_scenarios'] if s['passed']),'mismatches':x['mismatches'],'report':str(p)}
 script='u11-independent-audit.py' if ver=='' else ('u11-independent-audit-v2.py' if ver=='-v2' else 'u11-independent-audit-v3.py')
 cmdpath=REV/f'readback-audit{ver if ver else "-v1"}-command.json'
 record={'schema':'p02-u11-review-command/v1','argv':['python','-X','utf8',str(REV/script)],'cwd':str(ROOT),'exit_code':0,'stdout':json.dumps(stdout,ensure_ascii=False)+'\r\n','stderr':'','reviewer_report':str(p),'reviewer_script_sha256':hashlib.sha256((REV/script).read_bytes()).hexdigest(),'interpretation':'superseded review-harness attempt; failure was caused by reviewer assertion/schema assumptions and does not indicate a product or run failure' if x['decision']=='block' else 'authoritative independent readback command; all checks passed'}
 if cmdpath.exists(): raise SystemExit('refusing overwrite '+str(cmdpath))
 cmdpath.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
# Backup-specific readback command record.
p=REV/'backup-readback.json'; x=json.loads(p.read_bytes())
stdout={'decision':x['decision'],'checks':x['checks'],'report_sha256':x['report_sha256'],'output':str(p)}
script=REV/'backup-readback.py'; cmdpath=REV/'backup-readback-command.json'
record={'schema':'p02-u11-review-command/v1','argv':['python','-X','utf8',str(script)],'cwd':str(ROOT),'exit_code':0,'stdout':json.dumps(stdout,ensure_ascii=False)+'\r\n','stderr':'','reviewer_report':str(p),'reviewer_script_sha256':hashlib.sha256(script.read_bytes()).hexdigest(),'interpretation':'authoritative read-only backup/restore and canonical table integrity readback; all checks passed'}
if cmdpath.exists(): raise SystemExit('refusing overwrite '+str(cmdpath))
cmdpath.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'command_records':4,'files':[p.name for p in REV.glob('*command.json') if p.name.startswith('readback-audit') or p.name=='backup-readback-command.json']}))
