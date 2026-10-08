import datetime, hashlib, json, pathlib, shutil, subprocess, time, uuid
ROOT = pathlib.Path(r'E:\Xiadie\Xiadie')
AUTHOR = ROOT / '.runtime/P03/worktrees/u03'
REVIEW = ROOT / '.runtime/P03/reviews/u03-20261008'
RUN = REVIEW / 'unit-review-01'
HARNESS = RUN / 'harness'
HARNESS.mkdir(parents=True, exist_ok=False)
source_test = AUTHOR / 'packages/projects/test/registry.test.mjs'
source_runner = AUTHOR / 'tools/run-tests.mjs'
node = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
compiled_root = REVIEW / 'build-review-01/dist'
experiment_root = RUN / 'experiments'
experiment_root.mkdir(parents=True, exist_ok=False)
c_parent = pathlib.Path(r'C:\Users\liyi\.codex\tmp')
assert c_parent.is_dir() and not c_parent.is_symlink()
c_root = c_parent / ('P03-u03-review-' + uuid.uuid4().hex)
c_root.mkdir()
source = source_test.read_text(encoding='utf-8')
replacements = [
 ('const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments", "u03");', 'const experimentRoot = ' + json.dumps(str(experiment_root)) + ';'),
 ('const registryModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "registry.js")).href;', 'const registryModuleUrl = pathToFileURL(path.join(' + json.dumps(str(compiled_root)) + ', "packages", "projects", "registry.js")).href;'),
 ('const base = "C:\\\\Users\\\\liyi\\\\.codex\\\\tmp";', 'const base = ' + json.dumps(str(c_root)) + ';'),
]
patched = source
for old, new in replacements:
    count = patched.count(old)
    if count != 1:
        raise SystemExit(f'expected one source harness replacement, found {count}: {old}')
    patched = patched.replace(old, new)
test_copy = HARNESS / 'registry.test.mjs'
test_copy.write_text(patched, encoding='utf-8', newline='\n')
wrapper = HARNESS / 'run-unit-review.mjs'
wrapper_source = f'''import {{ spawnSync }} from "node:child_process";
import {{ pathToFileURL }} from "node:url";
const authorRoot = {json.dumps(str(AUTHOR))};
const sourceRunner = await import(pathToFileURL(authorRoot + "/tools/run-tests.mjs").href);
const selected = sourceRunner.selectTests("unit", ["P03-U03"]);
if (JSON.stringify(selected) !== JSON.stringify(["packages/projects/test/registry.test.mjs"])) {{
  throw new Error(`unexpected committed selector mapping: ${{JSON.stringify(selected)}}`);
}}
const result = spawnSync(process.execPath, ["--test", {json.dumps(str(test_copy))}], {{
  cwd: authorRoot, stdio: "inherit", windowsHide: true,
}});
if (result.error) {{ console.error(result.error.message); process.exitCode = 1; }}
else process.exitCode = result.status ?? 1;
'''
wrapper.write_text(wrapper_source, encoding='utf-8', newline='\n')
started = datetime.datetime.now(datetime.timezone.utc)
t0 = time.monotonic()
argv = [str(node), str(wrapper)]
try:
    result = subprocess.run(argv, cwd=AUTHOR, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180)
    exit_code = result.returncode
    stdout, stderr = result.stdout, result.stderr
except subprocess.TimeoutExpired as exc:
    exit_code = 124
    stdout = exc.stdout.decode('utf-8','replace') if isinstance(exc.stdout,bytes) else (exc.stdout or '')
    stderr = exc.stderr.decode('utf-8','replace') if isinstance(exc.stderr,bytes) else (exc.stderr or '')
completed = datetime.datetime.now(datetime.timezone.utc)
# Remove only the uniquely-created C-drive temp directory after checking its exact resolved location.
resolved_c_root = c_root.resolve(strict=True)
assert resolved_c_root == c_root and c_root.parent.resolve(strict=True) == c_parent.resolve(strict=True)
shutil.rmtree(c_root)
record = {
 'schema':'p03-u03-review-unit-command/v1','selector':['unit','P03-U03'],
 'argv':argv,'cwd':str(AUTHOR),'started_at_utc':started.isoformat(),
 'completed_at_utc':completed.isoformat(),'elapsed_seconds':round(time.monotonic()-t0,3),
 'exit_code':exit_code,'timeout_seconds':180,'stdout':stdout,'stderr':stderr,
 'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=AUTHOR,text=True).strip(),
 'source_test_sha256':hashlib.sha256(source.encode()).hexdigest(),
 'harness_test_sha256':hashlib.sha256(patched.encode()).hexdigest(),
 'harness_wrapper_sha256':hashlib.sha256(wrapper_source.encode()).hexdigest(),
 'harness_changes':[
   {'purpose':'redirect fixture writes under the review directory','file':'harness/registry.test.mjs','replacements':3},
   {'purpose':'compile output imported from review-local fresh TypeScript build','file':'harness/registry.test.mjs'},
   {'purpose':'invoke committed unit/P03-U03 selector mapping while running the isolated harness copy','file':'harness/run-unit-review.mjs'}
 ],
 'e_drive_fixture_root':str(experiment_root),'temporary_c_drive_fixture_root':str(c_root),
 'temporary_c_drive_fixture_removed':not c_root.exists(),
 'build_output_root':str(compiled_root)
}
(REVIEW/'unit-review-01-command.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(record,ensure_ascii=False))
raise SystemExit(exit_code)