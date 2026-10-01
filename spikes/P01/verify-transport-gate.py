"""Prove pending transport refuses real execution before credential/network access."""
import builtins
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[2]
SPIKE = ROOT / 'spikes/P01'
OUT = ROOT / 'evidence/P01-U02/20261001-01'
protected = {str(Path(p)).lower() for p in (
    r'C:\Users\liyi\.dsh\settings.yaml', r'C:\Users\liyi\.dsh\.credentials.yaml',
    r'C:\Users\liyi\.zcode\v2\provider_config.json')}
attempts = {'credential_file_open': 0, 'http_send': 0, 'socket_connect': 0, 'native_runtime_launch': 0}
path_open, builtin_open, process_run, read_text = Path.open, builtins.open, subprocess.run, Path.read_text


def reject_credential(path):
    if str(Path(path)).lower() in protected:
        attempts['credential_file_open'] += 1
        raise RuntimeError('Guard proof attempted a protected credential/config read')


def checked_path_open(path, *args, **kwargs):
    reject_credential(path)
    return path_open(path, *args, **kwargs)


def checked_builtin_open(file, *args, **kwargs):
    if isinstance(file, (str, bytes, Path)):
        reject_credential(file)
    return builtin_open(file, *args, **kwargs)


def pending_decision_read(path, *args, **kwargs):
    if path.resolve() == (ROOT / 'evidence/P01/transport-decision.json').resolve():
        return json.dumps({'status': 'pending'})
    return read_text(path, *args, **kwargs)


def checked_process_run(command, *args, **kwargs):
    if not isinstance(command, (list, tuple)) or command[0] != 'git':
        attempts['native_runtime_launch'] += 1
        raise RuntimeError('Guard proof attempted to launch a runtime')
    return process_run(command, *args, **kwargs)


def deny_http(*args, **kwargs):
    attempts['http_send'] += 1
    raise RuntimeError('Guard proof attempted an HTTP request')


def deny_socket(*args, **kwargs):
    attempts['socket_connect'] += 1
    raise RuntimeError('Guard proof attempted a socket connection')


def main():
    decision = ROOT / 'evidence/P01/transport-decision.json'
    ledger = ROOT / 'evidence/P01/model-calls.jsonl'
    before = ledger.read_bytes() if ledger.exists() else None
    module_spec = importlib.util.spec_from_file_location('p01_probe', SPIKE / 'probe.py')
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    rejected = False
    with patch.object(Path, 'read_text', pending_decision_read), patch.object(Path, 'open', checked_path_open), patch.object(builtins, 'open', checked_builtin_open), \
         patch.object(subprocess, 'run', checked_process_run), patch.object(httpx.Client, 'send', deny_http), \
         patch.object(socket.socket, 'connect', deny_socket):
        try:
            module.run('real', module.MODELS[0])
        except PermissionError as error:
            if str(error) != 'Model transport choice is pending; no credentials may be loaded or sent':
                raise
            rejected = True
    if not rejected or any(attempts.values()):
        raise RuntimeError('Pending transport failed to reject before protected activity')
    if before != (ledger.read_bytes() if ledger.exists() else None):
        raise RuntimeError('Paid request ledger changed during the guard proof')
    bindings = []
    for path in [SPIKE / 'probe.py', SPIKE / 'run-no-key.py', Path(__file__).resolve(), decision, ROOT / 'evidence/P01/authorization.json']:
        bindings.append({'path': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size,
                         'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    result = {'status': 'pass', 'python_optimization': not __debug__, 'scenario': 'injected pending transport blocks real generation before credentials/runtime/network; actual decision file unmodified',
              'attempts': attempts, 'paid_request_ledger_unchanged': True,
              'actual_model_calls': 0, 'not_a_real_model_route_pass': True, 'artifacts': bindings}
    (OUT / ('transport-gate-verification-optimized.json' if not __debug__ else 'transport-gate-verification.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'pass', 'attempts': attempts, 'actual_model_calls': 0}))


if __name__ == '__main__':
    main()
