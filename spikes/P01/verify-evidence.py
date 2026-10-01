from pathlib import Path
import json, hashlib, subprocess, re

root = Path(__file__).resolve().parents[2]
ev = root / 'evidence/P01-U02/20261001-01'
def bind(p):
    p = Path(p); b = p.read_bytes()
    return {'path': p.relative_to(root).as_posix(), 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
def check(v):
    if isinstance(v, dict):
        if {'path','bytes','sha256'} <= v.keys():
            p=root/v['path']
            if p.is_file():
                if bind(p) != {k:v[k] for k in ('path','bytes','sha256')}: failures.append(v['path'])
            else: failures.append('missing:'+v['path'])
        for x in v.values(): check(x)
    elif isinstance(v,list):
        for x in v: check(x)
failures=[]
selected=['baseline.json','summary-mock.json','summary-no-key-control.json','summary-no-key-ui.json','summary-real-flash.json','summary-real-pro.json','startup-port-verification.json','model-usage-cost.json']
for name in selected:
    data=json.loads((ev/name).read_text('utf-8')); check(data)
    if 'code_bindings' in data:
        for name_,sha in data['code_bindings'].items():
            codepath = root/name_ if name_.startswith('spikes/') else root/'spikes/P01'/name_
            if bind(codepath)['sha256'] != sha: failures.append('code:'+name_)
check(json.loads((root/'evidence/P01/status.json').read_text('utf-8')))
assert not failures, failures
ledger=[json.loads(x) for x in (root/'evidence/P01/model-calls.jsonl').read_text().splitlines()]
assert len(ledger)==4
for name in ['summary-real-flash.json','summary-real-pro.json']:
    d=json.loads((ev/name).read_text('utf-8'))
    assert d['passed'] and d['exit_code']==0 and d['production_unchanged'] and d['model_calls']==2
    assert d['production_before']==d['production_after']
    assert 'orchid-42' in d['turns'][0]['response'] and '遐蝶' in d['turns'][0]['response']
diff=subprocess.run(['git','diff','--check'],cwd=root,capture_output=True)
assert diff.returncode==0, diff.stdout.decode()
changed=subprocess.check_output(['git','diff','--name-only','7ab0e81f63e9559a1b182f43b9e242e8a8e703fa','--','planning','evidence/P00-U01','evidence/P00-U12'],cwd=root).decode().splitlines()
assert not changed,changed
files=set((root/'spikes/P01').rglob('*'))
files |= set(ev.rglob('*'))
files |= set((root/'evidence/P01').rglob('*'))
files |= {root/'docs/adr/P01-reuse.md',root/'docs/research/P01/persona-versions.json',root/'docs/research/P01/persona-from-mofox-v3.md',root/'docs/research/P01/persona-decision.md',root/'AGENTS.md'}
files={p for p in files if p.is_file() and '__pycache__' not in p.parts and p.name!='verification.json'}
patterns=[rb'sk-[A-Za-z0-9]{20,}',rb'ghp_[A-Za-z0-9]{20,}',rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']
hits=[p.relative_to(root).as_posix() for p in files if any(re.search(pat,p.read_bytes()) for pat in patterns)]
assert not hits,hits
out={'task':'P01-U02','status':'author_checks_pass','cwd':str(root),'author_base_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip(),'checks':{'hash_bindings':'pass','real_model_ids':2,'generation_attempts':len(ledger),'production_unchanged':'pass','secret_pattern_scan':'pass','git_diff_check':'pass','frozen_plan_and_P00':'unchanged'},'limitations':['Application-layer guards are not an OS sandbox','Desktop hidden DOM/persistence verified; visual screenshot NOT_RUN','Public Windows packaging/runtime assets NOT_RUN','Two official model IDs; backend independence not established','Full persona evaluation and product local-history UI are dependent tasks'], 'bindings':[bind(p) for p in sorted(files)]}
(ev/'verification.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps({'binding_count':len(files),'checks':out['checks']},ensure_ascii=False))
