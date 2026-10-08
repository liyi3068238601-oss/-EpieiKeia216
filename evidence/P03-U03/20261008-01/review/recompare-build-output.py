import hashlib, json, pathlib, subprocess
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie'); REVIEW=ROOT/'.runtime/P03/reviews/u03-20261008'
AUTHOR=ROOT/'.runtime/P03/worktrees/u03'; OLD='1608f51224e7d8728c3b44014e63e8a715909468'; NEW='2530a944f9c4f403675378e843c44a11c9880681'
changed=subprocess.check_output(['git','diff','--name-only',OLD,NEW],cwd=ROOT,text=True).splitlines()
source_changed=subprocess.check_output(['git','diff','--name-only',OLD,NEW,'--','packages/projects/registry.ts','packages/projects/test/registry.test.mjs','tools/run-tests.mjs','tsconfig.json'],cwd=ROOT,text=True).splitlines()
fresh=REVIEW/'build-review-01/dist'; compiled=AUTHOR/'dist'
rows=[]; mismatches=[]
for p in sorted(x for x in fresh.rglob('*') if x.is_file()):
 rel=p.relative_to(fresh); q=compiled/rel
 if not q.is_file(): mismatches.append({'path':rel.as_posix(),'issue':'missing-in-author-dist'}); continue
 a=hashlib.sha256(p.read_bytes()).hexdigest(); b=hashlib.sha256(q.read_bytes()).hexdigest()
 rows.append({'path':rel.as_posix(),'review_sha256':a,'author_sha256':b})
 if a!=b:mismatches.append({'path':rel.as_posix(),'issue':'sha256-mismatch','review_sha256':a,'author_sha256':b})
extra=sorted(p.relative_to(compiled).as_posix() for p in compiled.rglob('*') if p.is_file() and not (fresh/p.relative_to(compiled)).is_file())
record={'schema':'p03-u03-review-build-output-readback/v1','reviewed_commit':NEW,'prior_code_commit':OLD,'commit_changed_paths':changed,'code_surface_changed_paths':source_changed,'review_output_file_count':len(rows),'author_matching_file_count':len(rows)-len(mismatches),'author_dist_extra_file_count':len(extra),'author_dist_extra_files':extra,'mismatches':mismatches,'status':'pass' if not mismatches else 'fail'}
(REVIEW/'build-output-readback.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(record,ensure_ascii=False))
if mismatches: raise SystemExit(1)