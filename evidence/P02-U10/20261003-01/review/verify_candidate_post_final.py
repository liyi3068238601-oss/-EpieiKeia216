import importlib.util,json,subprocess
runner=r'E:\Xiadie\Xiadie\.runtime\P02\worktrees\u10\tests\integration\P01\desktop.py'
spec=importlib.util.spec_from_file_location('frozen_p01_desktop',runner)
if spec is None or spec.loader is None: raise RuntimeError('frozen_p01_loader_missing')
mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
candidate=mod.verify_candidate(r'E:\Xiadie\Xiadie\.runtime\P02\experiments\u10\candidate-02')
source=mod.verify_pinned_source()
wt=r'E:\Xiadie\Xiadie\.runtime\P02\worktrees\u10'
diff=subprocess.check_output(['git','-C',wt,'diff','--name-only','7f947b3abc172aa2e8dc3614abec0679b0b8d24d','c894d0525b43cf0e3c47639b7246b4007b45114b']).decode().splitlines()
non_evidence=[p for p in diff if not p.startswith('evidence/P02-U10/20261003-01/')]
if non_evidence != ['docs/evals/P02/requirement-evidence.md']: raise RuntimeError(f'unexpected post-build non-evidence paths: {non_evidence}')
print(json.dumps({'result':'pass','verified_artifacts':candidate['verified_artifacts'],'verified_repository_inputs':candidate['verified_repository_inputs'],'descriptor_sha256':candidate['descriptor_sha256'],'repository_commit':candidate['descriptor']['repositoryCommit'],'source_commit':candidate['descriptor']['sourceCommit'],'fixed_native_source':source,'source_to_author_commit_non_evidence_paths':non_evidence,'code_or_test_drift':0},ensure_ascii=False))
