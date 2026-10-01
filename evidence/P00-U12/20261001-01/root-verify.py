"""Independent replay of the frozen local research ZIP; no paid calls."""
import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
ATTEMPT = pathlib.Path(__file__).resolve().parent
OUTPUT = ATTEMPT / 'root-review-final'
EXTERNAL = ATTEMPT / 'external-project'
PACKAGE = ROOT / 'docs/releases/0.0.0/candidate.zip'
EXPECTED = '1260c77c1f2740783e4c8725da99d021f05d9c4d9ee089d9740c2466fa5a76c9'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def bind(path):
    return {'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size, 'sha256': sha(path)}


def verify_bindings(value, case_dir, unpacked, records):
    if isinstance(value, dict):
        if isinstance(value.get('path'), str) and isinstance(value.get('sha256'), str):
            relative = pathlib.Path(value['path'])
            candidates = [relative] if relative.is_absolute() else [case_dir / relative, EXTERNAL / relative, unpacked / relative]
            found = next((p for p in candidates if p.is_file() and sha(p) == value['sha256']), None)
            assert found is not None, value['path']
            if 'bytes' in value:
                assert found.stat().st_size == value['bytes'], value['path']
            records.append({'path': str(found), 'sha256': value['sha256']})
        for child in value.values():
            verify_bindings(child, case_dir, unpacked, records)
    elif isinstance(value, list):
        for child in value:
            verify_bindings(child, case_dir, unpacked, records)


def main():
    assert sha(PACKAGE) == EXPECTED
    assert not OUTPUT.exists(), 'fresh output required'
    OUTPUT.mkdir()
    unpacked = OUTPUT / 'unpacked'
    unpacked.mkdir()
    with zipfile.ZipFile(PACKAGE) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == {'candidate.py', 'README.md', 'manifest.json'}
        assert len(archive.namelist()) == 3
        for name in archive.namelist():
            (unpacked / name).write_bytes(archive.read(name))
    before = {p.name: sha(p) for p in unpacked.iterdir()}
    assert before['candidate.py'] == '5ad30bbb50a638c238e43149c017051cc80d8774b2a4e1f8c20938d4bfed98a9'

    def run_case(case):
        case_dir = OUTPUT / case
        command = [sys.executable, str(unpacked / 'candidate.py'), '--case', case, '--external-root', str(EXTERNAL), '--output-dir', str(case_dir)]
        started = time.perf_counter()
        process = subprocess.run(command, cwd=unpacked, capture_output=True, timeout=180)
        stdout, stderr = OUTPUT / (case + '-stdout.bin'), OUTPUT / (case + '-stderr.bin')
        stdout.write_bytes(process.stdout)
        stderr.write_bytes(process.stderr)
        summary_path = case_dir / 'summary.json'
        summary = json.loads(summary_path.read_text(encoding='utf-8'))
        assert process.returncode == 0, (case, process.returncode)
        assert summary['status'] == 'passed_with_limits'
        assert summary['paid_model_calls'] == 0
        assert summary['global_credential_files_read'] is False
        assert summary['package_manifest_sha256'] == before['manifest.json']
        assert all(v is True or (isinstance(v, int) and v == 0) for v in summary['checks'].values())
        records = []
        verify_bindings(summary, case_dir, unpacked, records)
        if case == 'no-key':
            assert summary['local_zcode_mock']['real_model_path'] == 'NOT_RUN_NO_KEY'
        if case == 'no-dsh':
            assert summary['dsh']['exists'] is False
            assert summary['dsh']['launch_attempted'] is False
            assert not pathlib.Path(summary['dsh']['entry_override']).exists()
        if case == 'offline':
            assert summary['offline_fault']['result']['connected'] is False
            assert summary['offline_fault']['result']['host'] == '127.0.0.1'
            assert summary['local_diagnostic_state']['readback_matches'] is True
            state = json.loads((case_dir / summary['local_diagnostic_state']['path']).read_text())
            assert state['provider_result'] is None and state['local_result'] == 'mock diagnostic only'
        if case == 'smoke':
            smoke_path = EXTERNAL / summary['u11_summary']['path']
            smoke = json.loads(smoke_path.read_text())
            assert smoke['paidModelCalls'] == 0 and smoke['failures'] == []
            commands = {k: v for k, v in smoke['commands'].items() if k != 'assertions'}
            assert len(commands) == 6 and all(v['exitCode'] == 0 for v in commands.values())
            assert len(smoke['commands']['assertions']) == 19
            assert all(v['passed'] is True for v in smoke['commands']['assertions'].values())
            verify_bindings(smoke, case_dir, unpacked, records)
            job_path = smoke_path.parent / 'outputs/u09-native-sdk-job/summary.json'
            job = json.loads(job_path.read_text())
            assert job['assigned_before_import'] is True
            assert job['driver_exit_code'] == 0 and job['members_before_job_close'] == []
            records.append({'path': str(job_path), 'sha256': sha(job_path)})
        record = {'command': command, 'cwd': str(unpacked), 'exit_code': process.returncode, 'elapsed_seconds': round(time.perf_counter() - started, 3), 'status': summary['status'], 'paid_model_calls': 0, 'summary': bind(summary_path), 'stdout': bind(stdout), 'stderr': bind(stderr), 'verified_bindings': records}
        save(OUTPUT / (case + '-execution.json'), record)
        print(case, process.returncode, summary['status'], flush=True)
        return case, record

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        cases = dict(executor.map(run_case, ['smoke', 'no-key', 'no-dsh', 'offline']))
    after = {p.name: sha(p) for p in unpacked.iterdir()}
    assert before == after
    pins_after = []
    for path in ['.runtime/P00/zcode/source', '.runtime/P00/dsh/source', 'references/herta-4623df12']:
        checkout = EXTERNAL / path
        commit = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
        result = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True, text=True)
        assert result.returncode == 0 and result.stdout == ''
        pins_after.append({'path': path, 'commit': commit, 'clean': True})
    execution = {'status': 'passed_with_limits', 'zip': bind(PACKAGE), 'driver': bind(pathlib.Path(__file__).resolve()), 'unpacked_bindings': before, 'after': after, 'parallel_independent_cases': True, 'cases': cases, 'source_pins_after': pins_after, 'paid_model_calls': 0, 'limits': ['local P00 research ZIP with fixed external dependencies', 'synthetic loopback cases, not product UI/installer/provider fallback', 'source paths used read-only by convention, not an ACL/security sandbox']}
    save(OUTPUT / 'execution.json', execution)
    print('ROOT_FINAL_CANDIDATE_PASS', flush=True)


if __name__ == '__main__':
    main()
