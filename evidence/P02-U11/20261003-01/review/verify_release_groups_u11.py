import hashlib, json, pathlib
root=pathlib.Path(r'E:\Xiadie\Xiadie')
tree=root/r'.runtime/P02/worktrees/u11'
ev=tree/'evidence/P02-U11/20261003-01'
freeze=json.loads((tree/'docs/releases/0.2.0/freeze.json').read_bytes())
desc_path=ev/'candidate-proof/candidate-descriptor.json'
desc=json.loads(desc_path.read_bytes())
candidate=root/r'.runtime/P02/experiments/u11/candidate-01'
def sha_file(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def bind(path):
    data=pathlib.Path(path).read_bytes()
    return {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
assert freeze['schema']=='xiadie-local-freeze/v1' and freeze['product_version']=='0.2.0'
assert freeze['author_status']=='ready_for_review' and freeze['accepted'] is False and freeze['G02']=='pending_independent_acceptance'
assert freeze['baseline_commit']=='8620d00eecec67d0884efa8d211242acb21eb1c8'
assert freeze['build_repository_commit']==desc['repositoryCommit']=='e3d15af210ee6df3871bc6c10b99a093817db819'
assert freeze['source_commit']==desc['sourceCommit']=='29628c9acdb81b703bbd4080c207a0e7ce5e276e'
assert pathlib.Path(freeze['candidate_root']).resolve()==candidate.resolve()
assert bind(desc_path)=={k:freeze['descriptor'][k] for k in ('bytes','sha256')}
assert desc_path.read_bytes()==(candidate/'candidate-descriptor.json').read_bytes()
assert len(desc['artifacts'])==freeze['artifact_count']==6689
assert len(desc['repositoryInputs'])==freeze['repository_input_count']==94
predicates={
 'code':lambda s:s.startswith('packages/') or s=='tests/integration/P02/durable-host.mjs',
 'prompt':lambda s:s.startswith('assets/character/') or s.startswith('plugins/xiadie/hooks/'),
 'schema':lambda s:s.startswith('migrations/'),
 'resources':lambda s:s.startswith(('assets/','plugins/')),
 'tools_and_configuration':lambda s:s.startswith('tools/') or s in ('package.json','pnpm-lock.yaml','tsconfig.json'),
 'qualification_tests':lambda s:s.startswith('tests/integration/'),
}
assert freeze['group_boundary']=='Theme groups may overlap. The descriptor repositoryInputs array is the complete declared material-input index.'
for name,predicate in predicates.items():
    selected=[i for i in desc['repositoryInputs'] if predicate(i['path'])]
    actual=freeze['input_groups'][name]
    digest=hashlib.sha256(json.dumps(selected,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    assert actual['files']==selected and actual['count']==len(selected) and actual['bindings_sha256']==digest,name
for key in ('source_lock','prerequisite_audit','proof_archive_index','command_index'):
    item=freeze[key]; f=tree/item['path']; assert bind(f)=={k:item[k] for k in ('bytes','sha256')},key
for suite,count in (('full',6),('degradation',3)):
    item=next(x for x in freeze['summaries'] if x['path'].endswith(f'/{suite}/summary.json'))
    assert bind(tree/item['path'])=={k:item[k] for k in ('bytes','sha256')}
    summary=json.loads((tree/item['path']).read_bytes())
    assert summary['passed'] is True and summary['scenario_status']=='passed'
    assert summary['production_unchanged'] is True and summary['execution_unchanged'] is True
    assert summary['real_model_requests']==0 and summary['external_model_requests']==0 and summary['DSH_started'] is False
    assert len(summary['scenarios'])==count and all(s['passed'] and s['ledger_verification']['passed'] for s in summary['scenarios'])
pre=freeze['execution_inputs']['before']; post=freeze['execution_inputs']['after']
for item in (pre,post): assert bind(tree/item['path'])=={k:item[k] for k in ('bytes','sha256')}
pre_data=json.loads((tree/pre['path']).read_bytes()); post_data=json.loads((tree/post['path']).read_bytes())
assert len(pre_data['bindings'])==len(post_data['bindings'])==135
assert pre_data['digest']==post_data['digest']==freeze['execution_inputs']['digest']=='206b4aec3679a3825fc08983c45f320dd94d99555c32cf2f0c459fbd0dd3b5a2'
assert post_data['unchanged'] is True and post_data['before_digest']==pre_data['digest']
gen=freeze['generation_script']
gen_copy=tree/gen['path']
gen_live=root/r'.runtime/P02/coord/write-release-proof.py'
assert bind(gen_copy)=={k:gen[k] for k in ('bytes','sha256')}
assert gen_copy.read_bytes()==gen_live.read_bytes()

# Candidate license and author/candidate asset-status boundaries.
up=freeze['upstream_license']; up_path=candidate/up['path']; assert bind(up_path)=={k:up[k] for k in ('bytes','sha256')}
source_license=root/r'.runtime/P01/desktop-source/LICENSE'
assert sha_file(up_path)==sha_file(source_license)
tpn=freeze['third_party_notices']; assert bind(candidate/tpn['path'])=={k:tpn[k] for k in ('bytes','sha256')}
for tree_manifest,cand_manifest in [('assets/manifest.json','xiadie/assets/manifest.json'),('assets/character/xiadie/v3/manifest.json','xiadie/assets/character/xiadie/v3/manifest.json')]:
    source=json.loads((tree/tree_manifest).read_bytes()); copied=json.loads((candidate/cand_manifest).read_bytes())
    assert sha_file(tree/tree_manifest)==sha_file(candidate/cand_manifest)
    if tree_manifest=='assets/manifest.json': assert source['status']=='research_only' and source['approvedAssets']==[]
    else: assert 'public distribution rights not asserted' in source['usage'] and source['usage']==copied['usage']
readme=(tree/'docs/releases/0.2.0/README.md').read_text(encoding='utf-8')
for claim in ('Electron main','NOT_VERIFIED','OS sandbox'):
    assert claim in readme,claim
assert 'portable/public release' in freeze['qualification']
print(json.dumps({'result':'pass','release_input_groups':{k:v['count'] for k,v in freeze['input_groups'].items()},'groups_recomputed':len(predicates),'declared_inputs':len(desc['repositoryInputs']),'candidate_artifacts':len(desc['artifacts']),'execution_bindings':len(pre_data['bindings']),'execution_digest':pre_data['digest'],'full_and_degradation':'6/6 + 3/3 summary assertions pass','license_and_asset_boundaries':'pass'},ensure_ascii=False))
