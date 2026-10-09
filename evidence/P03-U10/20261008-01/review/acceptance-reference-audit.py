import hashlib, json, pathlib, datetime
root = pathlib.Path(r'E:\Xiadie\Xiadie')
author = root / '.runtime/P03/worktrees/u10-review-20261009'
native = root / '.runtime/P01/desktop-source'
status_path = author / 'evidence/P03/status.json'
freeze_path = author / 'docs/releases/0.3.0/freeze.json'
status = json.loads(status_path.read_bytes())
freeze = json.loads(freeze_path.read_bytes())
def bind(path, base=author):
    p = pathlib.Path(path)
    if not p.is_absolute(): p = base / p
    p = p.resolve()
    raw = p.read_bytes()
    return {'path': str(p), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
def check_ref(ref, label, base=author):
    actual = bind(ref['path'], base)
    if actual['bytes'] != ref['bytes'] or actual['sha256'] != ref['sha256']:
        failures.append({'label': label, 'expected': ref, 'actual': actual})
    return actual
failures=[]
expected_ids=[f'P03-U{i:02d}' for i in range(1,10)]
entries={x['id']:x for x in status['tasks']}
assert status['stage']=='P03' and status['current_task']=='P03-U10' and status['G03']=='pending'
assert [x for x in entries if x in expected_ids] == expected_ids
freeze_units={x['task']:x for x in freeze['accepted_prior_units']}
refs=[]
for task in expected_ids:
    row=entries[task]
    assert row['status']=='accepted'
    fr=freeze_units[task]
    assert fr['status']=='accepted' and fr['author_commit']==row['author_commit'] and fr['integration_commit']==row['integration_commit']
    for kind, ref in [('acceptance', row['acceptance']), ('review', row['review']['evidence'])]:
        actual=check_ref(ref, f'{task}:{kind}')
        if kind=='acceptance': assert fr['acceptance']==ref
        else:
            assert fr['review']['path']==ref['path'] and fr['review']['bytes']==ref['bytes'] and fr['review']['sha256']==ref['sha256']
        refs.append({'task':task,'kind':kind,**actual})
for k in ['acceptance','result','candidate_proof_index','coverage']:
    ref=freeze['P03-U09'][k]
    actual=check_ref(ref, f'P03-U09:{k}')
    refs.append({'task':'P03-U09','kind':k,**actual})
for task in ['P03-U03','P03-U06']:
    ref=freeze['M2_migration_evidence'][task[4:]]
    actual=check_ref(ref, f'M2:{task}')
    refs.append({'task':task,'kind':'M2-migration-acceptance',**actual})
for label,ref,base in [('source_lock',freeze['source_lock'],author),('tracked_prompt_template',freeze['tracked_prompt_template'],author),('native_node_sqlite',freeze['native_node_sqlite'],native),('scope_amendment',freeze['qualification_scope_amendment'],author),('proof_archive_index',freeze['proof_archive_index'],author)]:
    actual=check_ref(ref,label,base)
    refs.append({'kind':label,**actual})
card=bind('planning/Xiadie_V2_v1.1/tasks/P03-U10.md')
card_expected=entries['P03-U10']['card_sha256']
if card['sha256']!=card_expected: failures.append({'label':'P03-U10-card','expected_sha256':card_expected,'actual':card})
refs.append({'kind':'P03-U10-card',**card})
for name in ['project-memory-audit.mjs','project-memory-audit.test.mjs','project-memory-host.mjs','seed-memory.mjs','desktop.py']:
    refs.append({'kind':'qualification-input',**bind(author/'tests/integration/P03'/name)})
record={
 'schema':'p03-u10-acceptance-reference-audit/v1','created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'author_commit':'c157967d7440e0c9d3b2b60dedd64b67b6249e71','baseline_commit':'f9b0a9d0d0df784daf601c717ea0f87b5a85c0f3',
 'status':{'stage':status['stage'],'current_task':status['current_task'],'G03':status['G03'],'accepted_units':expected_ids},
 'accepted_prior_units':len(expected_ids),'references_verified':len(refs),'references':refs,'mismatches':failures,
 'boundary':'Read-only binding audit of canonical U01-U09 acceptance/review refs, G03 migration refs, freeze prompt/source/test references, and the immutable U10 plan card.'}
out=root/'.runtime/P03/reviews/u10-independent-20261009/acceptance-reference-audit.json'
if out.exists(): raise SystemExit('output_exists')
out.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'accepted_units':len(expected_ids),'references_verified':len(refs),'mismatches':len(failures),'output':str(out)},ensure_ascii=False))
