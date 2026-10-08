import hashlib, json, pathlib, subprocess, sys
root=pathlib.Path(r'E:\Xiadie\Xiadie').resolve()
wt=root/'.runtime/P03/worktrees/u02-source-probe'
report=json.loads((root/'.runtime/P03/reviews/u02-20261008/review-final.json').read_text(encoding='utf-8'))
commit=report['review_target']['author_commit']; baseline=report['review_target']['baseline_commit']
def git(cwd,*args,binary=False): return subprocess.check_output(['git','-C',str(cwd),*args],text=not binary)
head=git(wt,'rev-parse','HEAD').strip()
parents=git(wt,'rev-list','--parents','-n','1',commit).strip().split()[1:]
tracked=git(wt,'diff','--name-only').strip()
staged=git(wt,'diff','--cached','--name-only').strip()
changed=[p.decode('utf-8') for p in git(wt,'diff-tree','--no-commit-id','--name-only','-z','-r',commit,binary=True).split(b'\0') if p]
actual_untracked=[p.replace('\\','/') for p in git(wt,'ls-files','--others','--exclude-standard').splitlines()]
expected=[]
for item in report['artifacts']:
    if item.get('root')!='author_worktree': continue
    rel=item['path'].replace('\\','/')
    blob=git(wt,'cat-file','blob',f'{commit}:{rel}',binary=True)
    work=(wt/pathlib.Path(rel)).read_bytes()
    oncommit={'path':rel,'commit_bytes':len(blob),'commit_sha256':hashlib.sha256(blob).hexdigest(),
              'worktree_bytes':len(work),'worktree_sha256':hashlib.sha256(work).hexdigest(),
              'report_sha256':item['sha256']}
    if len(blob)!=item['bytes'] or hashlib.sha256(blob).hexdigest()!=item['sha256'] or work!=blob:
        expected.append(oncommit)
assert head==commit and parents==[baseline] and not tracked and not staged and not expected
assert all(p.startswith('spikes/P03/') or p.startswith('evidence/P03-U02/20261008-01/topology-service/') for p in changed)
result={'status':'pass','commit':commit,'baseline':baseline,'parents':parents,'head_exact':head==commit,
        'tracked_worktree_changes':[],'staged_worktree_changes':[],'untracked_worktree_files':actual_untracked,
        'commit_changed_path_count':len(changed),'commit_changed_paths':changed,
        'reviewed_author_artifact_count':sum(1 for x in report['artifacts'] if x.get('root')=='author_worktree'),
        'commit_blob_and_worktree_matches_report':True,'mismatches':expected,
        'note':'This snapshot readback validates exact committed blobs and checked-out tracked files while retaining later untracked files. It is not the coordinator verify-review clean-tree gate.'}
print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
