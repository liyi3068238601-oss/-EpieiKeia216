import datetime
import hashlib
import json
import pathlib
import re
import stat
import sys

ROOT = pathlib.Path(r'E:\Xiadie\Xiadie')
DEST = ROOT / '.runtime/P02/preparation/runtime-raw-candidate09-root-20261004-1050'
DESCRIPTOR = ROOT / '.runtime/P02/experiments/mature-integration/candidate-09/candidate-descriptor.json'
PIN = '6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74'
SUITES = {'desktop-full-candidate09': {'success', 'read_success', 'read_failure', 'cancel_recovery', 'disabled_native', 'pro_denied'},
          'desktop-degradation-candidate09': {'no_key', 'no_dsh', 'offline'}}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def ordinary(file, boundary):
    boundary = boundary.resolve()
    assert file.resolve().is_relative_to(boundary), str(file)
    current = file
    while current != boundary.parent:
        attributes = current.lstat()
        assert not current.is_symlink() and not current.is_junction(), str(current)
        assert not getattr(attributes, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT, str(current)
        current = current.parent
    assert stat.S_ISREG(file.lstat().st_mode), str(file)
    return file.read_bytes()

assert sha(DESCRIPTOR.read_bytes()) == PIN
assert not DEST.exists()
assert DEST.parent.resolve() == (ROOT / '.runtime/P02/preparation').resolve()
DEST.mkdir()
files = []
summaries = []
for run_name, expected_scenarios in SUITES.items():
    run = ROOT / '.runtime/P02/experiments/mature-integration' / run_name
    summary_bytes = ordinary(run / 'summary.json', run)
    assert json.loads(summary_bytes)['passed'] is True
    summaries.append({'path': str(run / 'summary.json'), 'bytes': len(summary_bytes), 'sha256': sha(summary_bytes)})
    scenarios = [p for p in (run / 'scenarios').iterdir() if p.is_dir()]
    assert {p.name for p in scenarios} == expected_scenarios
    selected = [run / name for name in ('registry-side-effects-pre.json', 'registry-side-effects-post.json', 'registry-side-effects-verification.json')]
    for scenario in sorted(scenarios):
        result = json.loads(ordinary(scenario / 'scenario-result.json', run))
        assert result['passed'] is True
        profile = scenario / 'profile'
        selected.extend(profile / name for name in ('main-process-runtime.json', 'registry-write-guard.jsonl', 'sqlite-cli-runtime-alias.json'))
        probes = sorted((profile / 'sqlite-runtime-probes').glob('*.json'))
        assert all(re.fullmatch(r'[1-9][0-9]*\.json', p.name) for p in probes)
        if scenario.name == 'disabled_native':
            assert not probes and result['sqlite_runtime_binding']['status'] == 'not_instantiated'
        else:
            assert probes and result['sqlite_runtime_binding']['status'] == 'verified_actual_cli_load'
        selected.extend(probes)
    for source in selected:
        data = ordinary(source, run)
        relative = pathlib.Path(run_name) / source.relative_to(run)
        target = DEST / relative
        assert target.resolve().is_relative_to(DEST.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            output.write(data)
        assert ordinary(target, DEST) == data
        files.append({'sourceAbs': str(source), 'stagingRelative': relative.as_posix(), 'bytes': len(data), 'sha256': sha(data)})

for item in files:
    source = pathlib.Path(item['sourceAbs'])
    suite = next(name for name in SUITES if name in source.parts)
    source_root = ROOT / '.runtime/P02/experiments/mature-integration' / suite
    original = ordinary(source, source_root)
    copied = ordinary(DEST / item['stagingRelative'], DEST)
    assert original == copied and len(copied) == item['bytes'] and sha(copied) == item['sha256']
assert sha(DESCRIPTOR.read_bytes()) == PIN
record = {'schema': 'p02-runtime-raw-staging/v1', 'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'stagingRoot': str(DEST), 'candidateDescriptorSha256': PIN, 'files': files, 'suiteSummaries': summaries,
          'fileCount': len(files), 'missing': [], 'rawBytesVerified': True,
          'command': {'argv': [sys.executable, str(pathlib.Path(__file__).resolve())], 'cwd': str(pathlib.Path.cwd()), 'exitCode': 0},
          'scriptSha256': sha(pathlib.Path(__file__).read_bytes()),
          'boundary': 'Only selected guard/alias/probe raw sidecars. No full profiles, databases, credentials, model calls or review decision.'}
index = DEST / 'index.json'
with index.open('xb') as output:
    output.write((json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
print(json.dumps({'stagingRoot': str(DEST), 'indexSha256': sha(index.read_bytes()), 'fileCount': len(files), 'missing': [], 'rawBytesVerified': True}))
