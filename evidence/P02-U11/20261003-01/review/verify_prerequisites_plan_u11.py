import hashlib, json, pathlib, subprocess, sys
root=pathlib.Path(r'E:\Xiadie\Xiadie')
tree=root/r'.runtime/P02/worktrees/u11'
ev=tree/'evidence/P02-U11/20261003-01'
def binding(rel):
    b=(tree/rel).read_bytes()
    return {'path':rel,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
status=json.loads((tree/'evidence/P02/status.json').read_bytes())
audit=json.loads((ev/'prerequisite-audit.json').read_bytes())
assert status['current_task']=='P02-U11' and status['next_stage_started'] is False
assert audit['current_task']=='P02-U11' and audit['head']=='8620d00eecec67d0884efa8d211242acb21eb1c8'
prior=[]
for t in status['tasks']:
    if t['id']=='P02-U11': break
    assert t['status']=='accepted'
    assert binding(t['acceptance']['path'])==t['acceptance']
    review_ref=t['review']['evidence']
    assert binding(review_ref['path'])==review_ref
    review=json.loads((tree/review_ref['path']).read_bytes())
    assert review['decision']=='pass' and review['review_target']['author_commit']==t['author_commit']
    prior.append({'task':t['id'],'author_commit':t['author_commit'],'acceptance':t['acceptance'],'review':review_ref})
assert len(prior)==10 and [x['task'] for x in prior]==[f'P02-U{i:02d}' for i in range(1,11)]
assert audit['accepted_prerequisites']==prior
plan='planning/Xiadie_V2_v1.1/'
manifest_file=plan+'PACKAGE_MANIFEST.json'
assert binding(manifest_file)==audit['plan_manifest']
manifest=json.loads((tree/manifest_file).read_bytes())
actual=[]
for item in manifest['files']:
    b=binding(plan+item['path'])
    assert b['bytes']==item['bytes'] and b['sha256']==item['sha256'],item['path']
    actual.append(b)
assert len(actual)==423 and audit['plan_files']==actual and audit['plan_mismatches']==[]
assert binding(audit['source_lock']['path'])==audit['source_lock']
card=binding(plan+'tasks/P02-U11.md')
assert card['sha256']==next(t['card_sha256'] for t in status['tasks'] if t['id']=='P02-U11')
assert audit['card']==card
print(json.dumps({'result':'pass','accepted_prerequisites':len(prior),'canonical_reviews':'10/10 pass for matching author commits','plan_files':len(actual),'plan_mismatches':0,'plan_manifest_sha256':audit['plan_manifest']['sha256'],'source_lock_bound':True,'u11_card_bound':True},ensure_ascii=False))
