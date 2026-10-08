import datetime, hashlib, json, pathlib, subprocess, sys
ROOT = pathlib.Path(r'E:\Xiadie\Xiadie').resolve()
REVIEW = ROOT / '.runtime/P03/reviews/u02-20261008'
AUTHOR = ROOT / '.runtime/P03/worktrees/u02-source-probe'
EXP = ROOT / '.runtime/P03/experiments/u02-review-topology-20261008-01'
AUTHOR_EVIDENCE = AUTHOR / 'evidence/P03-U02/20261008-01/topology-service'
NATIVE = ROOT / '.runtime/P01/desktop-source'
NODE = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
PIN = '29628c9acdb81b703bbd4080c207a0e7ce5e276e'
AUTHOR_COMMIT = '74b7a3daae2513d7e7eefea3a26c3e264eb65e8d'
BASELINE = 'c691a5b7a975ac4420f880c8233c7b0bb7893958'

def load(p):
    return json.loads(p.read_text(encoding='utf-8'))
def sha(p):
    raw = p.read_bytes()
    return len(raw), hashlib.sha256(raw).hexdigest()
def bind(p, root_name, base):
    p = p.resolve()
    rel = p.relative_to(base.resolve()).as_posix()
    size, digest = sha(p)
    return {'path':rel, 'root':root_name, 'bytes':size, 'sha256':digest}
def command_stdout(name):
    r = load(REVIEW / name)
    assert r['exit_code'] == 0, (name, r.get('stderr'))
    return r, json.loads(r['stdout'].strip())

author_summary = load(AUTHOR_EVIDENCE / 'run-02/summary.json')
run_summary = load(EXP / 'summary.json')
service = load(EXP / 'service-results.json')
commands = load(EXP / 'commands.json')
acl_commands = load(EXP / 'acl-commands.json')
rerun_record = load(REVIEW / 'topology-rerun-command.json')
source_record, source_result = command_stdout('source-bundle-readback-v2-command.json')
acl_record, acl_result = command_stdout('acl-restoration-readback-v2-command.json')
commit_record, commit_result = command_stdout('commit-scope-readback-command.json')
object_record, object_result = command_stdout('commit-object-readback-command.json')
verify_gate = load(REVIEW / 'review-verification-command.json')

assert author_summary['runtime']['nativePin'] == PIN == run_summary['runtime']['nativePin']
assert author_summary['bundle']['sha256'] == run_summary['bundle']['sha256']
assert author_summary['script']['sha256'] == run_summary['script']['sha256']
assert sha(pathlib.Path(author_summary['bundle']['path']))[1] == author_summary['bundle']['sha256']
assert sha(pathlib.Path(run_summary['bundle']['path']))[1] == run_summary['bundle']['sha256']
assert run_summary['status'] == 'pass' and service['status'] == 'pass'
assert len(service['cases']) == 14 and all(c['status'] == 'pass' for c in service['cases'])
assert len(commands) == 43 and all(c['exit_code'] == 0 for c in commands)
assert len(acl_commands) == 2 and all(c['exit_code'] == 0 for c in acl_commands)
assert run_summary['memoryBefore'] == run_summary['memoryAfter']
assert run_summary['model'] == 'NOT_RUN' and run_summary['desktop'] == 'NOT_RUN'
assert run_summary['productRegistry'] == 'NOT_IMPLEMENTED' and run_summary['sourceUnchanged'] is True
assert run_summary['crossVolume']['sourceVolume'].lower() != run_summary['crossVolume']['targetVolume'].lower()
assert pathlib.Path(run_summary['crossVolume']['crossRoot']).exists()
assert pathlib.Path(run_summary['crossVolume']['sourceRetainedAsArchive']).exists()
assert pathlib.Path(run_summary['crossVolume']['active']['workspace']).exists()
assert run_summary['crossVolume']['active']['commonDir'] == run_summary['before'][0]['commonDir']
assert run_summary['crossVolume']['active']['commit'] == run_summary['before'][2]['commit']
assert run_summary['copied']['commonDir'] != run_summary['before'][0]['commonDir']
assert run_summary['moved']['commonDir'] == run_summary['before'][0]['commonDir']
assert run_summary['roots']['legacyA'] != run_summary['roots']['legacyB']
assert run_summary['roots']['oldWorktree'] != run_summary['roots']['movedWorktree']
assert run_summary['roots']['stableA'] == run_summary['roots']['stableMoved'] == run_summary['roots']['stableCross']
assert run_summary['roots']['stableA'] != run_summary['roots']['stableB']
assert source_result['status'] == 'pass' and source_result['mismatches'] == []
assert source_result['compile_input_count'] == 280 and source_result['tracked_git_blob_inputs'] == 183
assert source_result['ignored_node_modules_inputs'] == 96 and source_result['synthetic_entry_inputs'] == 1
assert source_result['tracked_blob_matches'] == 183 and source_result['ignored_input_hash_matches'] == 96
assert source_result['external_input_hash_matches'] == 1
assert source_result['native_pin'] == PIN and source_result['source_clean'] is True
assert acl_result['status'] == 'pass' and acl_result['explicit_deny_present'] is False
assert acl_result['target_sha256'] == acl_result['summary_expected_sha256']
assert commit_result['status'] == 'pass' and commit_result['parents'] == [BASELINE]
assert commit_result['changed_path_count'] == 10 and commit_result['scope_allowed'] is True
assert commit_result['author_worktree_clean'] and commit_result['root_clean']
assert object_result['status'] == 'pass' and object_result['head_exact'] and object_result['commit_blob_and_worktree_matches_report']
assert object_result['tracked_worktree_changes'] == [] and object_result['staged_worktree_changes'] == []
assert verify_gate['exit_code'] == 1 and 'AssertionError' in verify_gate['stderr']
start = datetime.datetime.fromisoformat(rerun_record['started_at'])
end = datetime.datetime.fromisoformat(rerun_record['completed_at'])
elapsed = (end-start).total_seconds()
assert rerun_record['exit_code'] == 0 and elapsed < 4.0
rerun_stdout = json.loads(rerun_record['stdout'].strip())
assert rerun_stdout['status'] == 'pass' and rerun_stdout['sourcePin'] == PIN
assert rerun_stdout['output'] == str(EXP)

# Bind all ten author-commit files, high-value native source output, the complete rerun bundle/results,
# owned fixture payloads, tool inputs and the independent reviewer commands/scripts.
artifacts = []
for rel in [
    'spikes/P03/topology-service.mjs',
    'evidence/P03-U02/20261008-01/topology-service/result.md',
    'evidence/P03-U02/20261008-01/topology-service/run-01-command.json',
    'evidence/P03-U02/20261008-01/topology-service/run-02-command.json',
    'evidence/P03-U02/20261008-01/topology-service/run-02/acl-commands.json',
    'evidence/P03-U02/20261008-01/topology-service/run-02/commands.json',
    'evidence/P03-U02/20261008-01/topology-service/run-02/esbuild-metafile.json',
    'evidence/P03-U02/20261008-01/topology-service/run-02/fixtures.json',
    'evidence/P03-U02/20261008-01/topology-service/run-02/service-results.json',
    'evidence/P03-U02/20261008-01/topology-service/run-02/summary.json',
]:
    artifacts.append(bind(AUTHOR / rel, 'author_worktree', AUTHOR))

for p in [
    pathlib.Path(author_summary['bundle']['path']),
    EXP / 'native-entry.ts', EXP / 'native-memory.mjs', EXP / 'esbuild-metafile.json',
    EXP / 'summary.json', EXP / 'service-results.json', EXP / 'commands.json', EXP / 'acl-commands.json', EXP / 'fixtures.json',
    EXP / 'empty.gitconfig',
    EXP / 'A/repo/schema.mjs', EXP / 'A/worktree-moved/schema.mjs', EXP / 'A/worktree-two/schema.mjs',
    EXP / 'B/repo/schema.mjs', EXP / 'copy/repo/schema.mjs',
]:
    root_name = 'author_worktree' if p.resolve().is_relative_to(AUTHOR.resolve()) else 'baseline_repository'
    base = AUTHOR if root_name == 'author_worktree' else ROOT
    artifacts.append(bind(p, root_name, base))

memories = EXP / 'profile/.zcode/cli/memories'
for key in ['legacyA','legacyB']:
    m = pathlib.Path(run_summary['roots'][key])
    for name in ['MEMORY.md','schema.md']:
        artifacts.append(bind(m / name, 'baseline_repository', ROOT))

review_files = [
    'topology-rerun-command.json',
    'source-bundle-readback.py','source-bundle-readback-command.json',
    'source-bundle-readback-v2.py','source-bundle-readback-v2-command.json',
    'acl-restoration-readback.py','acl-restoration-readback-command.json',
    'acl-restoration-readback-v2.py','acl-restoration-readback-v2-command.json',
    'commit-scope-readback.py','commit-scope-readback-command.json',
    'commit-object-readback.py','commit-object-readback-command.json',
    'review-verification-command.json',
    'make-review-final.py',
]
for name in review_files:
    artifacts.append(bind(REVIEW / name, 'review_directory', REVIEW))

# The compile input manifest enumerates every source/dependency/generated input used by the actual bundle.
immutable_inputs = []
for item in run_summary['compileInputs']:
    p = pathlib.Path(item['path']).resolve()
    rel = p.relative_to(ROOT).as_posix()
    size, digest = sha(p)
    assert size == item['bytes'] and digest == item['sha256'], rel
    immutable_inputs.append({'path':rel,'root':'baseline_repository','bytes':size,'sha256':digest,'role':'esbuild compile input'})
extra_inputs = [
    NATIVE / 'pnpm-lock.yaml', NATIVE / 'package.json',
    NATIVE / 'node_modules/zod/package.json', NATIVE / 'node_modules/marked/package.json',
    NATIVE / 'node_modules/esbuild/package.json', NATIVE / 'node_modules/esbuild/lib/main.js',
    NATIVE / 'node_modules/@esbuild/win32-x64/package.json', NATIVE / 'node_modules/@esbuild/win32-x64/esbuild.exe',
    NODE,
]
for p in extra_inputs:
    immutable_inputs.append({**bind(p,'baseline_repository',ROOT),'role':'pinned tool or dependency identity'})

report = {
  'schema':'p03-independent-review/v1',
  'created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'task':'P03-U02-topology-service-subexperiment',
  'decision':'pass',
  'unit_acceptance':'not_decided',
  'review_target':{
    'author_commit':AUTHOR_COMMIT,'baseline_commit':BASELINE,'author_worktree':str(AUTHOR),
    'attempt':'20261008-01/topology-service; independent rerun u02-review-topology-20261008-01',
    'changed_paths':10,
  },
  'reviewer':'Codex independent readback',
  'scope':'独立审查并复跑 Native topology-service 子试验。此 pass 只针对该子试验，不是完整 P03-U02 集成审查或单元接受；没有写 coordinator/acceptance 状态。',
  'checks':[
    {'id':'exact-commit-baseline-scope-and-cleanliness','status':'pass',
     'detail':f"Commit {AUTHOR_COMMIT} is a direct child of baseline {BASELINE}; reviewer readback confirms 10 changed paths are limited to spikes/P03 and the topology-service evidence directory; the initial scope readback was clean, and a later commit-object readback confirms every reviewed committed blob and checked-out tracked file still matches. Two unrelated untracked files appeared later, so the standard verify-review clean-tree gate rejected this active worktree; root remains clean."},
    {'id':'actual-pinned-native-service-and-bundle-identity','status':'pass',
     'detail':f"The unmodified Native checkout is clean at {PIN}. The probe bundles actual createMemoryService, resolveProjectMemoryRoot and formatProjectMemoryIndexContent from that checkout (not a mock). Reviewer readback matched all 183 tracked compile inputs to exact Git blobs, all 96 ignored node_modules inputs to their recorded hashes, and the generated entry; dependency versions zod 4.6.5, marked 16.4.2 and esbuild 0.27.7 appear in the pinned lock. The independent bundle SHA-256 {run_summary['bundle']['sha256']} exactly matches author run-02."},
    {'id':'native-file-service-invalid-utf8-and-acl-recovery','status':'pass',
     'detail':'Independent rerun passed 14/14 service assertions on synthetic isolated files. Invalid UTF-8 bytes were replacement-decoded and malformed frontmatter was returned without validation; these are documented contract gaps, not evidence of contract satisfaction. The owned file ACL denied service read with EPERM; the deny ACE was removed, the service reread original bytes, and post-run icacls plus content hash show inherited ACL/no explicit deny and restored bytes.'},
    {'id':'git-move-copy-and-cross-volume-repair','status':'pass',
     'detail':f"Real Git fixtures distinguish linked worktrees from standalone copies: same-volume git worktree move kept common-dir identity; directory copy had its own common-dir; E: to C: cross-volume copy had matching pre-repair tree hashes, then git worktree repair restored the original common-dir/commit and worktree registration. The E: source remains as an archive. Reviewer rerun reproduced these results in {run_summary['crossVolume']['crossRoot']}."},
    {'id':'synthetic-scope-and-not-run-boundaries','status':'pass',
     'detail':'All memory files and project repositories are generated under the experiment output or a dedicated C: temp cross-volume fixture. Memory tree hashes are equal before/after; Native source is unchanged. The result explicitly marks model and Desktop NOT_RUN and product registry NOT_IMPLEMENTED. This sub-experiment does not claim full product behavior or U02 acceptance.'},
  ],
  'reviewer_readback':{
    'rerun':{'command_record':'topology-rerun-command.json','elapsed_seconds':elapsed,'exit_code':0,
             'native_bundle_sha256':run_summary['bundle']['sha256'],'service_cases':len(service['cases']),
             'git_commands':len(commands),'acl_commands':len(acl_commands)},
    'source_bundle':{'command_record':'source-bundle-readback-v2-command.json','compile_inputs':280,
                     'tracked_git_blobs_matched':183,'ignored_dependency_inputs_matched':96,
                     'generated_entries_matched':1,'mismatches':0},
    'acl_recovery':{'command_record':'acl-restoration-readback-v2-command.json',
                    'target_sha256':acl_result['target_sha256'],'explicit_deny_present':False},
    'commit_scope':{'command_record':'commit-scope-readback-command.json','changed_paths':10,'clean_at_initial_readback':True,'current_tracked_changes':[],'current_untracked_files':object_result['untracked_worktree_files'],'exact_commit_blob_readback':'commit-object-readback-command.json'},
    'coordinator_verifier':{'command_record':'review-verification-command.json','exit_code':verify_gate['exit_code'],'result':'clean-tree gate rejected active worktree; exact committed blobs independently matched'},
    'reviewer_diagnostics':[
      {'command_record':'source-bundle-readback-command.json','exit_code':1,
       'note':'First reviewer helper assumed every esbuild input is a Git-tracked blob; the error exposed ignored node_modules inputs. Corrected v2 classified and checked all inputs, passed, and its failure record is retained.'},
      {'command_record':'acl-restoration-readback-command.json','exit_code':1,
       'note':'First reviewer helper used a POSIX path suffix against Windows summary paths. Corrected v2 normalized paths, verified restored bytes and ACL, passed, and its failure record is retained.'},
    ],
  },
  'limitations':[
    'The author worktree currently has two untracked files from concurrent U02 work; verify-review therefore did not pass its clean-tree guard. The exact reviewed commit remained HEAD, there were no staged/tracked changes, and independent git-object readback matched all ten author artifacts. Neither untracked file was changed by this review.',
    'The 96 bundled node_modules inputs are Git-ignored; the review matched their actual bytes to the run summary, and the package versions are in the pinned lock, but those installed package bytes are not Git tree blobs. Complete compile-input paths, sizes and SHA-256 values are bound below.',
    'ACL recovery is verified by successful service reread, restored content hash and absence of explicit deny after cleanup. The probe does not preserve a binary before/after security-descriptor snapshot.',
    'The cross-volume C: temp fixture is deliberately retained as a synthetic worktree archive at the recorded path; it is separate from project data.',
    'Model, Desktop application, product registry/persistent identity, product-level tests and final Native-author U02 integration remain NOT_RUN or pending. This report cannot be used as U02 acceptance.',
  ],
  'artifacts':artifacts,
  'immutable_inputs':immutable_inputs,
}
out = REVIEW / 'review-final.json'
out.write_bytes((json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode('utf-8'))
print(json.dumps({'path':str(out),'bytes':out.stat().st_size,'sha256':sha(out)[1],
                  'artifact_count':len(artifacts),'immutable_input_count':len(immutable_inputs),
                  'unit_acceptance':report['unit_acceptance'],'decision':report['decision']}))



