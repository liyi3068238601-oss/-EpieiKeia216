import datetime, hashlib, json, pathlib, subprocess
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie'); AUTHOR=ROOT/'.runtime/P03/worktrees/u03'; REVIEW=ROOT/'.runtime/P03/reviews/u03-20261008'; NATIVE=ROOT/'.runtime/P01/desktop-source'
sha=lambda b:hashlib.sha256(b).hexdigest()
def git(repo,*args): return subprocess.check_output(['git',*args],cwd=repo)
def record_file(base,item):
 p=base/item['path']; raw=p.read_bytes(); expected=item['sha256']
 commit_blob=None
 try: commit_blob=git(NATIVE if base==NATIVE else ROOT,'show',f"{item.get('commit', '')}:{item['path']}") if item.get('commit') else None
 except subprocess.CalledProcessError: commit_blob=None
 return {'path':item['path'],'bytes':len(raw),'sha256':sha(raw),'expected_sha256':expected,'sha256_matches':len(raw)==item['bytes'] and sha(raw)==expected,'git_blob_matches':commit_blob==raw if commit_blob is not None else None}
adoption=json.loads((AUTHOR/'evidence/P03-U03/20261008-01/source-adoption.json').read_text(encoding='utf-8'))
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=NATIVE,text=True).strip()
status=subprocess.check_output(['git','status','--porcelain=v1'],cwd=NATIVE,text=True).strip()
native=[]
for item in adoption['native_inputs']:
 item2={**item,'commit':commit}
 native.append(record_file(NATIVE,item2))
accepted=[]
for item in adoption['accepted_inputs']:
 accepted.append(record_file(ROOT,item))
# Also bind SQLite wrapper to the baseline commit tree.
sqlite_item={'path':'packages/storage/events/src/sqlite.ts','bytes':2717,'sha256':'c1cbb368c1feb4f3a5d87b0b5526ea7a761ba0a2de394ecf679767b817cc1e47','commit':'1326a8b036d4695271d194f3bcb1611382433303'}
sqlite=record_file(AUTHOR,sqlite_item)
result={'schema':'p03-u03-review-source-readback/v1','status':'pass' if commit==adoption['native_commit'] and not status and all(x['sha256_matches'] and x['git_blob_matches'] is not False for x in native) and all(x['sha256_matches'] for x in accepted) and sqlite['sha256_matches'] else 'fail','native_commit':commit,'native_worktree_clean':not status,'native_inputs':native,'accepted_provenance_inputs':accepted,'accepted_sqlite_wrapper':sqlite,'interpretation':'The Native helpers are the pinned source/dist files. Native desktop/application execution is not part of this mapping unit.'}
(REVIEW/'native-source-readback.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
# Preserve the first isolated review-harness cleanup error without interpreting the unpersisted child test output.
failed={'schema':'p03-u03-review-harness-failure/v1','stage':'post-test C-drive fixture cleanup','command':'python -X utf8 .runtime/P03/reviews/u03-20261008/run-unit-review.py','cwd':str(ROOT),'exception':'PermissionError: [WinError 5] Access is denied while shutil.rmtree removed a read-only Git object under the uniquely created review fixture root.','child_stdout_captured_by_wrapper':True,'child_stdout_persisted':False,'child_exit_code_persisted':False,'result_interpretation':'Unassessed. The wrapper failed after subprocess.run returned but before it saved the result; no product test conclusion is taken from this attempt. The subsequent official selector run is the review test evidence.','fixture_root':'C:\\Users\\liyi\\.codex\\tmp\\P03-u03-review-d472ae9824394993a5558c4f610b3dac','fixture_cleanup':'not retried; fixture retained'}
(REVIEW/'unit-harness-cleanup-failure.json').write_text(json.dumps(failed,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))