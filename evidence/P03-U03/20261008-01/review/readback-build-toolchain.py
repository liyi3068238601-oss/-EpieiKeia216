import datetime,hashlib,json,pathlib,subprocess,time
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie'); REVIEW=ROOT/'.runtime/P03/reviews/u03-20261008'; NODE=ROOT/'.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'; TSC=ROOT/'node_modules/typescript/bin/tsc'
rows=[]
for label,argv in [('node',[str(NODE),'--version']),('typescript',[str(NODE),str(TSC),'--version'])]:
 p=subprocess.run(argv,cwd=ROOT,capture_output=True,text=True,encoding='utf-8',errors='replace'); rows.append({'tool':label,'argv':argv,'cwd':str(ROOT),'exit_code':p.returncode,'stdout':p.stdout.strip(),'stderr':p.stderr.strip()})
record={'schema':'p03-u03-review-build-toolchain/v1','checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tools':rows,'status':'pass' if all(x['exit_code']==0 for x in rows) else 'fail'}
(REVIEW/'build-toolchain-readback.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8'); print(json.dumps(record,ensure_ascii=False))