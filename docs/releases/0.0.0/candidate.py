#!/usr/bin/env python3
"""Tiny, source-pinned P00 research-candidate smoke driver; not a product app."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    return sha(path.read_bytes())


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def clean_env() -> dict[str, str]:
    system = os.environ.get("SystemRoot", r"C:\Windows")
    return {
        "SystemRoot": system,
        "WINDIR": system,
        "ComSpec": str(Path(system) / "System32/cmd.exe"),
        "PATHEXT": ".COM;.EXE;.BAT;.CMD",
        "PATH": os.pathsep.join((r"C:\Program Files\nodejs", r"C:\Program Files\Git\cmd",
                                  str(Path(system) / "System32"), str(Path(sys.executable).parent))),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }


def package_check(package: Path) -> dict[str, object]:
    manifest_path = package / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {item["path"] for item in manifest["package_files"]} | {"manifest.json"}
    actual = {p.name for p in package.iterdir() if p.is_file()}
    if actual != expected:
        raise RuntimeError(f"unexpected package file set: {sorted(actual)}")
    checked = []
    for item in manifest["package_files"]:
        path = package / item["path"]
        raw = path.read_bytes()
        if len(raw) != item["bytes"] or sha(raw) != item["sha256"]:
            raise RuntimeError(f"candidate package binding mismatch: {item['path']}")
        checked.append({"path": item["path"], "bytes": len(raw), "sha256": sha(raw)})
    return {"manifest_sha256": file_sha(manifest_path), "files": checked, "manifest": manifest}


def run_command(label: str, command: list[str], cwd: Path, out: Path, timeout: int) -> dict[str, object]:
    start = time.monotonic()
    timed_out = False
    try:
        result = subprocess.run(command, cwd=cwd, env=clean_env(), capture_output=True,
                                timeout=timeout, check=False)
        stdout, stderr, exit_code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired as exc:
        stdout, stderr, exit_code, timed_out = exc.stdout or b"", exc.stderr or b"", None, True
    stdout_path, stderr_path = out / f"{label}.stdout.bin", out / f"{label}.stderr.bin"
    stdout_path.write_bytes(stdout)
    stderr_path.write_bytes(stderr)
    row = {
        "command": command, "cwd": str(cwd), "exit_code": exit_code, "timed_out": timed_out,
        "elapsed_seconds": round(time.monotonic() - start, 3),
        "stdout": {"path": stdout_path.name, "bytes": len(stdout), "sha256": sha(stdout)},
        "stderr": {"path": stderr_path.name, "bytes": len(stderr), "sha256": sha(stderr)},
    }
    write_json(out / f"{label}.command.json", row)
    return row


def verify_external(root: Path, manifest: dict[str, object], case: str) -> dict[str, object]:
    expected = manifest["external"]
    toolchain = expected["toolchain"]
    for name in ("python", "node"):
        tool = toolchain[name]
        path_value = sys.executable if name == "python" else tool["path"]
        actual_path = Path(path_value).resolve()
        expected_path = Path(tool["path"]).resolve()
        if actual_path != expected_path or file_sha(actual_path) != tool["sha256"]:
            raise RuntimeError(f"fixed {name} executable mismatch: {actual_path}")
    python_version = subprocess.run([sys.executable, "--version"], cwd=root, env=clean_env(),
                                    capture_output=True, text=True, check=False).stdout.strip()
    if python_version != toolchain["python"]["version"]:
        raise RuntimeError(f"Python version mismatch: {python_version}")
    node_version = subprocess.run([toolchain["node"]["path"], "--version"], cwd=root, env=clean_env(),
                                  capture_output=True, text=True, check=False).stdout.strip()
    if node_version != toolchain["node"]["version"]:
        raise RuntimeError(f"Node version mismatch: {node_version}")
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], cwd=root,
                          env=clean_env(), capture_output=True, text=True, check=False)
    actual_head = head.stdout.strip()
    if head.returncode or actual_head != expected["project_commit"]:
        raise RuntimeError(f"external project commit mismatch: {actual_head}")
    checks: list[dict[str, object]] = []
    for item in expected["files"]:
        if case not in item["required_by"]:
            continue
        path = root / item["path"]
        if not path.is_file():
            raise RuntimeError(f"required external dependency missing: {item['path']}")
        actual = file_sha(path)
        if actual != item["sha256"]:
            raise RuntimeError(f"external file SHA mismatch: {item['path']}")
        checks.append({"path": item["path"], "bytes": path.stat().st_size, "sha256": actual})
    for acceptance in expected["acceptances"]:
        value = json.loads((root / acceptance["path"]).read_text(encoding="utf-8"))
        if value.get("status") != "accepted":
            raise RuntimeError(f"prerequisite not accepted: {acceptance['unit']}")
    source_names = ["zcode"] if case in ("no-key", "no-dsh", "offline") else ["zcode", "dsh", "herta"]
    sources = []
    for name in source_names:
        item = expected["sources"][name]
        path = root / item["path"]
        rev = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], cwd=root,
                             env=clean_env(), capture_output=True, text=True, check=False)
        status = subprocess.run(["git", "-C", str(path), "status", "--porcelain"], cwd=root,
                                env=clean_env(), capture_output=True, text=True, check=False)
        if rev.returncode or rev.stdout.strip() != item["commit"] or status.returncode != 0 or status.stdout.strip():
            raise RuntimeError(f"fixed source pin not clean: {name}")
        sources.append({"id": name, "commit": item["commit"], "clean": True})
    return {"project_commit": actual_head, "source_pins": sources, "file_checks": checks}


def run_u07(package_info: dict[str, object], root: Path, out: Path, label: str, case: str) -> dict[str, object]:
    probe = root / "tests/integration/P00/u07_mock_probe.py"
    run_id = f"u12-{case}-{time.time_ns()}"
    u07_out = root / "evidence/P00-U11/20261001-01" / run_id
    command = [sys.executable, str(probe), "--root", str(root), "--output-dir", str(u07_out), "--mode", "mock"]
    command_row = run_command(label, command, root, out, 240)
    summary_path = u07_out / "summary-mock.json"
    if not summary_path.is_file():
        raise RuntimeError("U07 mock summary missing")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    runtime = u07_out / "runtime-data" / summary["run_id"]
    request_path = u07_out / "runs" / summary["run_id"] / "requests.json"
    packet_path = runtime / "packet.json"
    personal_path = runtime / "personal.json"
    personal = json.loads(personal_path.read_text(encoding="utf-8"))
    url = personal["config"]["providerConfigRules"]["providerRules"][0]["config"]["api"]["baseUrl"]
    request_rows = json.loads(request_path.read_text(encoding="utf-8"))
    checks = {
        "exit_zero": command_row["exit_code"] == 0 and not command_row["timed_out"],
        "mock_passed": summary.get("passed") is True,
        "no_model_calls": summary.get("model_calls") == 0,
        "no_global_credential_path_reads": summary.get("global_files_read") is False
            and summary.get("global_before") == [] and summary.get("global_after") == [],
        "loopback_only_provider": url.startswith("http://127.0.0.1:"),
        "requests_observed": len(request_rows) > 0,
        "reported_no_real_credential_forwarded": summary.get("isolation", {}).get("credential_in_child_or_files") is False,
    }
    # The fixture contains a synthetic fake apiKey field. It is not a user credential.
    if not all(checks[k] for k in ("exit_zero", "mock_passed", "no_model_calls",
                                   "no_global_credential_path_reads", "loopback_only_provider", "requests_observed",
                                   "reported_no_real_credential_forwarded")):
        raise RuntimeError(f"U07 local mock requirements failed: {checks}")
    bound = {}
    for name, path in (("summary", summary_path), ("requests", request_path),
                       ("packet", packet_path), ("synthetic_personal_config", personal_path),
                       ("spec", runtime / "spec.json"), ("hooks", runtime / "hooks.jsonl")):
        raw = path.read_bytes()
        bound[name] = {"path": str(path.relative_to(root)).replace("\\", "/"),
                       "bytes": len(raw), "sha256": sha(raw)}
    return {"command": command_row, "summary": bound["summary"], "artifacts": bound,
            "checks": checks, "request_count": len(request_rows), "loopback_url": url,
            "synthetic_fixture_key_field_present": "apiKey" in personal["config"]["providerConfigRules"]["providerRules"][0]["config"]["access"],
            "global_files_read": False, "real_model_path": "NOT_RUN_NO_KEY",
            "model_calls": 0, "external_network_calls": 0}


def do_case(case: str, root: Path, out: Path, package_info: dict[str, object],
            dsh_entry_override: str | None) -> dict[str, object]:
    manifest = package_info["manifest"]
    external = verify_external(root, manifest, case)
    result: dict[str, object] = {
        "schema": "xiadie.p00-candidate-case/v1", "product_version": "0.0.0",
        "package_kind": "local P00 research candidate; not a product installer",
        "case": case, "status": "failed", "external": external,
        "package_manifest_sha256": package_info["manifest_sha256"],
        "package_files_checked": package_info["files"], "paid_model_calls": 0,
        "global_credential_files_read": False,
    }
    if case == "smoke":
        run_id = f"candidate-smoke-{time.time_ns()}"
        u11_out = root / "evidence/P00-U11/20261001-01" / run_id
        row = run_command("u11-smoke", [sys.executable, str(root / "tests/integration/P00/run.py"),
                          "--root", str(root), "--output-dir", str(u11_out)], root, out, 900)
        summary_path = u11_out / "runner-summary.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.is_file() else {}
        checks = {
            "runner_exit_zero": row["exit_code"] == 0 and not row["timed_out"],
            "runner_passed_with_limits": summary.get("status") == "passed_with_limits",
            "six_commands_passed": sum(1 for x in summary.get("commands", {}).values()
                                        if isinstance(x, dict) and x.get("exitCode") == 0) == 6,
            "paid_model_calls_zero": summary.get("paidModelCalls") == 0,
        }
        if not all(checks.values()):
            raise RuntimeError(f"U11 smoke failed: {checks}")
        raw = summary_path.read_bytes()
        result.update({"status": "passed_with_limits", "checks": checks,
                       "command": row, "u11_summary": {"path": str(summary_path.relative_to(root)).replace("\\", "/"),
                                                            "bytes": len(raw), "sha256": sha(raw)},
                       "limitations": ["fixed local references required", "not a product or installer test"]})
    elif case in ("no-key", "no-dsh"):
        if case == "no-dsh":
            missing = Path(dsh_entry_override).resolve() if dsh_entry_override else (out / "isolated-absent-dsh" / "sdk-entry.mjs").resolve()
            if not missing.is_relative_to(out.resolve()):
                raise RuntimeError("DSH absence override escaped this case output directory")
            result["dsh"] = {"entry_override": str(missing), "exists": missing.exists(),
                             "launch_attempted": False, "state": "unavailable"}
            if missing.exists():
                raise RuntimeError("the isolated noDSH entry unexpectedly exists")
        local = run_u07(package_info, root, out, "u07-local-mock", case)
        result.update({"status": "passed_with_limits", "local_zcode_mock": local,
                       "checks": local["checks"],
                       "limitations": ["real model not run", "mock-only local loopback", "no future UI or native provider authorization tested"]})
    elif case == "offline":
        local = run_u07(package_info, root, out, "u07-local-mock", case)
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(("127.0.0.1", 0))
        host, port = server.getsockname()
        server.close()
        fault_path = out / "offline-loopback-fault.json"
        start = time.monotonic()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        try:
            sock.connect((host, port))
            fault = {"connected": True, "host": host, "port": port, "error": None}
        except OSError as exc:
            fault = {"connected": False, "host": host, "port": port,
                     "error_type": type(exc).__name__, "error_code": getattr(exc, "winerror", None),
                     "error": str(exc), "elapsed_seconds": round(time.monotonic() - start, 4)}
        finally:
            sock.close()
        write_json(fault_path, fault)
        if fault["connected"]:
            raise RuntimeError("loopback refusal diagnostic unexpectedly connected")
        local_state = {
            "upstream_state": "unavailable",
            "provider_result": None,
            "local_result": "mock diagnostic only",
            "scope": "research diagnostic for the tested loopback socket; not a configured upstream provider state",
        }
        state_path = out / "offline-state.json"
        write_json(state_path, local_state)
        state_readback = json.loads(state_path.read_text(encoding="utf-8"))
        result.update({"status": "passed_with_limits", "local_zcode_mock": local,
                       "offline_fault": {"path": fault_path.name, "bytes": fault_path.stat().st_size,
                                         "sha256": file_sha(fault_path), "result": fault},
                       "local_diagnostic_state": {"path": state_path.name, "bytes": state_path.stat().st_size,
                                                   "sha256": file_sha(state_path), "readback_matches": state_readback == local_state,
                                                   "value": state_readback},
                       "checks": {"local_mock_passed": local["checks"]["mock_passed"],
                                  "loopback_unavailable_observed": True,
                                  "diagnostic_state_readback": state_readback == local_state,
                                  "external_network_calls": 0},
                       "limitations": ["direct loopback TCP diagnostic only", "local_result is a mock diagnostic, not native provider fallback",
                                       "not an OS-wide offline/network sandbox"]})
    else:
        raise RuntimeError(f"unknown case: {case}")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one bounded P00 0.0.0 research-candidate case")
    parser.add_argument("--case", required=True, choices=("smoke", "no-key", "no-dsh", "offline"))
    parser.add_argument("--external-root", required=True, help="Exact P00 project checkout; must be the locked baseline")
    parser.add_argument("--output-dir", required=True, help="Fresh case evidence directory")
    parser.add_argument("--dsh-entry", help="Optional DSH entry override used only to verify noDSH absence")
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    root = Path(args.external_root).resolve()
    out = Path(args.output_dir).resolve()
    if out.exists():
        raise SystemExit("output directory must be fresh")
    out.mkdir(parents=True)
    started = time.monotonic()
    try:
        package_info = package_check(package)
        result = do_case(args.case, root, out, package_info, args.dsh_entry)
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        write_json(out / "summary.json", result)
        print(json.dumps({"status": result["status"], "case": args.case,
                          "summary": str(out / "summary.json")}, ensure_ascii=False))
        return 0
    except BaseException as exc:
        failure = {"schema": "xiadie.p00-candidate-case/v1", "product_version": "0.0.0",
                   "case": args.case, "status": "failed", "error_type": type(exc).__name__,
                   "error": str(exc), "elapsed_seconds": round(time.monotonic() - started, 3),
                   "paid_model_calls": 0, "global_credential_files_read": False}
        write_json(out / "summary.json", failure)
        print(json.dumps({"status": "failed", "case": args.case,
                          "summary": str(out / "summary.json"), "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
