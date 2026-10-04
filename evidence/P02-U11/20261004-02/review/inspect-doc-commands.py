import json,pathlib
E=pathlib.Path(r'.runtime/P02/worktrees/mature-freeze/evidence/P02-U11/20261004-02')
idx=json.loads((E/'command-index.json').read_bytes());print('indexed',len(idx['commands']))
for c in idx['commands']:
 x=json.loads((E/c['path']).read_bytes()); print(c['path'],x.get('exit_code'),x.get('argv'))
print('selfRef',idx.get('selfReferenceExclusion'))
for p in ['result.md','source-decision.md','rollback.md']:
 t=(E/p).read_text(encoding='utf8');print('\n---',p);print(t)
