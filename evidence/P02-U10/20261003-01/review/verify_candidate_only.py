import importlib.util, json
runner=r'E:\Xiadie\Xiadie\.runtime\P02\worktrees\u10\tests\integration\P01\desktop.py'
spec=importlib.util.spec_from_file_location('frozen_p01_desktop',runner)
if spec is None or spec.loader is None: raise RuntimeError('frozen_p01_loader_missing')
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
result=mod.verify_candidate(r'E:\Xiadie\Xiadie\.runtime\P02\experiments\u10\candidate-02')
print(json.dumps({'result':'pass','verified_artifacts':result['verified_artifacts'],'verified_repository_inputs':result['verified_repository_inputs'],'descriptor_sha256':result['descriptor_sha256'],'repository_commit':result['descriptor']['repositoryCommit'],'source_commit':result['descriptor']['sourceCommit'],'candidate':result['resolved_paths']['assemblyRoot'],'contract_checks':['factory','recipe','CLI','protocol patch','provider config','Desktop paths','Node v24.14.0']},ensure_ascii=False))
