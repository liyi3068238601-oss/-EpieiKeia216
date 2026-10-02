import datetime, hashlib, json, os, pathlib, re, subprocess, sys

root = pathlib.Path(r'E:\Xiadie\Xiadie')
out = root / 'evidence/P01/checkpoints/U06/root-validation'
assert not out.exists(), 'Keep earlier validation outputs'
out.mkdir(parents=True)
node_dir = root / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64'
node = str(node_dir / 'node.exe')
pnpm = [node, str(node_dir / 'node_modules/corepack/dist/corepack.js'), 'pnpm@10.33.2']
env = os.environ.copy()
env['PATH'] = str(root / '.runtime/P01/desktop-build-evidence/bin') + os.pathsep + str(node_dir) + os.pathsep + env.get('PATH', '')
env['P01_U06_KEEP_PROFILES'] = '1'
record = {
    'cwd': str(root),
    'commit_before_checks': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'started_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'runner_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    'scope': 'Integrated U03-U06 checks and pinned native bootstrap/real Hook/AiSdkModelAdapter through loopback HTTP mock. No paid model, Desktop, DSH, E2E or distribution claim; absent Core boundary remains NOT_RUN.',
    'commands': [],
}
record['node_version'] = subprocess.check_output([node, '--version'], text=True, env=env).strip()
record['pnpm_version'] = subprocess.check_output(pnpm + ['--version'], text=True, env=env, cwd=root).strip()
assert record['node_version'] == 'v24.14.0' and record['pnpm_version'] == '10.33.2'
jobs = [('check', pnpm + ['run', 'check']), ('build', pnpm + ['run', 'build'])]
for suite in ['unit', 'contract', 'integration']:
    jobs.append((suite, [node, 'tools/run-tests.mjs', suite, 'P01-U03', 'P01-U04', 'P01-U05', 'P01-U06']))
for label, argv in jobs:
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    stdout, stderr = out / f'{label}.stdout.log', out / f'{label}.stderr.log'
    with stdout.open('wb') as so, stderr.open('wb') as se:
        result = subprocess.run(argv, cwd=root, env=env, stdout=so, stderr=se, timeout=180)
    entry = {'label': label, 'argv': argv, 'cwd': str(root), 'started_at_utc': started,
             'ended_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit_code': result.returncode}
    for key, p in [('stdout', stdout), ('stderr', stderr)]:
        data = p.read_bytes()
        entry[key] = {'path': p.relative_to(root).as_posix(), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if label in ['unit', 'contract', 'integration']:
        content = stdout.read_text(encoding='utf-8')
        for field in ['tests', 'pass', 'fail', 'skipped']:
            match = re.search(r'\b' + field + r' (\d+)', content)
            entry[field] = int(match.group(1)) if match else None
    record['commands'].append(entry)
    (out / 'execution.json').write_bytes((json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(json.dumps({'label': label, 'exit_code': result.returncode, 'tests': entry.get('tests'), 'fail': entry.get('fail'), 'skipped': entry.get('skipped')}), flush=True)
    if result.returncode or (label in ['unit', 'contract', 'integration'] and (entry['tests'] is None or entry['tests'] < 1 or entry['pass'] != entry['tests'] or entry['fail'] != 0 or entry['skipped'] != 0)):
        sys.exit(result.returncode or 1)
