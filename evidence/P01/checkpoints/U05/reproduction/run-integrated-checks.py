import datetime, hashlib, json, os, pathlib, re, subprocess, sys

root = pathlib.Path(r'E:\Xiadie\Xiadie')
out = root / 'evidence/P01/checkpoints/U05/root-validation'
assert not out.exists(), 'Keep previous validation logs'
out.mkdir(parents=True)
node_dir = root / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64'
node = str(node_dir / 'node.exe')
bin_dir = root / '.runtime/P01/desktop-build-evidence/bin'
pnpm = [node, str(node_dir / 'node_modules/corepack/dist/corepack.js'), 'pnpm@10.33.2']
env = os.environ.copy()
env['PATH'] = str(bin_dir) + os.pathsep + str(node_dir) + os.pathsep + env.get('PATH', '')
record = {'cwd': str(root), 'commit_before_checks': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
          'started_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commands': []}
record['node_version'] = subprocess.check_output([node, '--version'], text=True, env=env).strip()
record['pnpm_version'] = subprocess.check_output(pnpm + ['--version'], text=True, env=env, cwd=root).strip()
assert record['node_version'] == 'v24.14.0' and record['pnpm_version'] == '10.33.2'
jobs = [('check', pnpm + ['run', 'check'], None), ('build', pnpm + ['run', 'build'], None)]
for suite, expected in [('unit', 19), ('contract', 3), ('integration', 25)]:
    jobs.append((suite, [node, 'tools/run-tests.mjs', suite, 'P01-U03', 'P01-U04', 'P01-U05'], expected))
for label, argv, expected in jobs:
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    stdout = out / f'{label}.stdout.log'
    stderr = out / f'{label}.stderr.log'
    with stdout.open('wb') as so, stderr.open('wb') as se:
        result = subprocess.run(argv, cwd=root, env=env, stdout=so, stderr=se, timeout=180)
    entry = {'label': label, 'argv': argv, 'cwd': str(root), 'started_at_utc': started,
             'ended_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit_code': result.returncode}
    for key, p in [('stdout', stdout), ('stderr', stderr)]:
        data = p.read_bytes()
        entry[key] = {'path': p.relative_to(root).as_posix(), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    if expected is not None:
        content = stdout.read_text(encoding='utf-8')
        entry['tests'] = int(re.search(r'\btests (\d+)', content).group(1))
        entry['fail'] = int(re.search(r'\bfail (\d+)', content).group(1))
        entry['skipped'] = int(re.search(r'\bskipped (\d+)', content).group(1))
        assert entry['tests'] == expected and entry['fail'] == 0 and entry['skipped'] == 0
    record['commands'].append(entry)
    (out / 'execution.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({'label': label, 'exit_code': result.returncode, 'tests': entry.get('tests')}), flush=True)
    if result.returncode:
        sys.exit(result.returncode)
record['scope'] = 'Integrated library regression only; Core boundary NOT_RUN, no Desktop/model/E2E or package claim'
(out / 'execution.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
