import datetime, hashlib, json, pathlib, subprocess
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie').resolve()
AUTHOR=ROOT/'.runtime/P03/worktrees/u03'
REVIEW=ROOT/'.runtime/P03/reviews/u03-20261008'
BASELINE='1326a8b036d4695271d194f3bcb1611382433303'
COMMIT='2530a944f9c4f403675378e843c44a11c9880681'
MANIFEST_SHA='5f7d800b9d7c4bffdf3e4a924188666ec7b9012fa4f2a2698ab82efe039ee20e'
NATIVE='29628c9acdb81b703bbd4080c207a0e7ce5e276e'
sha=lambda b:hashlib.sha256(b).hexdigest()
def git(repo,*args):return subprocess.check_output(['git',*args],cwd=repo)
def git_text(repo,*args):return git(repo,*args).decode('utf-8').strip()
def bind(base,rel,root):
 p=base/pathlib.Path(rel); raw=p.read_bytes()
 return {'path':str(rel).replace('\\','/'),'root':root,'bytes':len(raw),'sha256':sha(raw)}
assert git_text(ROOT,'rev-parse','HEAD')==BASELINE
assert git_text(ROOT,'status','--porcelain=v1')==''
assert git_text(AUTHOR,'rev-parse','HEAD')==COMMIT
assert git_text(AUTHOR,'status','--porcelain=v1')==''
parents=git_text(ROOT,'show','-s','--format=%P',COMMIT).split()
assert len(parents)==1
subprocess.run(['git','merge-base','--is-ancestor',BASELINE,COMMIT],cwd=ROOT,check=True)
changed=git_text(ROOT,'diff','--name-only',f'{BASELINE}...{COMMIT}').splitlines()
allowed=lambda p:p in {'packages/projects/registry.ts','packages/projects/test/registry.test.mjs','tools/run-tests.mjs','tsconfig.json'} or p.startswith('evidence/P03-U03/20261008-01/')
assert len(changed)==18 and all(allowed(p) for p in changed)
code_paths=['packages/projects/registry.ts','packages/projects/test/registry.test.mjs','tools/run-tests.mjs','tsconfig.json']
source_change_paths=git_text(ROOT,'diff','--name-only','1608f51224e7d8728c3b44014e63e8a715909468',COMMIT,'--',*code_paths).splitlines()
assert not source_change_paths
manifest=json.loads((AUTHOR/'evidence/P03-U03/20261008-01/manifest.json').read_text(encoding='utf-8'))
assert sha((AUTHOR/'evidence/P03-U03/20261008-01/manifest.json').read_bytes())==MANIFEST_SHA
assert len(manifest['files'])==17 and manifest['task_id']=='P03-U03' and manifest['baseline_commit']==BASELINE
manifest_readback=json.loads((REVIEW/'author-manifest-readback-final.json').read_text(encoding='utf-8'))
assert manifest_readback['author_commit']==COMMIT and manifest_readback['baseline_commit']==BASELINE and manifest_readback['files']==17 and manifest_readback['changed_paths']==18 and manifest_readback['disk_and_git_mismatches']==[] and manifest_readback['worktree_clean'] is True
result=json.loads((AUTHOR/'evidence/P03-U03/20261008-01/result.json').read_text(encoding='utf-8'))
assert result['author_status']=='ready_for_review' and result['checks']['typescript']=='pass' and result['checks']['behavior_tests']=={'passed':14,'failed':0,'skipped':1,'skip_reason':'Windows EPERM creating symbolic directory link; real junction tests pass'}
assert result['checks']['import_boundaries'].startswith('not_run:')
boundary=json.loads((AUTHOR/'evidence/P03-U03/20261008-01/boundary-command.json').read_text(encoding='utf-8'))
assert boundary['exit_code']==0 and 'BOUNDARY_SCAN_NOT_RUN' in boundary['stdout'] and 'no product Core imports were checked' in boundary['stdout']
unit=json.loads((REVIEW/'unit-rerun-command.json').read_text(encoding='utf-8'))
assert unit['exit_code']==0 and unit['cwd']==str(AUTHOR) and unit['argv'][-3:]==['tools/run-tests.mjs','unit','P03-U03']
for phrase in ['ℹ pass 14','ℹ fail 0','ℹ skipped 1','standalone repository copied from E to C','repaired cross-drive linked-worktree copy']:
 assert phrase in unit['stdout'],phrase
build=json.loads((REVIEW/'build-review-01-command.json').read_text(encoding='utf-8'))
assert build['exit_code']==0 and build['output_file_count']==44
build_cmp=json.loads((REVIEW/'build-output-readback.json').read_text(encoding='utf-8'))
assert build_cmp['status']=='pass' and build_cmp['review_output_file_count']==44 and build_cmp['author_matching_file_count']==44 and build_cmp['mismatches']==[]
toolchain=json.loads((REVIEW/'build-toolchain-readback.json').read_text(encoding='utf-8'))
assert toolchain['status']=='pass' and 'Version 6.0.2' in toolchain['tools'][1]['stdout'] and 'v24.14.0' in toolchain['tools'][0]['stdout']
source=json.loads((REVIEW/'native-source-readback.json').read_text(encoding='utf-8'))
assert source['status']=='pass' and source['native_commit']==NATIVE and source['native_worktree_clean'] is True
native_evidence=json.loads((AUTHOR/'evidence/P03-U03/20261008-01/source-adoption.json').read_text(encoding='utf-8'))
assert native_evidence['native_commit']==NATIVE and 'no copied key algorithm' in native_evidence['license']
root_review=REVIEW/'unit-review-final.json'
assert not root_review.exists()
now=datetime.datetime.now(datetime.timezone.utc).isoformat()
author_paths=[
 'docs/adr/P03-reuse.md',
 'packages/projects/registry.ts','packages/projects/test/registry.test.mjs','tools/run-tests.mjs','tsconfig.json','packages/storage/events/src/sqlite.ts',
 'evidence/P03-U03/20261008-01/baseline.json','evidence/P03-U03/20261008-01/manifest.json','evidence/P03-U03/20261008-01/diff-02.json',
 'evidence/P03-U03/20261008-01/result.json','evidence/P03-U03/20261008-01/result.md','evidence/P03-U03/20261008-01/source-adoption.json',
 'evidence/P03-U03/20261008-01/source-binding-command.json','evidence/P03-U03/20261008-01/boundary-command.json',
 'evidence/P03-U03/20261008-01/build-03-command.json','evidence/P03-U03/20261008-01/unit-command.json']
root_paths=[
 'AGENTS.md','planning/Xiadie_V2_v1.1/tasks/P03-U03.md','planning/Xiadie_V2_v1.1/02_计划执行书.md','evidence/P03/status.json',
 'evidence/P03-U02/20261008-01/acceptance.json','evidence/P03-U02/20261008-01/topology-service/native-dist-source-bindings-02.json',
 'evidence/P03-U02/20261008-01/topology-service/native-dist-compile-result.json','docs/adr/P03-reuse.md',
 '.runtime/P01/desktop-source/LICENSE','.runtime/P01/desktop-source/apps/zcode-cli/packages/core/src/memory/project-root.ts',
 '.runtime/P01/desktop-source/apps/zcode-cli/packages/core/dist/memory/project-root.js',
 '.runtime/P01/desktop-source/apps/zcode-cli/packages/bootstrap/src/app/paths.ts',
 '.runtime/P01/desktop-source/apps/zcode-cli/packages/bootstrap/dist/app/paths.js',
 '.runtime/P03/coord/verify-author.py','.runtime/P03/coord/verify-review.py']
review_paths=[
 'author-manifest-readback-final.json','build-review-01-command.json','build-output-readback.json','build-toolchain-readback.json',
 'unit-rerun-command.json','native-source-readback.json','unit-harness-cleanup-failure.json','reviewprelim.json',
 'run-build-review.py','recompare-build-output.py','readback-source-inputs-v2.py','readback-build-toolchain.py',
 'run-unit-review.py','unit-review-01/harness/registry.test.mjs','unit-review-01/harness/run-unit-review.mjs']
artifacts=[bind(AUTHOR,p,'author_worktree') for p in author_paths]+[bind(ROOT,p,'baseline_repository') for p in root_paths]+[bind(REVIEW,p,'review_directory') for p in review_paths]
immutable=[bind(ROOT,p,'baseline_repository') for p in ['AGENTS.md','planning/Xiadie_V2_v1.1/tasks/P03-U03.md','planning/Xiadie_V2_v1.1/02_计划执行书.md','evidence/P03/status.json']]
report={
 'schema':'p03-independent-review/v1','created_at_utc':now,'task':'P03-U03','decision':'pass','unit_acceptance':'not_decided',
 'review_target':{'author_commit':COMMIT,'baseline_commit':BASELINE,'author_worktree':str(AUTHOR),'attempt':'20261008-01; final evidence-correction commit and fresh official selector rerun','changed_paths':len(changed)},
 'reviewer':'Codex independent readback',
 'scope':'Independent review of the complete P03-U03 mapping implementation and evidence at the exact clean author commit. This is a review pass only; unit acceptance remains a coordinator decision.',
 'checks':[
  {'id':'exact-commit-baseline-manifest-and-scope','status':'pass','detail':f'Final author commit {COMMIT} descends from baseline {BASELINE}; root remains clean at baseline and author worktree is clean at the final commit. All {len(changed)} paths are within U03 source, tests, runner/configuration and its evidence directory. Independent verify-author readback verified 17 manifest-bound files against Git blobs and checked-out bytes with zero mismatches; manifest SHA-256 is {MANIFEST_SHA}. The later commit changed only result.md/result.json/diff-02/manifest relative to the reviewed code commit 1608f51; implementation and test surfaces are unchanged.'},
  {'id':'native-key-resolvers-and-accepted-provenance','status':'pass','detail':f'The registry dynamically uses the pinned Native root/runtime-key helpers. Independent SHA/source readback confirms pinned Native commit {NATIVE}, a clean Native tree, source hashes matching Git blobs, actual loaded helper dist hashes matching accepted U02 source-to-dist evidence, and accepted SQLite wrapper/U02 provenance hashes. The implementation does not copy Native key algorithms.'},
  {'id':'project-identity-worktree-and-relocation','status':'pass','detail':'Code groups main/linked worktrees using physical Git common/private directory identities and Git worktree-list backreferences. The fresh official selector covers same-name repos, identical-head/remote forks, directory copies, linked worktrees, replaced paths, same-volume move, standalone E-to-C copy, and E-to-C linked-worktree copy plus real git worktree repair. Copies/forks receive distinct UUIDs; a repaired known linked worktree returns RELOCATION_REQUIRED and retains the old project UUID, path binding and canonical Native-memory pointer.'},
  {'id':'legacy-memory-and-sqlite-atomicity','status':'pass','detail':'The separate application-owned mapping database stores pointers and identity metadata only. Explicit adoption keeps the existing Native root and file hashes intact; a different canonical key conflict rolls back without a partial project/workspace mapping. Registration writes use BEGIN IMMEDIATE with commit/rollback; unknown SQLite databases are preserved. Source review also confirms per-call checks for the DB/WAL/SHM/journal being physical single-link files, a 10,000-project cap, and no memory-byte copy/migration path. Sibling legacy-root ownership conflict is rejected in code with MEMORY_CONFLICT; explicit transfer is assigned to U06.'},
  {'id':'independent-type-build-and-official-unit-selector','status':'pass','detail':f'Fresh TypeScript {toolchain["tools"][1]["stdout"].replace("Version ","")} build ran from the exact author worktree with output redirected to the review directory; all 44 generated files match the author dist byte-for-byte. The committed unit/P03-U03 selector exited 0 with 14 behavior tests passing, zero failures and one skipped Windows symbolic-link creation subtest; junction tests passed.'},
  {'id':'boundary-check-scope','status':'not_run','detail':'The committed boundary command exited 0 but printed BOUNDARY_SCAN_NOT_RUN because packages/core is absent; it checked no product Core import graph. The corrected author result marks this not_run. TypeScript compilation is reported separately and is not treated as an architecture scan.'},
  {'id':'scope-and-not-run-boundaries','status':'pass','detail':'The change adds the registry, mapped behavior tests, compiler include, existing test selector and U03 evidence; it does not change the event-ledger schema, dependency set, plan baseline, Native source, global settings, user memory or installed ZCode profile. Native app/model/Desktop/DSH execution and explicit ownership/export migration remain NOT_RUN and belong outside this mapping-only unit (U06 for confirmed transfer).'}
 ],
 'reviewer_readback':{
  'author_manifest':{'record':'author-manifest-readback-final.json','bound_files':17,'changed_paths':18,'mismatches':0,'manifest_sha256':MANIFEST_SHA},
  'native_source':{'record':'native-source-readback.json','native_commit':NATIVE,'clean':True,'native_input_hashes_match':True,'ignored_dist_helpers_bound_by_accepted_u02_compile':2},
  'fresh_typescript_build':{'command_record':'build-review-01-command.json','node':'v24.14.0','typescript':'6.0.2','exit_code':0,'output_files':44,'author_dist_byte_matches':44,'tree_sha256':build['output_tree_sha256']},
  'official_selector':{'command_record':'unit-rerun-command.json','exit_code':0,'passed':14,'failed':0,'skipped':1,'skip_reason':'Windows refused synthetic symbolic directory-link creation; junction checks passed'},
  'first_reviewer_harness_attempt':{'record':'unit-harness-cleanup-failure.json','status':'unassessed','reason':'wrapper failed while removing its own read-only Git fixture after the test subprocess; its stdout was not persisted. The direct official selector rerun is the review test result.'},
  'boundary_command':{'author_record':'evidence/P03-U03/20261008-01/boundary-command.json','exit_code':0,'scan_status':'NOT_RUN: packages/core absent'}
 },
 'limitations':[
  'The official unit test uses synthetic E- and C-drive Git repositories and retains those fixtures as recorded by the author evidence; no production data was migrated.',
  'The first isolated reviewer wrapper attempt had an unassessed post-test cleanup exception and no saved child stdout; it is retained as a harness failure and superseded by the fresh direct official selector run.',
  'The import-boundary command did not scan a Core graph because packages/core is absent. No whole-repository architecture claim is made.',
  'No Native desktop session, real model, Desktop/DSH, or U06 confirmed export/relocation was run; these are outside U03 mapping acceptance.',
  'The database/WAL/SHM/journal non-link assertions and 10,000 cap were source-reviewed; the behavior suite has no dedicated adversarial sidecar-replacement or scale-to-cap case.'
 ],
 'artifacts':artifacts,'immutable_inputs':immutable
}
(REVIEW/'unit-review-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'path':str(REVIEW/'unit-review-final.json'),'bytes':(REVIEW/'unit-review-final.json').stat().st_size,'sha256':sha((REVIEW/'unit-review-final.json').read_bytes()),'artifact_count':len(artifacts),'immutable_input_count':len(immutable),'changed_paths':len(changed),'decision':report['decision']},ensure_ascii=False))