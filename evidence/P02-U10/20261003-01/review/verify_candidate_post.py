import importlib.util,json,subprocess
root=r'E:\Xiadie\Xiadie'
runner=r'E:\Xiadie\Xiadie\.runtime\P02\worktrees\u10\tests\integration\P01\desktop.py'
spec=importlib.util.spec_from_file_location('frozen_p01_desktop',runner)
if spec is None or spec.loader is None: raise RuntimeError('frozen_p01_loader_missing')
mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
candidate=mod.verify_candidate(r'E:\Xiadie\Xiadie\.runtime\P02\experiments\u10\candidate-02')
source=mod.verify_pinned_source()
diff=subprocess.check_output(['git','-C',r'E:\Xiadie\Xiadie\.runtime\P02\worktrees\u10','diff','--name-only','7f947b3abc172aa2e8dc3614abec0679b0b8d24d','c894d0525b43cf0e3c47639b7246b4007b45114b']).decode().splitlines()
if any(not p.startswith('evidence/P02-U10/20261003-01/') for p in diff): raise RuntimeError('post-build source drift detected')
print(json.dumps({'result':'pass','verified_artifacts':candidate['verified_artifacts'],'verified_repository_inputs':candidate['verified_repository_inputs'],'descriptor_sha256':candidate['descriptor_sha256'],'repository_commit':candidate['descriptor']['repositoryCommit'],'source_commit':candidate['descriptor']['sourceCommit'],'fixed_native_source':source,'source_to_author_commit_diff_count':len(diff),'post_build_non_evidence_drift':0},ensure_ascii=False))
