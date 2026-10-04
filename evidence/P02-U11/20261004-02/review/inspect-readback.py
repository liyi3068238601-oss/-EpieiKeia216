import json,pathlib
E=pathlib.Path(r'.runtime/P02/worktrees/mature-freeze/evidence/P02-U11/20261004-02')
for p in ['candidate-proof/runs/full/summary.json','candidate-proof/runs/degradation/summary.json','candidate-proof/runs/full/scenarios/success/scenario-result.json','candidate-proof/runs/full/scenarios/success/ledger-verification.json','candidate-proof/runs/full/p02-desktop-runner.json','command-index.json','candidate-proof/candidate-descriptor.json']:
 q=E/p
 print('\n---',p)
 x=json.loads(q.read_bytes()) if q.suffix=='.json' else q.read_text(encoding='utf-8')
 print(json.dumps(x,ensure_ascii=False,indent=2)[:18000] if isinstance(x,(dict,list)) else x[:5000])
