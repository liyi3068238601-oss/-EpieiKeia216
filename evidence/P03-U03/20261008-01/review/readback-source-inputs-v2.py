import hashlib,json,pathlib,subprocess
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie'); AUTHOR=ROOT/'.runtime/P03/worktrees/u03'; REVIEW=ROOT/'.runtime/P03/reviews/u03-20261008'; NATIVE=ROOT/'.runtime/P01/desktop-source'; NATIVE_COMMIT='29628c9acdb81b703bbd4080c207a0e7ce5e276e'; BASELINE='1326a8b036d4695271d194f3bcb1611382433303'
sha=lambda b:hashlib.sha256(b).hexdigest()
def git(repo,*args): return subprocess.check_output(['git',*args],cwd=repo)
def check_hash(base,item,tracked_commit=None):
 p=base/item['path']; raw=p.read_bytes(); blob=None
 if tracked_commit is not None:
  probe=subprocess.run(['git','cat-file','-e',f"{tracked_commit}:{item['path']}"],cwd=base,capture_output=True)
  if probe.returncode==0: blob=git(base,'show',f"{tracked_commit}:{item['path']}")
 return {'path':item['path'],'bytes':len(raw),'sha256':sha(raw),'expected_sha256':item['sha256'],'size_matches':len(raw)==item['bytes'],'sha256_matches':sha(raw)==item['sha256'],'git_blob_match':None if blob is None else blob==raw,'git_blob_note':'ignored generated dist; provenance checked against accepted U02 compile record' if blob is None and tracked_commit==NATIVE_COMMIT else None}
adoption=json.loads((AUTHOR/'evidence/P03-U03/20261008-01/source-adoption.json').read_text(encoding='utf-8'))
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=NATIVE,text=True).strip(); status=subprocess.check_output(['git','status','--porcelain=v1'],cwd=NATIVE,text=True).strip()
native=[]
for item in adoption['native_inputs']: native.append(check_hash(NATIVE,item,NATIVE_COMMIT))
accepted=[]
for item in adoption['accepted_inputs']: accepted.append(check_hash(ROOT,item,BASELINE))
sqlite_item={'path':'packages/storage/events/src/sqlite.ts','bytes':2717,'sha256':'c1cbb368c1feb4f3a5d87b0b5526ea7a761ba0a2de394ecf679767b817cc1e47'}
sqlite=check_hash(AUTHOR,sqlite_item,BASELINE)
compiled=json.loads((ROOT/'evidence/P03-U02/20261008-01/topology-service/native-dist-compile-result.json').read_text(encoding='utf-8'))
outputs=[]
def walk(v):
 if isinstance(v,dict):
  if v.get('relative') in ('memory\\project-root.js','app\\paths.js'): outputs.append(v)
  for x in v.values():walk(x)
 elif isinstance(v,list):
  for x in v:walk(x)
walk(compiled)
expected={'memory\\project-root.js':'3d5bdb8239c073705d4eb0a6371b7462f329607b695ec5dca9f243b58c543d15','app\\paths.js':'b5ca2355a7975f781ada2d750c9a3789157bb027ae3395bd830b8647630265c9'}
for row in outputs: row['provenance_match']=row.get('match') is True and row.get('existing',{}).get('sha256')==expected[row['relative']] and row.get('generated',{}).get('sha256')==expected[row['relative']]
compile_record_sha=sha((ROOT/'evidence/P03-U02/20261008-01/topology-service/native-dist-compile-result.json').read_bytes())
status_pass=(commit==NATIVE_COMMIT and not status and all(x['size_matches'] and x['sha256_matches'] and x['git_blob_match'] is not False for x in native) and all(x['size_matches'] and x['sha256_matches'] and x['git_blob_match'] is not False for x in accepted) and sqlite['sha256_matches'] and len(outputs)==2 and all(x['provenance_match'] for x in outputs))
result={'schema':'p03-u03-review-source-readback/v2','status':'pass' if status_pass else 'fail','native_commit':commit,'native_worktree_clean':not status,'native_inputs':native,'accepted_provenance_inputs':accepted,'accepted_sqlite_wrapper':sqlite,'native_dist_source_to_output':{'compile_result_sha256':compile_record_sha,'helper_outputs':outputs,'scope':'accepted U02 isolated compile comparison; this reviewer did not repeat the Native multi-package compile'},'interpretation':'The checked Native input bytes and actual loaded dist helper hashes match the author source-adoption record. Source files match the pinned Native Git blobs; ignored generated dist files are separately matched by accepted U02 source-to-dist evidence.'}
(REVIEW/'native-source-readback.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
if not status_pass:raise SystemExit(1)