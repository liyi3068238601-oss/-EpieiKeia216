import json, pathlib, subprocess, sys
root = pathlib.Path(r'E:\Xiadie\Xiadie')
wt = root / '.runtime/P03/worktrees/u02-source-probe'
commit = '74b7a3daae2513d7e7eefea3a26c3e264eb65e8d'
baseline = 'c691a5b7a975ac4420f880c8233c7b0bb7893958'
def git(cwd, *args, binary=False):
    return subprocess.check_output(['git','-C',str(cwd),*args], text=not binary)
parents = git(wt,'rev-list','--parents','-n','1',commit).strip().split()[1:]
paths = [p.decode('utf-8') for p in git(wt,'diff-tree','--no-commit-id','--name-only','-z','-r',commit,binary=True).split(b'\0') if p]
wt_head = git(wt,'rev-parse','HEAD').strip()
wt_status = git(wt,'status','--porcelain').strip()
root_head = git(root,'rev-parse','HEAD').strip()
root_status = git(root,'status','--porcelain').strip()
diff_check = subprocess.run(['git','-C',str(wt),'diff','--check',baseline,commit],capture_output=True,text=True)
allowed = all(p.startswith('spikes/P03/') or p.startswith('evidence/P03-U02/20261008-01/topology-service/') for p in paths)
result = {'status':'pass' if parents == [baseline] and wt_head == commit and not wt_status and root_head == baseline and not root_status and allowed and diff_check.returncode == 0 else 'fail',
          'commit':commit,'parents':parents,'baseline':baseline,'author_worktree_head':wt_head,'author_worktree_clean':not wt_status,
          'root_head':root_head,'root_clean':not root_status,'changed_path_count':len(paths),'changed_paths':paths,
          'scope_allowed':allowed,'diff_check_exit_code':diff_check.returncode,'diff_check_output':diff_check.stdout+diff_check.stderr}
print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
if result['status'] != 'pass': sys.exit(1)
