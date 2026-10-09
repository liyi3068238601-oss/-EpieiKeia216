import hashlib, json, pathlib, datetime
root=pathlib.Path(r'E:\Xiadie\Xiadie')
author=root/'.runtime/P03/worktrees/u10-review-20261009'
status=json.loads((author/'evidence/P03/status.json').read_bytes())
freeze=json.loads((author/'docs/releases/0.3.0/freeze.json').read_bytes())
ledger={x['id']:x for x in status['tasks']}
units=[]; failures=[]
for i in range(1,10):
 task=f'P03-U{i:02d}'; row=ledger[task]
 acceptance=json.loads((author/row['acceptance']['path']).read_bytes())
 review=json.loads((author/row['review']['evidence']['path']).read_bytes())
 target=review.get('review_target') or {}
 f=[]
 if row['status']!='accepted' or row['review']['status']!='pass': f.append('ledger_state')
 if acceptance.get('task')!=task or acceptance.get('status')!='accepted': f.append('acceptance_state')
 if acceptance.get('author_commit')!=row['author_commit'] or acceptance.get('integration_commit')!=row['integration_commit']: f.append('acceptance_commits')
 if review.get('task')!=task or review.get('decision')!='pass': f.append('review_decision')
 if target.get('author_commit')!=row['author_commit']: f.append('review_target')
 fr=next((x for x in freeze['accepted_prior_units'] if x['task']==task),{})
 if fr.get('author_commit')!=row['author_commit'] or fr.get('integration_commit')!=row['integration_commit']: f.append('freeze_commits')
 units.append({'task':task,'author_commit':row['author_commit'],'integration_commit':row['integration_commit'],'review_decision':review.get('decision'),'review_target_commit':target.get('author_commit'),'failures':f})
 if f: failures.append({'task':task,'failures':f})
assert status['tasks'][-1]['id']=='P03-U10' and status['tasks'][-1]['status']=='running'
assert status['G03']=='pending' and freeze['accepted'] is False and freeze['G03']=='pending_independent_acceptance'
out=root/'.runtime/P03/reviews/u10-independent-20261009/canonical-unit-semantic-audit.json'
rec={'schema':'p03-u10-canonical-prerequisite-audit/v1','created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':'P03','G03':'pending','accepted_units':units,'accepted_unit_count':len(units),'mismatches':failures,'boundary':'Checks canonical acceptance status, author/integration commits, independent review decision and exact review target for U01-U09; confirms U10 is still running and G03 pending.'}
if out.exists(): raise SystemExit('output_exists')
out.write_text(json.dumps(rec,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'accepted_unit_count':len(units),'mismatches':len(failures),'output':str(out)},ensure_ascii=False))
