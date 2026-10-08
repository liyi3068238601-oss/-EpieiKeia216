import datetime, hashlib, json, pathlib, subprocess, time
ROOT = pathlib.Path(r'E:\Xiadie\Xiadie')
AUTHOR = ROOT / '.runtime/P03/worktrees/u03'
REVIEW = ROOT / '.runtime/P03/reviews/u03-20261008'
RUN = REVIEW / 'build-review-01'
NODE = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
TSC = ROOT / 'node_modules/typescript/bin/tsc'
RUN.mkdir(parents=True, exist_ok=False)
OUT = RUN / 'dist'
argv = [str(NODE), str(TSC), '--project', 'tsconfig.json', '--outDir', str(OUT), '--pretty', 'false']
started = datetime.datetime.now(datetime.timezone.utc)
t0 = time.monotonic()
result = subprocess.run(argv, cwd=AUTHOR, capture_output=True, text=True, encoding='utf-8', errors='replace')
completed = datetime.datetime.now(datetime.timezone.utc)
files = sorted(p for p in OUT.rglob('*') if p.is_file()) if OUT.exists() else []
record = {
 'schema':'p03-u03-review-build-command/v1','argv':argv,'cwd':str(AUTHOR),
 'started_at_utc':started.isoformat(),'completed_at_utc':completed.isoformat(),
 'elapsed_seconds':round(time.monotonic()-t0,3),'exit_code':result.returncode,
 'timeout_seconds':120,'stdout':result.stdout,'stderr':result.stderr,
 'output_root':str(OUT),'output_file_count':len(files),
 'output_tree_sha256':hashlib.sha256(b''.join((p.relative_to(OUT).as_posix()+':'+hashlib.sha256(p.read_bytes()).hexdigest()+'\n').encode() for p in files)).hexdigest()
}
(REVIEW/'build-review-01-command.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(record,ensure_ascii=False))
raise SystemExit(result.returncode)