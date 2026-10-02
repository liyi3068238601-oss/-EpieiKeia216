"""Actual Desktop UI matrix against an owned loopback-only model relay."""

from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import runpy
import socket
import subprocess
import threading
import time
import uuid


REPO = Path(__file__).resolve().parents[3]
ROOT = Path(r"E:\Xiadie\Xiadie")
SOURCE = ROOT / ".runtime/P01/desktop-source"
NODE = ROOT / ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe"
PRODUCTION_GLOBALS_HELPER = ROOT / "spikes/P01/run-no-key.py"
PRODUCTION_PROVIDER_CONFIG = Path(r"C:\Users\liyi\.zcode\v2\provider_config.json")
MODEL_CALLS_LEDGER = ROOT / "evidence/P01/model-calls.jsonl"
PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
HERE = Path(__file__).resolve().parent
PROFILE_BRIDGE = ROOT / "tests/evals/persona/profile-bridge.mjs"
SEED_HISTORY = REPO / "packages/config/test/seed-history.mjs"
UI_DRIVER = HERE / "desktop-ui.mjs"
NETWORK_GUARD = HERE / "electron-network-guard.cjs"
SYNTHETIC_KEY = "p01-u09-loopback-only"
FULL_SCENARIOS = ("success", "read_success", "read_failure", "cancel_recovery", "disabled_native", "pro_denied")
DEGRADATION_SCENARIOS = ("no_key", "no_dsh", "offline")
EXPECTED_REPLIES = {
    "success": "你好，我是遐蝶。我们可以慢慢聊。",
    "read_success": "读到的标记是 orchid-42。",
    "read_failure": "missing.txt 不存在，这一步未完成，我没有读到文件内容。",
    "cancel_recovery": "已恢复。",
    "disabled_native": "原生模型路径已通过本地测试。",
    "no_dsh": "本地运行正常，没有启动 DSH。",
}
ALLOWED_DESCRIPTOR_KEYS = {
    "schemaVersion", "sourceCommit", "sourceRoot", "repositoryCommit", "assemblyRoot",
    "desktopPath", "cliEntry", "cwd", "electronPath", "playwrightPath", "nodePath",
    "factoryEntry", "factory", "recipe", "cli", "resourcesRoot", "gateEnv", "gateDefault",
    "candidateModel", "deniedModel", "protocolPatch", "providerConfig", "invocationContext",
    "invocationContextModuleCount", "nodeVersion", "artifacts", "scope", "repositoryInputs",
}


class HarnessError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def execution_bindings() -> dict:
    commit = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=False)
    if commit.returncode != 0:
        raise HarnessError("execution_commit_unavailable")
    files = {
        "desktop_runner": Path(__file__).resolve(),
        "desktop_ui": UI_DRIVER,
        "electron_network_guard": NETWORK_GUARD,
        "profile_bridge": PROFILE_BRIDGE,
        "seed_history": SEED_HISTORY,
    }
    fingerprints = []
    for label, path in files.items():
        if not path.is_file():
            raise HarnessError(f"execution_binding_{label}_missing")
        fingerprints.append({"label": label, "path": str(path.resolve()),
                             "bytes": path.stat().st_size, "sha256": sha256(path)})
    return {"repository": str(REPO), "commit": commit.stdout.strip(), "files": fingerprints}


def production_file_fingerprint(path: Path, *, count_lines: bool = False) -> dict:
    if not path.is_file():
        return {"path": str(path), "exists": False, "bytes": None, "sha256": None,
                **({"line_count": None} if count_lines else {})}
    digest = hashlib.sha256()
    byte_count = 0
    line_count = 0
    last_byte = None
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            byte_count += len(chunk)
            if count_lines:
                line_count += chunk.count(b"\n")
                last_byte = chunk[-1]
    if count_lines and byte_count and last_byte != 0x0A:
        line_count += 1
    return {"path": str(path), "exists": True, "bytes": byte_count, "sha256": digest.hexdigest(),
            **({"line_count": line_count} if count_lines else {})}


def production_snapshot() -> dict:
    if not PRODUCTION_GLOBALS_HELPER.is_file():
        raise HarnessError("production_snapshot_helper_missing")
    helper = runpy.run_path(str(PRODUCTION_GLOBALS_HELPER))
    globals_snapshot = helper.get("globals_snapshot")
    if not callable(globals_snapshot):
        raise HarnessError("production_snapshot_helper_invalid")
    # The imported helper reports only existence and SHA-256 for fixed legacy paths.
    # It never parses or persists their contents.
    return {
        "global_file_hashes": globals_snapshot(),
        "official_provider_config": production_file_fingerprint(PRODUCTION_PROVIDER_CONFIG),
        "model_call_ledger": production_file_fingerprint(MODEL_CALLS_LEDGER, count_lines=True),
    }


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def path_is_inside(root: Path, path: Path) -> bool:
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
        return True
    except (OSError, ValueError):
        return False


def safe_system_environment() -> dict[str, str]:
    env = {
        key.upper(): value
        for key, value in os.environ.items()
        if key.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"}
    }
    if not env.get("SYSTEMROOT"):
        env["SYSTEMROOT"] = r"C:\Windows"
    if not env.get("WINDIR"):
        env["WINDIR"] = env["SYSTEMROOT"]
    env["PATH"] = os.pathsep.join(
        [str(NODE.parent), r"C:\Program Files\Git\cmd", r"C:\Windows\System32"]
    )
    return env


def run_logged(argv: list[str], cwd: Path, env: dict[str, str], output: Path, label: str, timeout: int) -> dict:
    record = {"argv": argv, "cwd": str(cwd), "timeout_seconds": timeout}
    try:
        result = subprocess.run(
            argv,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            shell=False,
        )
        record.update({
            "exit_code": result.returncode,
            "stdout_bytes": len(result.stdout),
            "stdout_sha256": hashlib.sha256(result.stdout).hexdigest(),
            "stderr_bytes": len(result.stderr),
            "stderr_sha256": hashlib.sha256(result.stderr).hexdigest(),
        })
        (output / f"{label}.stdout.bin").write_bytes(result.stdout)
        (output / f"{label}.stderr.bin").write_bytes(result.stderr)
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or b""
        stderr = error.stderr or b""
        record.update({"exit_code": None, "timed_out": True,
                       "stdout_bytes": len(stdout), "stdout_sha256": hashlib.sha256(stdout).hexdigest(),
                       "stderr_bytes": len(stderr), "stderr_sha256": hashlib.sha256(stderr).hexdigest()})
        (output / f"{label}.stdout.bin").write_bytes(stdout)
        (output / f"{label}.stderr.bin").write_bytes(stderr)
    write_json(output / f"{label}.command.json", record)
    return record


def run_ui_driver(spec_path: Path, scenario_output: Path, env: dict[str, str], timeout: int = 240) -> dict:
    argv = [str(NODE), str(UI_DRIVER), str(spec_path)]
    record = {"argv": argv, "cwd": str(REPO), "timeout_seconds": timeout}
    process = subprocess.Popen(argv, cwd=str(REPO), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
    timed_out = False
    forced_electron_pids: list[int] = []
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        (scenario_output / "cancel.request").write_text("timeout cleanup requested\n", encoding="utf-8")
        try:
            stdout, stderr = process.communicate(timeout=35)
        except subprocess.TimeoutExpired:
            pid_file = scenario_output / "desktop-main.pid"
            if pid_file.is_file():
                try:
                    electron_pid = int(pid_file.read_text(encoding="utf-8").strip())
                except ValueError:
                    electron_pid = 0
                if electron_pid > 0:
                    kill_path = Path(env["SYSTEMROOT"]) / "System32/taskkill.exe"
                    killed = subprocess.run([str(kill_path), "/PID", str(electron_pid), "/T", "/F"],
                                            env=env, capture_output=True, timeout=15, check=False)
                    forced_electron_pids.append(electron_pid)
                    (scenario_output / "electron-timeout-cleanup.stdout.bin").write_bytes(killed.stdout)
                    (scenario_output / "electron-timeout-cleanup.stderr.bin").write_bytes(killed.stderr)
            process.terminate()
            stdout, stderr = process.communicate(timeout=15)
    (scenario_output / "desktop-ui.stdout.bin").write_bytes(stdout)
    (scenario_output / "desktop-ui.stderr.bin").write_bytes(stderr)
    record.update({"exit_code": process.returncode, "timed_out": timed_out,
                   "forced_electron_root_pids": forced_electron_pids,
                   "stdout_bytes": len(stdout), "stdout_sha256": hashlib.sha256(stdout).hexdigest(),
                   "stderr_bytes": len(stderr), "stderr_sha256": hashlib.sha256(stderr).hexdigest()})
    write_json(scenario_output / "desktop-ui.command.json", record)
    return record


def same_path(actual: object, expected: Path, label: str, *, must_exist: bool = True) -> Path:
    if not isinstance(actual, str) or not Path(actual).is_absolute():
        raise HarnessError(f"descriptor_{label}_must_be_absolute")
    actual_path = Path(actual)
    try:
        resolved = actual_path.resolve(strict=must_exist)
        expected_resolved = expected.resolve(strict=must_exist)
    except OSError as error:
        raise HarnessError(f"descriptor_{label}_missing") from error
    if os.path.normcase(str(resolved)) != os.path.normcase(str(expected_resolved)):
        raise HarnessError(f"descriptor_{label}_mismatch")
    return resolved


def verify_candidate(candidate_arg: str) -> dict:
    candidate = Path(candidate_arg)
    if not candidate.is_absolute():
        raise HarnessError("candidate_must_be_absolute")
    try:
        resolved_candidate = candidate.resolve(strict=True)
    except OSError as error:
        raise HarnessError("candidate_missing") from error
    if not resolved_candidate.is_dir() or candidate.is_symlink():
        raise HarnessError("candidate_must_be_physical_directory")
    descriptor_path = resolved_candidate / "candidate-descriptor.json"
    descriptor = read_json(descriptor_path)
    if not isinstance(descriptor, dict) or set(descriptor) - ALLOWED_DESCRIPTOR_KEYS:
        raise HarnessError("descriptor_schema_invalid")
    if descriptor.get("schemaVersion") != 1 or descriptor.get("sourceCommit") != PIN:
        raise HarnessError("candidate_source_pin_mismatch")
    if descriptor.get("gateEnv") != "P01_U10_GATE_MODE":
        raise HarnessError("candidate_factory_contract_mismatch")
    if descriptor.get("gateDefault") != "enabled" or descriptor.get("candidateModel") != "deepseek-flash":
        raise HarnessError("candidate_qualification_contract_mismatch")
    if descriptor.get("deniedModel") != "deepseek-v4-pro":
        raise HarnessError("candidate_denied_model_contract_mismatch")

    expected_paths = {
        "assemblyRoot": resolved_candidate,
        "desktopPath": resolved_candidate / "packages/desktop",
        "cliEntry": resolved_candidate / "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        "cwd": resolved_candidate,
        "electronPath": ROOT / ".runtime/P01/desktop-source/node_modules/electron/dist/electron.exe",
        "playwrightPath": ROOT / ".runtime/P01/desktop-source/node_modules/playwright-core/index.js",
        "sourceRoot": ROOT / ".runtime/P01/desktop-source",
        "nodePath": NODE,
    }
    resolved = {
        name: str(same_path(descriptor.get(name), expected, name))
        for name, expected in expected_paths.items()
    }
    resolved["nodePath"] = str(same_path(descriptor.get("nodePath"), NODE, "nodePath"))
    if descriptor.get("nodeVersion") != "v24.14.0" or descriptor.get("invocationContextModuleCount") != 1:
        raise HarnessError("candidate_runtime_contract_mismatch")
    source_metadata = {}
    for label in ("factory", "recipe", "cli", "invocationContext"):
        item = descriptor.get(label)
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise HarnessError(f"descriptor_{label}_invalid")
        item_path = Path(item["path"])
        if not item_path.is_absolute() or not item_path.is_file():
            raise HarnessError(f"descriptor_{label}_missing")
        current_match = item.get("bytes") == item_path.stat().st_size and item.get("sha256") == sha256(item_path)
        if not current_match:
            raise HarnessError(f"descriptor_{label}_hash_mismatch")
        source_metadata[f"{label}_matches_current_file"] = current_match
    if Path(descriptor["factoryEntry"]).resolve(strict=True) != Path(descriptor["factory"]["path"]).resolve(strict=True):
        raise HarnessError("candidate_factory_entry_mismatch")
    repository_root_result = subprocess.run(
        ["git", "-C", str(Path(descriptor["factory"]["path"]).parent), "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=False,
    )
    if repository_root_result.returncode != 0:
        raise HarnessError("candidate_repository_root_unavailable")
    repository_root = Path(repository_root_result.stdout.strip()).resolve(strict=True)
    repository_commit = subprocess.run(["git", "-C", str(repository_root), "rev-parse", "HEAD"],
                                       capture_output=True, text=True, check=False)
    repository_status = subprocess.run(["git", "-C", str(repository_root), "status", "--porcelain"],
                                       capture_output=True, text=True, check=False)
    build_commit = descriptor.get("repositoryCommit")
    if not isinstance(build_commit, str) or not re.fullmatch(r"[a-f0-9]{40}", build_commit):
        raise HarnessError("candidate_repository_commit_invalid")
    ancestry = subprocess.run(["git", "-C", str(repository_root), "merge-base", "--is-ancestor", build_commit, "HEAD"],
                              capture_output=True, check=False)
    if (repository_commit.returncode != 0 or repository_status.returncode != 0 or
            ancestry.returncode != 0 or repository_status.stdout.strip()):
        raise HarnessError("candidate_repository_not_clean_and_pinned")
    # Review/evidence commits may follow a build. Its material inputs still have
    # to equal the original committed blobs and their descriptor hashes.
    source_metadata["build_repository_commit"] = build_commit
    source_metadata["verification_repository_commit"] = repository_commit.stdout.strip()
    repository_inputs = descriptor.get("repositoryInputs")
    if not isinstance(repository_inputs, list) or not repository_inputs:
        raise HarnessError("descriptor_repository_inputs_invalid")
    verified_inputs = []
    for item in repository_inputs:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise HarnessError("descriptor_repository_input_invalid")
        rel = Path(item["path"])
        if rel.is_absolute() or ".." in rel.parts:
            raise HarnessError("descriptor_repository_input_path_invalid")
        item_path = (repository_root / rel).resolve(strict=True)
        if (not path_is_inside(repository_root, item_path) or not item_path.is_file()
                or item.get("bytes") != item_path.stat().st_size or item.get("sha256") != sha256(item_path)):
            raise HarnessError("candidate_repository_input_mismatch")
        blob = subprocess.run(["git", "-C", str(repository_root), "show", f"{build_commit}:{rel.as_posix()}"],
                              capture_output=True, check=False)
        if blob.returncode != 0 or blob.stdout != item_path.read_bytes():
            raise HarnessError("candidate_repository_input_commit_mismatch")
        verified_inputs.append(item["path"])
    protocol_patch = descriptor.get("protocolPatch")
    if not isinstance(protocol_patch, dict) or not isinstance(protocol_patch.get("file"), str):
        raise HarnessError("descriptor_protocol_patch_invalid")
    patch_path = Path(protocol_patch["file"])
    if (not patch_path.is_absolute() or not patch_path.is_file()
            or sha256(patch_path) != protocol_patch.get("originalSha256")):
        raise HarnessError("candidate_protocol_source_mismatch")
    provider_metadata = descriptor.get("providerConfig")
    if isinstance(provider_metadata, dict):
        provider_source = provider_metadata.get("source")
        if not isinstance(provider_source, dict) or not isinstance(provider_source.get("path"), str):
            raise HarnessError("descriptor_provider_source_invalid")
        provider_path = Path(provider_source["path"])
        if (not provider_path.is_absolute() or not provider_path.is_file()
                or provider_source.get("sha256") != sha256(provider_path)):
            raise HarnessError("candidate_provider_source_mismatch")
    else:
        bundled_provider = resolved_candidate / "apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json"
        pinned_provider = subprocess.run(
            ["git", "-C", str(SOURCE), "show", f"{PIN}:config/provider/zcode-builtin.json"],
            capture_output=True, check=False,
        )
        if (not bundled_provider.is_file() or pinned_provider.returncode != 0
                or hashlib.sha256(bundled_provider.read_bytes()).digest() != hashlib.sha256(pinned_provider.stdout).digest()):
            raise HarnessError("candidate_provider_source_mismatch")
    files = [
        Path(resolved["desktopPath"]) / "out/main/index.js",
        Path(resolved["desktopPath"]) / "out/host/index.js",
        Path(resolved["desktopPath"]) / "out/preload/index.cjs",
        Path(resolved["desktopPath"]) / "out/renderer/index.html",
        Path(resolved["cliEntry"]),
    ]
    if any(not path.is_file() for path in files):
        raise HarnessError("candidate_desktop_build_incomplete")

    artifacts = descriptor.get("artifacts", [])
    if not isinstance(artifacts, list):
        raise HarnessError("descriptor_artifacts_invalid")
    for artifact in artifacts:
        if not isinstance(artifact, dict) or not isinstance(artifact.get("path"), str):
            raise HarnessError("descriptor_artifact_invalid")
        rel = Path(artifact["path"])
        if rel.is_absolute() or ".." in rel.parts:
            raise HarnessError("descriptor_artifact_path_invalid")
        artifact_path = (resolved_candidate / rel).resolve(strict=True)
        if not path_is_inside(resolved_candidate, artifact_path) or not artifact_path.is_file():
            raise HarnessError("descriptor_artifact_outside_candidate")
        if artifact.get("bytes") != artifact_path.stat().st_size or artifact.get("sha256") != sha256(artifact_path):
            raise HarnessError("candidate_artifact_hash_mismatch")

    cli_metadata = descriptor.get("cli")
    if cli_metadata.get("path") != resolved["cliEntry"] or cli_metadata.get("sha256") != sha256(Path(resolved["cliEntry"])):
        raise HarnessError("candidate_cli_hash_mismatch")
    return {
        "descriptor_path": str(descriptor_path),
        "descriptor_sha256": sha256(descriptor_path),
        "descriptor": {key: descriptor[key] for key in sorted(descriptor) if key not in {"artifacts"}},
        "resolved_paths": resolved,
        "repository_root": str(repository_root),
        "verified_artifacts": len(artifacts),
        "verified_repository_inputs": len(verified_inputs),
        "external_source_metadata": source_metadata,
    }


def verify_pinned_source() -> dict:
    if not NODE.is_file() or not PROFILE_BRIDGE.is_file() or not UI_DRIVER.is_file() or not NETWORK_GUARD.is_file():
        raise HarnessError("fixed_u10_toolchain_or_bridge_missing")
    commit = subprocess.run(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    status = subprocess.run(["git", "-C", str(SOURCE), "status", "--porcelain"], capture_output=True, text=True, check=False)
    if commit.returncode or status.returncode or commit.stdout.strip() != PIN or status.stdout.strip():
        raise HarnessError("fixed_native_source_not_clean_and_pinned")
    return {"path": str(SOURCE), "commit": commit.stdout.strip(), "clean": True}


def output_root(args_output: str | None) -> Path:
    if args_output is not None:
        path = Path(args_output)
        if not path.is_absolute():
            raise HarnessError("output_must_be_absolute")
        resolved = path.resolve(strict=False)
        if resolved.exists():
            raise HarnessError("output_must_not_exist")
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.mkdir()
        return resolved
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    parent = REPO / "evidence/P01-U10/runs"
    parent.mkdir(parents=True, exist_ok=True)
    for _ in range(10):
        candidate = parent / f"{stamp}-{uuid.uuid4().hex[:10]}"
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    raise HarnessError("could_not_allocate_unique_output")


def native_provider_config(origin: str, *, no_key: bool, include_pro: bool) -> dict:
    if no_key:
        return {"schemaVersion": 1, "config": {
            "providerConfigRules": {"providerRules": []},
            "modelConfigRules": {"providerModelRules": [], "manualProviderModelRules": []},
        }}
    model_ids = ["deepseek-flash", "deepseek-v4-pro"] if include_pro else ["deepseek-flash"]
    provider = {
        "providerId": "p01-u10-loopback",
        "providerName": "P01 U10 owned loopback mock",
        "enabled": True,
        "config": {
            "group": "standard-personal",
            "api": {"type": "openai-chat-completions", "baseUrl": f"{origin}/v1"},
            "access": {"type": "api-key", "apiKey": SYNTHETIC_KEY},
            "personalModelIds": model_ids,
        },
    }
    model_rules = []
    for model_id in model_ids:
        model_rules.append({
            "providerId": "p01-u10-loopback",
            "modelId": model_id,
            "config": {
                "properties": {"supportsToolCall": True},
                "optionSpecs": {
                    "reasoningLevel": {"values": ["disabled"], "map": '{"thinking":{"type":"disabled"}}'},
                    "maxOutputTokens": {"max": 1024, "map": '{"max_tokens":maxOutputTokens}'},
                },
            },
        })
    return {"schemaVersion": 1, "config": {
        "providerOrder": ["p01-u10-loopback"],
        "providerConfigRules": {"providerRules": [provider]},
        "modelConfigRules": {"providerModelRules": model_rules, "manualProviderModelRules": []},
        "defaultModelSelection": {
            "providerId": "p01-u10-loopback",
            "modelId": "deepseek-flash",
            "options": {"reasoningLevel": "disabled"},
        },
    }}


def seed_workspace(profile: Path, scenario_output: Path, *, with_history: bool, env: dict[str, str]) -> tuple[Path, list[str] | None]:
    workspace = profile / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "readme.txt").write_text("P01_ONLY_READ_VALUE=orchid-42\n", encoding="utf-8", newline="\n")
    (workspace / "AGENTS.md").write_text(
        "Use Read only on the exact named fixture file in this workspace. Do not read other files.\n",
        encoding="utf-8", newline="\n",
    )
    git_init = subprocess.run(["git", "init", "--quiet", str(workspace)], env=env, capture_output=True, check=False)
    if git_init.returncode:
        raise HarnessError("owned_workspace_git_init_failed")
    markers = None
    if with_history:
        session_id = str(uuid.uuid4())
        markers = [f"P01 U10 synthetic history {session_id[:8]}", f"P01 U10 persisted assistant {session_id[:8]}"]
        history_spec = {
            "source": str(SOURCE),
            "workspace": str(workspace),
            "profile_root": str(profile),
            "session_id": session_id,
            "user_marker": markers[0],
            "assistant_marker": markers[1],
            "out": str(scenario_output),
        }
        spec_path = scenario_output / "history-seed.spec.json"
        write_json(spec_path, history_spec)
        command = run_logged([str(NODE), str(SEED_HISTORY), str(spec_path)], REPO, env, scenario_output, "history-seed", 60)
        if command.get("exit_code") != 0:
            raise HarnessError("native_history_seed_failed")
    return workspace, markers


class MockRelay:
    """One per UI scenario; only a dynamic 127.0.0.1 listener exists."""

    def __init__(self, scenario_id: str, output: Path, workspace: Path, expected_post_count: int, offline: bool = False):
        self.scenario_id = scenario_id
        self.output = output
        self.workspace = workspace
        self.expected_post_count = expected_post_count
        self.offline = offline
        self.records: list[dict] = []
        self.lock = threading.Lock()
        self.server: ThreadingHTTPServer | None = None

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def send_body(self, status: int, content_type: str, payload: bytes):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                if self.path == "/v1/models":
                    payload = {"object": "list", "data": [
                        {"id": "deepseek-flash", "object": "model", "owned_by": "p01-u10"},
                        {"id": "deepseek-v4-pro", "object": "model", "owned_by": "p01-u10"},
                    ]}
                    self.send_body(200, "application/json", json.dumps(payload).encode())
                else:
                    self.send_body(404, "application/json", b'{"error":{"message":"P01 route denied"}}')

            def do_POST(self):
                if self.path != "/v1/chat/completions":
                    self.send_body(404, "application/json", b'{"error":{"message":"P01 route denied"}}')
                    return
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > 1024 * 1024:
                        raise HarnessError("request_size_invalid")
                    body_bytes = self.rfile.read(length)
                    body = json.loads(body_bytes)
                    if not isinstance(body, dict):
                        raise HarnessError("request_body_invalid")
                except Exception:
                    with outer.lock:
                        outer.records.append({"request_index": len(outer.records) + 1, "accepted": False,
                                              "reason": "invalid_request", "status": 400})
                    self.send_body(400, "application/json", b'{"error":{"message":"P01 request denied"}}')
                    return

                with outer.lock:
                    index = len(outer.records) + 1
                    record = {
                        "request_index": index,
                        "accepted": False,
                        "request_sha256": hashlib.sha256(body_bytes).hexdigest(),
                        "request_bytes": len(body_bytes),
                        "model": body.get("model") if isinstance(body.get("model"), str) else None,
                        "stream": body.get("stream") is True,
                        "auth_present": bool(self.headers.get("Authorization")),
                        "synthetic_auth_only": self.headers.get("Authorization") == f"Bearer {SYNTHETIC_KEY}",
                        "messages_count": len(body.get("messages", [])) if isinstance(body.get("messages"), list) else None,
                        "tool_names": sorted({
                            tool.get("function", {}).get("name")
                            for tool in body.get("tools", [])
                            if isinstance(tool, dict) and isinstance(tool.get("function"), dict)
                            and isinstance(tool["function"].get("name"), str)
                        }) if isinstance(body.get("tools"), list) else [],
                        "assistant_tool_call_ids": [],
                        "tool_result_ids": [],
                        "upstream_attempted": False,
                    }
                    outer.records.append(record)

                try:
                    self.validate_request(body, record, index)
                    if outer.offline:
                        record.update({"accepted": True, "status": 503, "offline_reject": True})
                        self.send_body(503, "application/json", b'{"error":{"message":"P01 offline mock refusal"}}')
                        return
                    if outer.scenario_id == "no_key":
                        raise HarnessError("no_key_request_must_be_refused_before_relay")
                    if outer.scenario_id == "pro_denied":
                        raise HarnessError("unqualified_pro_request_must_be_refused_before_relay")
                    record["accepted"] = True
                    record["status"] = 200
                    self.send_sse(index)
                except (BrokenPipeError, ConnectionResetError):
                    record["client_cancelled"] = True
                    record["accepted"] = True
                except HarnessError as error:
                    record.update({"accepted": False, "status": 400, "reason": error.args[0] if error.args and re.fullmatch(r"[a-z0-9_]+", str(error.args[0])) else "request_policy_denied"})
                    self.send_body(400, "application/json", b'{"error":{"message":"P01 evaluation stopped"}}')
                except Exception:
                    record.update({"accepted": False, "status": 500, "reason": "relay_internal_failure"})
                    self.send_body(500, "application/json", b'{"error":{"message":"P01 relay failure"}}')

            def validate_request(self, body: dict, record: dict, index: int):
                if body.get("model") != "deepseek-flash" or body.get("stream") is not True:
                    raise HarnessError("model_or_stream_mismatch")
                if SYNTHETIC_KEY.encode() in json.dumps(body, ensure_ascii=False).encode():
                    raise HarnessError("synthetic_key_in_request_body")
                if outer.scenario_id not in {"no_key", "pro_denied"} and not record["synthetic_auth_only"]:
                    raise HarnessError("synthetic_auth_header_mismatch")
                messages = body.get("messages")
                if not isinstance(messages, list):
                    raise HarnessError("messages_missing")
                tool_calls = []
                tool_results = []
                for message in messages:
                    if not isinstance(message, dict):
                        continue
                    if message.get("role") == "assistant" and isinstance(message.get("tool_calls"), list):
                        for call in message["tool_calls"]:
                            if not isinstance(call, dict):
                                continue
                            function = call.get("function") if isinstance(call.get("function"), dict) else {}
                            tool_calls.append({"id": call.get("id"), "name": function.get("name"), "arguments": function.get("arguments")})
                    if message.get("role") == "tool":
                        tool_results.append({"id": message.get("tool_call_id"), "content": message.get("content")})
                record["assistant_tool_call_ids"] = [call["id"] for call in tool_calls if isinstance(call.get("id"), str)]
                record["tool_result_ids"] = [item["id"] for item in tool_results if isinstance(item.get("id"), str)]
                if outer.scenario_id in {"read_success", "read_failure"} and index == 1:
                    if "Read" not in record["tool_names"]:
                        raise HarnessError("read_tool_not_offered")
                    if tool_calls or tool_results:
                        raise HarnessError("unexpected_prior_tool_transcript")
                elif outer.scenario_id in {"read_success", "read_failure"} and index == 2:
                    matching = [call for call in tool_calls if call.get("name") == "Read"]
                    if len(matching) != 1 or len(tool_results) != 1:
                        raise HarnessError("read_continuation_not_correlated")
                    call = matching[0]
                    if not isinstance(call.get("id"), str) or call["id"] != tool_results[0].get("id"):
                        raise HarnessError("read_tool_call_id_mismatch")
                    try:
                        args = json.loads(call.get("arguments", ""))
                    except (TypeError, json.JSONDecodeError) as error:
                        raise HarnessError("read_arguments_invalid") from error
                    expected_name = "readme.txt" if outer.scenario_id == "read_success" else "missing.txt"
                    if not isinstance(args, dict) or args.get("file_path") != str(outer.workspace / expected_name):
                        raise HarnessError("read_target_mismatch")
                    record["correlated_tool_call_id"] = call["id"]
                    record["tool_result_sha256"] = hashlib.sha256(str(tool_results[0].get("content", "")).encode()).hexdigest()
                    record["tool_result_success_shape"] = bool(tool_results[0].get("content"))
                if index > outer.expected_post_count:
                    raise HarnessError("unexpected_extra_model_request")

            def frame(self, delta: dict, finish_reason: str | None = None) -> bytes:
                frame = {"id": f"p01-u10-{outer.scenario_id}", "object": "chat.completion.chunk",
                         "created": 1, "model": "deepseek-flash",
                         "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
                return ("data: " + json.dumps(frame, ensure_ascii=False) + "\n\n").encode("utf-8")

            def send_sse(self, index: int):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                if outer.scenario_id in {"read_success", "read_failure"} and index == 1:
                    call_id = f"p01-u10-{outer.scenario_id}-read"
                    target = "readme.txt" if outer.scenario_id == "read_success" else "missing.txt"
                    arguments = json.dumps({"file_path": str(outer.workspace / target)})
                    first = {"index": 0, "id": call_id, "type": "function",
                             "function": {"name": "Read", "arguments": arguments}}
                    self.wfile.write(self.frame({"role": "assistant", "tool_calls": [first]}))
                    self.wfile.flush()
                    self.wfile.write(self.frame({}, "tool_calls"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    record = outer.records[index - 1]
                    record["tool_call_id"] = call_id
                    record["tool_target"] = target
                    return
                if outer.scenario_id == "cancel_recovery" and index == 1:
                    self.wfile.write(self.frame({"role": "assistant", "content": "这是一条尚未完成的本地测试回复"}))
                    self.wfile.flush()
                    for _ in range(120):
                        time.sleep(0.25)
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    record = outer.records[index - 1]
                    record["stream_completed_without_cancel"] = True
                    self.wfile.write(self.frame({}, "stop"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                    return
                text = {
                    "success": "你好，我是遐蝶。我们可以慢慢聊。",
                    "read_success": "读到的标记是 orchid-42。",
                    "read_failure": "missing.txt 不存在，这一步未完成，我没有读到文件内容。",
                    "cancel_recovery": "已恢复。",
                    "disabled_native": "原生模型路径已通过本地测试。",
                    "no_dsh": "本地运行正常，没有启动 DSH。",
                    "offline": "",
                }.get(outer.scenario_id)
                if not isinstance(text, str):
                    raise HarnessError("scenario_response_missing")
                self.wfile.write(self.frame({"role": "assistant"}))
                if text:
                    self.wfile.write(self.frame({"content": text}))
                self.wfile.write(self.frame({}, "stop"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, name=f"p01-u10-{scenario_id}", daemon=True)
        self.thread.start()

    @property
    def origin(self) -> str:
        assert self.server is not None
        return f"http://127.0.0.1:{self.server.server_port}"

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=3)

    def save_records(self) -> None:
        write_json(self.output / "relay-requests.json", self.records)


def process_snapshot(env: dict[str, str]) -> list[dict]:
    powershell = Path(env["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    command = [str(powershell), "-NoProfile", "-Command",
               "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"]
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20, check=False)
    if result.returncode != 0:
        raise HarnessError("read_only_process_snapshot_failed")
    try:
        parsed = json.loads(result.stdout) if result.stdout.strip() else []
        return [parsed] if isinstance(parsed, dict) else parsed
    except json.JSONDecodeError as error:
        raise HarnessError("process_snapshot_invalid") from error


def process_descendants(process_id: int, processes: list[dict]) -> list[dict]:
    children: dict[int, list[dict]] = {}
    for item in processes:
        try:
            children.setdefault(int(item["ParentProcessId"]), []).append(item)
        except (KeyError, TypeError, ValueError):
            continue
    found = []
    pending = [process_id]
    seen = {process_id}
    while pending:
        parent = pending.pop()
        for item in children.get(parent, []):
            try:
                pid = int(item["ProcessId"])
            except (KeyError, TypeError, ValueError):
                continue
            if pid in seen:
                continue
            seen.add(pid)
            pending.append(pid)
            found.append({"pid": pid, "parent_pid": parent, "name": str(item.get("Name", "unknown"))})
    return found


def create_profile_and_spec(
    scenario_id: str, scenario_output: Path, candidate: dict, relay: MockRelay,
    system_env: dict[str, str], gate_mode: str,
) -> tuple[Path, dict, list[str] | None]:
    profile = scenario_output / "profile"
    profile.mkdir()
    scenario_cfg = {
        "id": scenario_id,
        "prompt": scenario_prompt(scenario_id),
        "max_requests": expected_requests(scenario_id),
        **({"target": "readme.txt"} if scenario_id == "read_success" else {}),
        **({"target": "missing.txt"} if scenario_id == "read_failure" else {}),
    }
    bridge_spec = {
        "mode": "mock",
        "model": "deepseek-flash",
        "scenario": scenario_cfg,
        "profile_root": str(profile),
        "relay_origin": relay.origin,
        "output_dir": str(scenario_output),
        "system_env": system_env,
    }
    bridge_spec_path = scenario_output / "profile-bridge.spec.json"
    bridge_result_path = scenario_output / "profile-bridge.result.json"
    write_json(bridge_spec_path, bridge_spec)
    bridge_command = run_logged([str(NODE), str(PROFILE_BRIDGE), str(bridge_spec_path), str(bridge_result_path)],
                                REPO, system_env, scenario_output, "profile-bridge", 60)
    if bridge_command.get("exit_code") != 0:
        raise HarnessError("profile_bridge_failed")
    bridge = read_json(bridge_result_path)
    if not isinstance(bridge, dict) or bridge.get("credential_decision", {}).get("decision") != "no-key":
        raise HarnessError("profile_bridge_did_not_refuse_credentials")
    if "credentialRef" in bridge.get("profile", {}):
        raise HarnessError("mock_profile_contains_credential_reference")
    paths = bridge.get("paths")
    env = bridge.get("env")
    if not isinstance(paths, dict) or not isinstance(env, dict):
        raise HarnessError("profile_bridge_shape_invalid")
    for directory in ("home", "data", "temp", "workspace", "storage", "userData", "sessionData", "appData", "localAppData"):
        if not isinstance(paths.get(directory), str) or not Path(paths[directory]).is_dir():
            raise HarnessError("owned_profile_path_missing")

    workspace, history_markers = seed_workspace(
        profile, scenario_output, with_history=scenario_id in {"no_key", "offline"}, env=env
    )
    settings_path = Path(paths["data"]) / ".zcode/v2/setting.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(settings_path, {"desktopChromiumHardwareAccelerationEnabled": False})
    native_config_path = Path(paths["data"]) / ".zcode/v2/provider_config.json"
    native_config_path.parent.mkdir(parents=True, exist_ok=True)
    native_config = native_provider_config(
        relay.origin,
        no_key=scenario_id == "no_key",
        include_pro=scenario_id == "pro_denied",
    )
    write_json(native_config_path, native_config)
    env.update({
        "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE": str(native_config_path),
        "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE": str(SOURCE / "config/provider/zcode-builtin.json"),
        "ZCODE_ENV": "test",
        "NODE_ENV": "production",
        "ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT": "1",
        "P01_U10_GATE_MODE": gate_mode,
        "P01_GUARD_LOG": str(scenario_output / "network-guard.jsonl"),
        "P01_GUARD_WRAPPERS": str(scenario_output / "utility-guards"),
        "P01_GUARD_PROCESS_ROLE": "browser",
        "P01_GUARD_CLI_ENTRY": candidate["resolved_paths"]["cliEntry"],
        "P01_GUARD_CLI_ENTRY_SHA256": sha256(Path(candidate["resolved_paths"]["cliEntry"])),
        "P01_GUARD_ELECTRON_EXE": candidate["resolved_paths"]["electronPath"],
        "P01_ALLOWED_HTTP_ORIGINS": json.dumps([relay.origin]),
        "P01_ALLOWED_IPC_PIPE_PREFIX": rf"\\.\pipe\p01-u10-{uuid.uuid4()}-",
    })
    # No inherited model command, credentials, NODE_OPTIONS, or user profile reaches Electron.
    for forbidden in ("ZCODE_AGENT_SERVER_COMMAND", "ZCODE_AGENT_SERVER_ARGS_JSON", "ZCODE_AGENT_SERVER_CWD", "NODE_OPTIONS"):
        if forbidden in env:
            raise HarnessError("profile_environment_contains_unexpected_override")
    if not all(isinstance(key, str) and isinstance(value, str) for key, value in env.items()):
        raise HarnessError("child_environment_is_not_string_map")
    if not path_is_inside(profile, Path(paths["workspace"])):
        raise HarnessError("workspace_outside_owned_profile")

    flow = {
        "success": "reply", "read_success": "reply", "read_failure": "reply",
        "cancel_recovery": "cancel_recovery", "disabled_native": "reply",
        "pro_denied": "pro_denied", "no_key": "no_key", "no_dsh": "reply", "offline": "offline",
    }[scenario_id]
    model = "deepseek-v4-pro" if scenario_id == "pro_denied" else "deepseek-flash"
    prompt = scenario_cfg["prompt"]
    expected_reply = {
        "success": "你好，我是遐蝶。我们可以慢慢聊。",
        "read_success": "读到的标记是 orchid-42。",
        "read_failure": "missing.txt 不存在，这一步未完成，我没有读到文件内容。",
        "cancel_recovery": "已恢复。",
        "disabled_native": "原生模型路径已通过本地测试。",
        "no_dsh": "本地运行正常，没有启动 DSH。",
    }.get(scenario_id)
    spec = {
        "candidate": candidate["resolved_paths"]["assemblyRoot"],
        "desktop": candidate["resolved_paths"]["desktopPath"],
        "electron": candidate["resolved_paths"]["electronPath"],
        "playwright": candidate["resolved_paths"]["playwrightPath"],
        "guard": str(NETWORK_GUARD),
        "workspace": str(workspace),
        "out": str(scenario_output),
        "env": env,
        "scenario_id": scenario_id,
        "flow": flow,
        "prompt": prompt,
        "model": model,
        "expected_reply": expected_reply,
        "partial_reply": "这是一条尚未完成的本地测试回复" if scenario_id == "cancel_recovery" else None,
        "profile_paths": {"home": paths["home"], "user_data": paths["userData"], "session_data": paths["sessionData"]},
        "gate_mode": gate_mode,
        "relay_origin": relay.origin,
        "occupied_ports_before": [],
        "history_markers": history_markers,
        "cancel_file": str(scenario_output / "cancel.request"),
    }
    spec_path = scenario_output / "desktop-ui.spec.json"
    write_json(spec_path, spec)
    return spec_path, spec, history_markers


def scenario_prompt(scenario_id: str) -> str:
    return {
        "success": "请用一句话，温和地回应我。",
        "read_success": "请只用 Read 读取工作区的 readme.txt，并告诉我其中的标记。",
        "read_failure": "请用 Read 读取工作区的 missing.txt；若失败，请说明这一步未完成。",
        "cancel_recovery": "请开始回复一段较长的内容，我会在回复过程中按停止。",
        "disabled_native": "请简短确认原生模型路径正常。",
        "pro_denied": "请用 deepseek-v4-pro 回答一个简短问候。",
        "no_key": "请回复：不应发出无凭据模型请求。",
        "no_dsh": "请简短回复：本地运行正常。",
        "offline": "请简短回复：我正在验证离线模型拒绝。",
    }[scenario_id]


def expected_requests(scenario_id: str) -> int:
    return {"success": 1, "read_success": 2, "read_failure": 2, "cancel_recovery": 2,
            "disabled_native": 1, "pro_denied": 0, "no_key": 0, "no_dsh": 1, "offline": 1}[scenario_id]


def validate_sidecar(scenario_id: str, profile: Path, relay_records: list[dict], ui_result: dict | None) -> dict:
    path = profile / "u10-turn-projections.jsonl"
    if scenario_id == "disabled_native":
        if path.exists():
            return {"status": "unexpected", "path": str(path), "verified": False}
        return {"status": "NOT_APPLICABLE", "path": str(path), "verified": True}
    if not path.is_file():
        return {"status": "NOT_EXPOSED", "path": str(path), "verified": False}
    records = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(json.loads(line))
    selected = [record for record in records if isinstance(record, dict)]
    invalid = [record for record in selected if
               record.get("schemaVersion") != 1 or not isinstance(record.get("sessionId"), str)
               or not isinstance(record.get("turnId"), str)]
    if invalid:
        return {"status": "invalid", "path": str(path), "verified": False, "invalid_records": len(invalid)}
    call_id = next((record.get("tool_call_id") for record in relay_records if record.get("tool_call_id")), None)
    candidate_entries = [record for record in selected if call_id and
                         (call_id in record.get("requiredToolCallIds", []) or
                          any(isinstance(receipt, dict) and receipt.get("toolCallId") == call_id
                              for receipt in record.get("toolReceipts", [])))]
    if scenario_id in {"read_success", "read_failure"}:
        if not call_id or len(candidate_entries) != 1:
            return {"status": "UNVERIFIED", "path": str(path), "verified": False, "matched_turns": len(candidate_entries)}
        record = candidate_entries[0]
        receipts = record.get("toolReceipts")
        receipt = next((item for item in receipts if isinstance(item, dict) and item.get("toolCallId") == call_id), None) if isinstance(receipts, list) else None
        expected_status = "succeeded" if scenario_id == "read_success" else "failed"
        if (record.get("projectionStatus") != "projected" or not isinstance(receipt, dict)):
            return {"status": "UNVERIFIED", "path": str(path), "verified": False}
        expected_evidence = "verified" if scenario_id == "read_success" else "failed"
        correlated = receipt.get("status") == expected_status and record.get("evidenceStatus") == expected_evidence
        return {"status": "verified" if correlated else "mismatch", "verified": correlated,
                "session_id": record["sessionId"], "turn_id": record["turnId"], "tool_call_id": call_id,
                "tool_status": receipt.get("status"), "lifecycle": record.get("lifecycle"),
                "evidence_status": record.get("evidenceStatus"),
                "projection_status": record.get("projectionStatus"), "reply_sha256": record.get("replySha256")}
    if not selected:
        return {"status": "EMPTY", "path": str(path), "verified": False}
    projection_rows = [record for record in selected if record.get("projectionStatus") == "projected"]
    if scenario_id in {"success", "no_dsh"}:
        expected_reply = EXPECTED_REPLIES[scenario_id]
        expected_bytes = expected_reply.encode("utf-8")
        expected_sha = hashlib.sha256(expected_bytes).hexdigest()
        completed = [record for record in projection_rows if record.get("lifecycle") == "completed"
                     and record.get("resultType") == "success" and record.get("evidenceStatus") == "not_required"
                     and record.get("requiredToolCallIds") == [] and isinstance(record.get("replyBytes"), int)
                     and record.get("replyBytes") == len(expected_bytes) and record.get("replySha256") == expected_sha]
        visible_reply_matches = isinstance(ui_result, dict) and ui_result.get("user_visible_reply") == expected_reply
        verified = len(completed) == 1 and visible_reply_matches
        return {"status": "verified" if verified else "mismatch", "verified": verified,
                "turn_count": len(selected), "completed_reply_turns": len(completed),
                "visible_reply_matches": visible_reply_matches, "expected_reply_sha256": expected_sha, "path": str(path)}
    if scenario_id == "cancel_recovery":
        expected_bytes = EXPECTED_REPLIES[scenario_id].encode("utf-8")
        expected_sha = hashlib.sha256(expected_bytes).hexdigest()
        cancelled = [record for record in projection_rows if record.get("lifecycle") == "cancelled"
                     and record.get("resultType") == "cancelled"]
        completed = [record for record in projection_rows if record.get("lifecycle") == "completed"
                     and record.get("resultType") == "success" and record.get("evidenceStatus") == "not_required"
                     and record.get("replyBytes") == len(expected_bytes) and record.get("replySha256") == expected_sha]
        visible_reply_matches = isinstance(ui_result, dict) and ui_result.get("user_visible_reply") == EXPECTED_REPLIES[scenario_id]
        verified = (len(cancelled) == 1 and len(completed) == 1 and
                    cancelled[0]["turnId"] != completed[0]["turnId"] and visible_reply_matches)
        return {"status": "verified" if verified else "mismatch", "verified": verified,
                "cancelled_turns": len(cancelled), "completed_turns": len(completed),
                "visible_reply_matches": visible_reply_matches, "expected_reply_sha256": expected_sha, "path": str(path)}
    return {"status": "observed", "path": str(path), "verified": False, "turn_count": len(selected),
            "projection_statuses": [record.get("projectionStatus") for record in selected]}


def validate_network_guard(scenario_id: str, guard_records: list[dict], ui_result: dict | None,
                           expected_cli_sha256: str) -> dict:
    runtime = ui_result.get("desktop") if isinstance(ui_result, dict) else None
    main_pid = runtime.get("main_pid") if isinstance(runtime, dict) else None
    main_records = [record for record in guard_records if record.get("pid") == main_pid
                    and record.get("process_role") == "browser"]
    main_ok = (any(record.get("kind") == "guard_loaded" for record in main_records) and
               any(record.get("kind") == "egress_canary_denied" for record in main_records))

    utility_children = {record.get("child_pid") for record in main_records
                        if record.get("kind") == "utility_fork" and isinstance(record.get("child_pid"), int)}
    guarded_utility_pids = []
    for pid in utility_children:
        records = [record for record in guard_records if record.get("pid") == pid
                   and record.get("process_type") == "utility" and record.get("process_role") == "utility"]
        if (any(record.get("kind") == "guard_loaded" for record in records) and
                any(record.get("kind") == "egress_canary_denied" for record in records)):
            guarded_utility_pids.append(pid)

    cli_spawns = [record for record in guard_records if record.get("kind") == "cli_spawn_injected"
                  and record.get("process_role") == "utility" and record.get("pid") in guarded_utility_pids]
    cli_pids = {record.get("child_pid") for record in cli_spawns if isinstance(record.get("child_pid"), int)}
    cli_guarded_pids = []
    for pid in cli_pids:
        records = [record for record in guard_records if record.get("pid") == pid
                   and record.get("process_role") == "cli"]
        if (any(record.get("kind") == "guard_loaded" and record.get("cli_entry_sha256") == expected_cli_sha256
                for record in records) and any(record.get("kind") == "egress_canary_denied" for record in records)):
            cli_guarded_pids.append(pid)

    cli_required = expected_requests(scenario_id) > 0
    descendants = runtime.get("descendant_processes") if isinstance(runtime, dict) else None
    descendant_pids = {item.get("pid") for item in descendants if isinstance(item, dict)} if isinstance(descendants, list) else set()
    cli_tree_ok = bool(cli_guarded_pids) and all(pid in descendant_pids for pid in cli_guarded_pids) if cli_required else True
    utility_ok = bool(guarded_utility_pids)
    cli_ok = (bool(cli_spawns) and set(cli_guarded_pids) == cli_pids and cli_tree_ok) if cli_required else True
    verified = main_ok and utility_ok and cli_ok
    return {
        "status": "verified" if verified else "failed",
        "verified": verified,
        "main": {"pid": main_pid, "guard_loaded": any(record.get("kind") == "guard_loaded" for record in main_records),
                 "egress_canary_denied": any(record.get("kind") == "egress_canary_denied" for record in main_records)},
        "utility_guarded_pids": sorted(guarded_utility_pids),
        "cli_required": cli_required,
        "cli_spawned_pids": sorted(cli_pids),
        "cli_guarded_pids": sorted(cli_guarded_pids),
        "cli_descendants_verified": cli_tree_ok,
    }


def run_scenario(scenario_id: str, output: Path, candidate: dict, system_env: dict[str, str]) -> dict:
    scenario_output = output / "scenarios" / scenario_id
    scenario_output.mkdir(parents=True)
    relay = MockRelay(scenario_id, scenario_output, scenario_output / "profile/workspace",
                      expected_requests(scenario_id), offline=scenario_id == "offline")
    try:
        profile = scenario_output / "profile"
        spec_path, spec, _markers = create_profile_and_spec(
            scenario_id, scenario_output, candidate, relay, system_env,
            gate_mode="disabled" if scenario_id == "disabled_native" else "enabled",
        )
        driver_env = dict(spec["env"])
        driver_env.pop("NODE_OPTIONS", None)
        command = run_ui_driver(spec_path, scenario_output, driver_env, 240)
        relay.stop()
        relay.save_records()
        ui_result_path = scenario_output / "ui-result.json"
        ui_result = read_json(ui_result_path) if ui_result_path.is_file() else None
        guard_path = scenario_output / "network-guard.jsonl"
        guard_records = [json.loads(line) for line in guard_path.read_text(encoding="utf-8").splitlines() if line.strip()] if guard_path.is_file() else []
        sidecar = validate_sidecar(scenario_id, profile, relay.records, ui_result)
        guard_evidence = validate_network_guard(
            scenario_id, guard_records, ui_result, sha256(Path(candidate["resolved_paths"]["cliEntry"])),
        )
        runtime = ui_result.get("desktop") if isinstance(ui_result, dict) else None
        descendants = runtime.get("descendant_processes") if isinstance(runtime, dict) else None
        if isinstance(runtime, dict) and isinstance(descendants, list):
            dsh = [item for item in descendants if isinstance(item, dict) and
                   re.search(r"(^|[-_. ])dsh($|[-_. ])|deepseek.?harness", str(item.get("name", "")), re.I)]
            process_evidence = {"status": "verified" if not dsh else "failed",
                                "root_pid": runtime.get("main_pid"), "descendants": descendants,
                                "dsh_like_descendants": dsh}
        else:
            process_evidence = {"status": "unverified", "reason": "live_process_tree_missing"}

        post_count = len(relay.records)
        expected_count = expected_requests(scenario_id)
        relay_ok = post_count == expected_count and all(record.get("accepted") for record in relay.records)
        if scenario_id == "pro_denied" or scenario_id == "no_key":
            relay_ok = post_count == 0
        if scenario_id == "offline":
            relay_ok = post_count == 1 and relay.records[0].get("status") == 503 and relay.records[0].get("offline_reject") is True
        sidecar_ok = sidecar.get("verified") is True if scenario_id in {
            "success", "read_success", "read_failure", "cancel_recovery", "no_dsh", "disabled_native",
        } else True
        ui_ok = isinstance(ui_result, dict) and ui_result.get("passed") is True and command.get("exit_code") == 0
        process_ok = process_evidence.get("status") == "verified"
        passed = ui_ok and relay_ok and sidecar_ok and process_ok and guard_evidence.get("verified") is True
        result = {
            "scenario_id": scenario_id,
            "passed": passed,
            "exit_code": command.get("exit_code"),
            "model_requests": post_count,
            "expected_model_requests": expected_count,
            "relay_records": relay.records,
            "sidecar_correlation": sidecar,
            "actual_ui": ui_result,
            "network_guard_records": len(guard_records),
            "network_guard": guard_evidence,
            "process_evidence": process_evidence,
            "profile": {"portable_profile_decision": "no-key", "native_provider_config": "empty" if scenario_id == "no_key" else "synthetic-loopback-only",
                        "api_key_real": False, "model_backend": "parent-owned-loopback"},
            "limitations": ["network guard is process instrumentation, not an OS sandbox",
                            "visual acceptance NOT_RUN; UI validation uses actual rendered DOM and buttons"],
        }
        write_json(scenario_output / "scenario-result.json", result)
        return result
    except Exception as error:
        relay.stop()
        relay.save_records()
        failure = {"scenario_id": scenario_id, "passed": False, "failure_code": error.args[0] if error.args and re.fullmatch(r"[a-z0-9_]+", str(error.args[0])) else "scenario_setup_failed",
                   "model_requests": len(relay.records), "expected_model_requests": expected_requests(scenario_id),
                   "relay_records": relay.records, "profile": {"api_key_real": False},
                   "raw_failure_type": type(error).__name__}
        write_json(scenario_output / "scenario-result.json", failure)
        return failure


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, help="absolute assembly root with candidate-descriptor.json")
    parser.add_argument("--suite", choices=("full", "degradation"), default="full")
    parser.add_argument("--output", help="new absolute run evidence directory; defaults to a unique evidence path")
    args = parser.parse_args()
    output = None
    try:
        output = output_root(args.output)
        candidate = verify_candidate(args.candidate)
        source = verify_pinned_source()
        system_env = safe_system_environment()
        bindings_before = execution_bindings()
        production_before = production_snapshot()
        snapshot = {
            "schema": "p01-u10-desktop-run/v1",
            "suite": args.suite,
            "run_id": output.name,
            "output": str(output),
            "candidate": candidate,
            "native_source": source,
            "execution_bindings_before": bindings_before,
            "production_before": production_before,
            "real_credentials_used": False,
            "real_model_requests": 0,
            "DSH_started": "NOT_VERIFIED_YET",
            "visual_acceptance": "NOT_RUN",
            "network_boundary": "instrumented Node/Electron paths plus a parent-owned dynamic loopback relay; not an OS sandbox",
            "scenario_status": "running",
        }
        write_json(output / "run-start.json", snapshot)
        scenario_ids = FULL_SCENARIOS if args.suite == "full" else DEGRADATION_SCENARIOS
        results = []
        for scenario_id in scenario_ids:
            results.append(run_scenario(scenario_id, output, candidate, system_env))
        bindings_after = execution_bindings()
        production_after = production_snapshot()
        execution_unchanged = bindings_before == bindings_after
        production_unchanged = production_before == production_after
        passed = (all(result.get("passed") is True for result in results) and
                  execution_unchanged and production_unchanged)
        dsh_verified = all(result.get("process_evidence", {}).get("status") == "verified" for result in results)
        summary = {**snapshot,
                   "scenario_status": "passed" if passed else "failed",
                   "passed": passed,
                   "execution_bindings_after": bindings_after,
                   "execution_unchanged": execution_unchanged,
                   "production_after": production_after,
                   "production_unchanged": production_unchanged,
                   "scenarios": results,
                   "model_requests": sum(result.get("model_requests", 0) for result in results),
                   "external_model_requests": 0,
                   "DSH_started": False if dsh_verified else None,
                   "DSH_process_tree_verified": dsh_verified,
                   "human_visual_review": "NOT_RUN"}
        write_json(output / "summary.json", summary)
        print(json.dumps({"passed": passed, "suite": args.suite, "output": str(output),
                          "scenarios": [{"id": result["scenario_id"], "passed": result.get("passed"),
                                         "model_requests": result.get("model_requests")} for result in results]},
                         ensure_ascii=False), flush=True)
        return 0 if passed else 1
    except Exception as error:
        code = error.args[0] if error.args and re.fullmatch(r"[a-z0-9_]+", str(error.args[0])) else "desktop_runner_failed"
        if output is not None:
            try:
                write_json(output / "runner-failure.json", {"failure_code": code, "error_type": type(error).__name__})
            except (FileExistsError, OSError):
                pass
        print(f"P01_U10_RUNNER_FAILED:{code}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
