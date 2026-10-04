"""P02 Desktop runner: frozen P01 UI harness plus read-only durable-ledger verification."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys


REPO = Path(__file__).resolve().parents[3]
P01_RUNNER = REPO / "tests/integration/P01/desktop.py"
P01_NETWORK_GUARD = REPO / "tests/integration/P01/electron-network-guard.cjs"
VERIFY_LEDGER = Path(__file__).with_name("verify-ledger.mjs")
UI_DRIVER = Path(__file__).with_name("desktop-ui.mjs")
CANDIDATE_VERIFIER = Path(__file__).with_name("candidate-verifier.py")
DESKTOP_MAIN_GUARD = Path(__file__).with_name("desktop-main-guard.cjs")
OWNED_JUNCTION_SCRIPT = Path(__file__).with_name("create-owned-junction.ps1")
ROOT = Path(r"E:\Xiadie\Xiadie")
NODE = ROOT / ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe"
REGISTRY_CONTEXT_MENU_KEYS = (
    r"Software\Classes\Directory\shell\ZCode.OpenInZCode",
    r"Software\Classes\Directory\shell\ZCode.OpenInZCode\command",
    r"Software\Classes\Drive\shell\ZCode.OpenInZCode",
    r"Software\Classes\Drive\shell\ZCode.OpenInZCode\command",
)
REGISTRY_PROTOCOL_KEYS = (
    r"Software\Classes\zcode",
    r"Software\Classes\zcode\DefaultIcon",
    r"Software\Classes\zcode\shell",
    r"Software\Classes\zcode\shell\open",
    r"Software\Classes\zcode\shell\open\command",
)
REGISTRY_SIDE_EFFECT_KEYS = REGISTRY_CONTEXT_MENU_KEYS + REGISTRY_PROTOCOL_KEYS
EXPECTED_REGISTRY_GUARD_KEYS = {
    r"hkcu\software\classes\directory\shell\zcode.openinzcode",
    r"hkcu\software\classes\directory\shell\zcode.openinzcode\command",
    r"hkcu\software\classes\drive\shell\zcode.openinzcode",
    r"hkcu\software\classes\drive\shell\zcode.openinzcode\command",
}
EXPECTED_PROTOCOL_GUARD_SUBKEYS = [item.lower() for item in REGISTRY_PROTOCOL_KEYS]
REGISTRY_GUARD_KEY_SEQUENCE = (
    r"hkcu\software\classes\directory\shell\zcode.openinzcode",
    r"hkcu\software\classes\directory\shell\zcode.openinzcode",
    r"hkcu\software\classes\directory\shell\zcode.openinzcode",
    r"hkcu\software\classes\directory\shell\zcode.openinzcode\command",
    r"hkcu\software\classes\drive\shell\zcode.openinzcode",
    r"hkcu\software\classes\drive\shell\zcode.openinzcode",
    r"hkcu\software\classes\drive\shell\zcode.openinzcode",
    r"hkcu\software\classes\drive\shell\zcode.openinzcode\command",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def registry_side_effect_snapshot() -> dict:
    if os.name != "nt":
        raise RuntimeError("windows_registry_snapshot_unavailable")
    import winreg

    keys = []
    for relative_path in REGISTRY_SIDE_EFFECT_KEYS:
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, relative_path, 0, winreg.KEY_READ)
        except FileNotFoundError:
            payload = {"root": "HKCU", "path": relative_path, "exists": False, "values": []}
        else:
            with key:
                values = []
                index = 0
                while True:
                    try:
                        name, data, value_type = winreg.EnumValue(key, index)
                    except OSError as error:
                        if error.winerror == 259:
                            break
                        raise
                    normalized_data = data.hex() if isinstance(data, bytes) else data
                    value_payload = {"name": name, "type": value_type, "data": normalized_data}
                    value_hash = hashlib.sha256(json.dumps(
                        value_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                    ).encode("utf-8")).hexdigest()
                    values.append({"name": name, "type": value_type, "sha256": value_hash})
                    index += 1
                payload = {"root": "HKCU", "path": relative_path, "exists": True, "values": values}
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        keys.append({**payload, "sha256": hashlib.sha256(encoded).hexdigest()})
    whole = json.dumps(keys, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {"schemaVersion": 1, "access": "read-only",
            "scope": "four ZCode.OpenInZCode context-menu keys and five HKCU\\Software\\Classes\\zcode protocol keys",
            "keys": keys,
            "sha256": hashlib.sha256(whole).hexdigest()}


def create_candidate_cli_runtime_alias(profile: Path, home: Path, candidate: dict, system_env: dict,
                                       verifier) -> dict:
    profile_root = profile.resolve(strict=True)
    home_root = home.resolve(strict=True)
    if verifier.linked(profile) or verifier.linked(home) or not home_root.is_relative_to(profile_root):
        raise RuntimeError("p02_profile_home_invalid_for_cli_alias")

    resolved_paths = candidate.get("resolved_paths")
    if not isinstance(resolved_paths, dict):
        raise RuntimeError("p02_candidate_paths_missing_for_cli_alias")
    assembly_root = Path(resolved_paths["assemblyRoot"]).resolve(strict=True)
    cli_entry = Path(resolved_paths["cliEntry"]).resolve(strict=True)
    target_dir = cli_entry.parent.resolve(strict=True)
    if not cli_entry.is_file() or not target_dir.is_relative_to(assembly_root):
        raise RuntimeError("p02_candidate_cli_entry_outside_assembly")

    alias_parent = home_root
    for component in (".zcode", "server", "agents"):
        alias_parent = alias_parent / component
        if alias_parent.exists() or verifier.linked(alias_parent):
            raise RuntimeError("p02_cli_alias_parent_preexists")
        alias_parent.mkdir()
    alias_dir = alias_parent / "glm"
    alias_entry = alias_dir / cli_entry.name
    if alias_dir.exists() or verifier.linked(alias_dir):
        raise RuntimeError("p02_cli_alias_path_preexists")

    powershell = Path(system_env["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    if not powershell.is_file() or not OWNED_JUNCTION_SCRIPT.is_file():
        raise RuntimeError("owned_junction_tool_missing")
    argv = [str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            str(OWNED_JUNCTION_SCRIPT.resolve()), "-Link", str(alias_dir), "-Target", str(target_dir)]
    operation = subprocess.run(argv, cwd=str(profile_root), env=system_env, capture_output=True,
                               timeout=20, check=False, shell=False)
    operation_record = {
        "argv": argv,
        "exit_code": operation.returncode,
        "stdout_bytes": len(operation.stdout),
        "stdout_sha256": hashlib.sha256(operation.stdout).hexdigest(),
        "stderr_bytes": len(operation.stderr),
        "stderr_sha256": hashlib.sha256(operation.stderr).hexdigest(),
    }
    if operation.returncode != 0:
        return {"schemaVersion": 1, "passed": False, "failure_code": "owned_cli_junction_creation_failed",
                "junction_operation": operation_record}

    alias_dir_real = alias_dir.resolve(strict=True)
    alias_entry_real = alias_entry.resolve(strict=True)
    if (not verifier.linked(alias_dir) or alias_dir_real != target_dir or alias_entry_real != cli_entry or
            sha256(alias_entry) != sha256(cli_entry)):
        return {"schemaVersion": 1, "passed": False, "failure_code": "owned_cli_junction_target_mismatch",
                "junction_operation": operation_record, "alias_dir": str(alias_dir),
                "target_dir": str(target_dir), "alias_entry_realpath": str(alias_entry_real)}
    return {
        "schemaVersion": 1,
        "passed": True,
        "mechanism": "owned-profile-home-directory-junction",
        "alias_dir": str(alias_dir),
        "alias_entry": str(alias_entry),
        "alias_dir_realpath": str(alias_dir_real),
        "alias_entry_realpath": str(alias_entry_real),
        "candidate_target_dir": str(target_dir),
        "candidate_cli_entry": str(cli_entry),
        "entry_sha256": sha256(alias_entry),
        "junction_operation": operation_record,
    }


def candidate_artifact_closure(verifier, assembly_root: Path, descriptor_sha256: str | None, artifacts: object) -> dict:
    if not isinstance(descriptor_sha256, str) or not isinstance(artifacts, list):
        return {"passed": False, "failure_code": "candidate_descriptor_pin_unavailable"}
    try:
        descriptor_bytes = (assembly_root / "candidate-descriptor.json").read_bytes()
        if hashlib.sha256(descriptor_bytes).hexdigest() != descriptor_sha256:
            return {"passed": False, "failure_code": "candidate_descriptor_changed"}
        descriptor = json.loads(descriptor_bytes)
        if descriptor.get("artifacts") != artifacts:
            return {"passed": False, "failure_code": "candidate_descriptor_artifacts_changed"}
        bindings = verifier.verify_owned_artifacts(assembly_root, artifacts)
        return {"passed": True, "owned_files_verified": len(bindings),
                "descriptor_sha256": descriptor_sha256}
    except (ValueError, OSError, TypeError, KeyError) as error:
        failure = str(error)
        if not failure or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789_" for character in failure):
            failure = "candidate_artifact_closure_invalid"
        return {"passed": False, "failure_code": failure}


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def load_p01_runner():
    if not P01_RUNNER.is_file():
        raise RuntimeError("frozen_p01_desktop_harness_missing")
    spec = importlib.util.spec_from_file_location("p01_u10_desktop_harness", P01_RUNNER)
    if spec is None or spec.loader is None:
        raise RuntimeError("frozen_p01_desktop_harness_unloadable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_candidate_verifier():
    spec = importlib.util.spec_from_file_location("p02_candidate_verifier", CANDIDATE_VERIFIER)
    if spec is None or spec.loader is None:
        raise RuntimeError("p02_candidate_verifier_unloadable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def attach_ledger_verification(harness, verifier, candidate: dict, scenario_id: str, scenario_output: Path, result: dict) -> dict:
    profile = scenario_output / "profile"
    report_path = scenario_output / "ledger-verification.json"
    argv = [
        str(NODE), str(VERIFY_LEDGER),
        "--profile-root", str(profile.resolve()),
        "--scenario", scenario_id,
        "--output", str(report_path.resolve()),
    ]
    if scenario_id == "success":
        argv.append("--backup-restore")

    command = None
    failure = None
    try:
        command = harness.run_logged(
            argv, REPO, harness.safe_system_environment(), scenario_output,
            "ledger-verification", 180,
        )
        if command.get("exit_code") != 0 or not report_path.is_file():
            failure = "ledger_verification_failed"
        else:
            report = json.loads(report_path.read_text(encoding="utf-8"))
            if not isinstance(report, dict) or report.get("passed") is not True:
                failure = "ledger_verification_failed"
    except Exception:
        failure = "ledger_verification_runner_failed"
        report = None

    if failure is not None:
        result["passed"] = False
        result["ledger_verification"] = {
            "passed": False,
            "failure_code": failure,
            "command_record": command,
            "report_path": str(report_path),
        }
    else:
        result["passed"] = result.get("passed") is True
        result["ledger_verification"] = {
            "passed": True,
            "report_path": str(report_path),
            "admission": report.get("admission"),
            "admitted_turns": report.get("admitted_turns"),
            "backup_restore": report.get("backup_restore"),
        }
        try:
            result["sqlite_runtime_binding"] = verifier.verify_runtime_probes(profile, scenario_id, result, candidate, report)
        except (ValueError, OSError, TypeError, KeyError):
            result["passed"] = False
            result["sqlite_runtime_binding"] = {"passed": False, "failure_code": "sqlite_runtime_binding_verification_failed"}
    result_path = scenario_output / "scenario-result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return result


def verify_candidate_cli_alias(profile: Path, candidate: dict, verifier) -> dict:
    receipt_path = profile / "sqlite-cli-runtime-alias.json"
    if not receipt_path.is_file():
        return {"passed": False, "failure_code": "candidate_cli_alias_receipt_missing"}
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        candidate_entry = Path(candidate["resolved_paths"]["cliEntry"]).resolve(strict=True)
        assembly_root = Path(candidate["resolved_paths"]["assemblyRoot"]).resolve(strict=True)
        alias_dir = Path(receipt["alias_dir"])
        alias_entry = Path(receipt["alias_entry"])
        home = (profile / "home").resolve(strict=True)
        expected_alias_dir = home / ".zcode/server/agents/glm"
        expected_alias_entry = expected_alias_dir / candidate_entry.name
        if (receipt.get("schemaVersion") != 1 or receipt.get("passed") is not True or
                os.path.normcase(str(alias_dir)) != os.path.normcase(str(expected_alias_dir)) or
                not alias_entry.is_absolute() or
                os.path.normcase(str(alias_entry)) != os.path.normcase(str(expected_alias_entry)) or
                not alias_dir.is_junction() or alias_dir.resolve(strict=True) != candidate_entry.parent or
                alias_entry.resolve(strict=True) != candidate_entry or sha256(alias_entry) != sha256(candidate_entry) or
                receipt.get("candidate_cli_entry") != str(candidate_entry) or
                receipt.get("alias_entry_realpath") != str(candidate_entry) or
                receipt.get("entry_sha256") != sha256(candidate_entry) or
                not alias_entry.is_file() or not alias_dir.resolve(strict=True).is_relative_to(assembly_root)):
            return {"passed": False, "failure_code": "candidate_cli_alias_binding_mismatch"}
        return {
            "passed": True,
            "mechanism": receipt["mechanism"],
            "alias_entry": str(alias_entry),
            "realpath": str(candidate_entry),
            "entry_sha256": sha256(candidate_entry),
            "realpath_matches_candidate": True,
            "p01_guard_expected_entry_matches_alias": True,
        }
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return {"passed": False, "failure_code": "candidate_cli_alias_verification_failed"}


def verify_registry_guard_log(profile: Path, candidate: dict, scenario_result: dict) -> dict:
    log_path = profile / "registry-write-guard.jsonl"
    launcher_pid_path = profile.parent / "desktop-main.pid"
    try:
        launcher_pid = int(launcher_pid_path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError, TypeError):
        return {"passed": False, "failure_code": "registry_write_guard_log_unavailable"}
    try:
        actual_ui = scenario_result["actual_ui"]
        actual_main_pid = actual_ui["desktop"]["main_pid"]
        network_main_pid = scenario_result["network_guard"]["main"]["pid"]
        process_root_pid = scenario_result["process_evidence"]["root_pid"]
    except (TypeError, KeyError):
        return {"passed": False, "failure_code": "main_process_runtime_snapshot_invalid"}
    if (type(actual_main_pid) is not int or actual_main_pid <= 0 or
            actual_main_pid != network_main_pid or actual_main_pid != process_root_pid or
            type(launcher_pid) is not int or launcher_pid <= 0):
        return {"passed": False, "failure_code": "main_process_runtime_snapshot_invalid"}
    main_pid = actual_main_pid
    try:
        records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line]
        main_snapshot = json.loads((profile / "main-process-runtime.json").read_bytes())
        ui_spec = json.loads((profile.parent / "desktop-ui.spec.json").read_bytes())
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return {"passed": False, "failure_code": "registry_write_guard_log_unavailable"}

    if not isinstance(main_snapshot, dict) or not isinstance(ui_spec, dict):
        return {"passed": False, "failure_code": "main_process_runtime_snapshot_invalid"}
    try:
        expected_icon_path = Path(candidate["resolved_paths"]["electronPath"]).resolve(strict=True)
        expected_cwd_path = Path(ui_spec.get("process_working_directory", "")).resolve(strict=True)
        main_cwd_path = Path(main_snapshot.get("cwd", "")).resolve(strict=True)
        main_exec_path = Path(main_snapshot.get("execPath", "")).resolve(strict=True)
    except (OSError, TypeError, ValueError, KeyError):
        return {"passed": False, "failure_code": "main_process_runtime_path_invalid"}
    expected_icon = os.path.normcase(str(expected_icon_path))
    main_argv = main_snapshot.get("argv")
    if (set(main_snapshot) != {
            "schemaVersion", "pid", "processType", "cwd", "execPath", "defaultApp", "argv", "argvSha256",
            "argvEntry", "resolvedArgvEntry"} or main_snapshot.get("schemaVersion") != 1 or
            main_snapshot.get("pid") != main_pid or main_snapshot.get("processType") != "browser" or
            not isinstance(main_snapshot.get("defaultApp"), bool) or not isinstance(main_argv, list) or
            not main_argv or not all(isinstance(item, str) for item in main_argv) or
            main_snapshot.get("argvSha256") != hashlib.sha256(json.dumps(
                main_argv, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")).hexdigest() or
            main_snapshot.get("argvEntry") != (main_argv[1] if len(main_argv) > 1 else None) or
            os.path.normcase(str(main_exec_path)) != expected_icon or
            os.path.normcase(str(main_cwd_path)) != os.path.normcase(str(expected_cwd_path)) or
            not main_cwd_path.is_dir() or not main_cwd_path.is_relative_to(profile.resolve(strict=True))):
        return {"passed": False, "failure_code": "main_process_runtime_snapshot_invalid"}
    expected_argv_entry = (str(Path(main_cwd_path, main_argv[1]).resolve()) if len(main_argv) > 1 else None)
    if main_snapshot.get("resolvedArgvEntry") != expected_argv_entry:
        return {"passed": False, "failure_code": "main_process_argv_entry_binding_invalid"}
    menu_records = []
    protocol_registration_records = []
    protocol_removal_records = []
    recent_records = []
    for record in records:
        if not isinstance(record, dict) or record.get("schemaVersion") != 1 or record.get("pid") != main_pid or record.get("processType") != "browser":
            return {"passed": False, "failure_code": "registry_write_guard_record_invalid"}
        try:
            record_cwd = Path(record.get("cwd", "")).resolve(strict=True)
        except (OSError, TypeError, ValueError):
            return {"passed": False, "failure_code": "registry_write_guard_record_invalid"}
        if os.path.normcase(str(record_cwd)) != os.path.normcase(str(main_cwd_path)):
            return {"passed": False, "failure_code": "registry_write_guard_record_invalid"}
        if record.get("kind") == "blocked_reg_exe":
            raw_argv = record.get("rawArgv")
            if (not isinstance(raw_argv, list) or len(raw_argv) < 3 or
                    not isinstance(raw_argv[0], str) or Path(raw_argv[0]).name.lower() != "reg.exe" or
                    record.get("rawArgvSha256") != hashlib.sha256(json.dumps(
                        raw_argv, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")).hexdigest()):
                return {"passed": False, "failure_code": "registry_write_guard_record_invalid"}
            menu_records.append(raw_argv)
        elif record.get("kind") in {"blocked_default_protocol_registration", "blocked_default_protocol_removal"}:
            raw_args = record.get("rawArgs")
            expected_kind = record.get("kind")
            expected_code = ("P02_DEFAULT_PROTOCOL_REGISTRATION_BLOCKED" if
                             expected_kind == "blocked_default_protocol_registration" else
                             "P02_DEFAULT_PROTOCOL_REMOVAL_BLOCKED")
            expected_method = ("app.setAsDefaultProtocolClient" if
                               expected_kind == "blocked_default_protocol_registration" else
                               "app.removeAsDefaultProtocolClient")
            if (record.get("code") != expected_code or record.get("method") != expected_method or
                    record.get("blocked") is not True or
                    record.get("returnValue") is not False or record.get("returnType") != "boolean" or
                    record.get("defaultApp") is not main_snapshot.get("defaultApp") or
                    not isinstance(raw_args, list) or raw_args[0:1] != ["zcode"] or
                    (expected_kind == "blocked_default_protocol_registration" and
                     main_snapshot.get("defaultApp") is True and len(main_argv) >= 2 and
                     (len(raw_args) != 3 or raw_args[1] != main_snapshot.get("execPath") or
                      raw_args[2] != [expected_argv_entry])) or
                    (expected_kind == "blocked_default_protocol_registration" and
                     not (main_snapshot.get("defaultApp") is True and len(main_argv) >= 2) and raw_args != ["zcode"]) or
                    record.get("rawArgsSha256") != hashlib.sha256(json.dumps(
                        raw_args, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")).hexdigest() or
                    record.get("expectedRegistrySubkeys") != EXPECTED_PROTOCOL_GUARD_SUBKEYS):
                return {"passed": False, "failure_code": "default_protocol_guard_record_invalid"}
            if expected_kind == "blocked_default_protocol_registration":
                protocol_registration_records.append(record)
            else:
                if raw_args != ["zcode"]:
                    return {"passed": False, "failure_code": "default_protocol_removal_request_invalid"}
                protocol_removal_records.append(record)
        elif record.get("kind") == "blocked_clear_recent_documents":
            raw_args = record.get("rawArgs")
            if (record.get("code") != "P02_CLEAR_RECENT_DOCUMENTS_BLOCKED" or
                    record.get("method") != "app.clearRecentDocuments" or record.get("blocked") is not True or
                    record.get("returnValue") is not None or record.get("returnType") != "undefined" or
                    raw_args != [] or record.get("rawArgsSha256") != hashlib.sha256(b"[]").hexdigest()):
                return {"passed": False, "failure_code": "recent_documents_guard_record_invalid"}
            recent_records.append(record)
        else:
            return {"passed": False, "failure_code": "unknown_registry_side_effect_record"}

    if (len(menu_records) < 8 or len(menu_records) % 8 != 0 or
            not protocol_registration_records or not recent_records):
        return {
            "passed": False,
            "failure_code": "registry_write_guard_request_set_mismatch",
            "request_count": len(records),
            "menu_request_count": len(menu_records),
            "protocol_registration_count": len(protocol_registration_records),
            "recent_document_request_count": len(recent_records),
        }
    if protocol_removal_records:
        return {"passed": False, "failure_code": "unexpected_default_protocol_removal_request",
                "blocked_protocol_removal_count": len(protocol_removal_records)}

    menu_group_count = len(menu_records) // 8
    for group_index in range(menu_group_count):
        group = menu_records[group_index * 8:(group_index + 1) * 8]
        for position, (raw_argv, expected_key) in enumerate(zip(group, REGISTRY_GUARD_KEY_SEQUENCE, strict=True)):
            args = raw_argv[1:]
            if (len(args) < 2 or not isinstance(args[0], str) or args[0].lower() != "add" or
                    not isinstance(args[1], str) or args[1].replace("/", "\\").lower() != expected_key):
                return {"passed": False, "failure_code": "registry_write_guard_operation_order_invalid"}
            if position in {0, 4}:
                if (len(args) != 6 or args[2:4] != ["/ve", "/d"] or
                        args[4] not in {"在ZCode中打开", "Open in ZCode"} or args[5] != "/f"):
                    return {"passed": False, "failure_code": "registry_write_guard_label_operation_invalid"}
            elif position in {1, 5}:
                if (len(args) != 9 or args[2:7] != ["/v", "MUIVerb", "/t", "REG_SZ", "/d"] or
                        args[7] not in {"在ZCode中打开", "Open in ZCode"} or args[8] != "/f"):
                    return {"passed": False, "failure_code": "registry_write_guard_verb_operation_invalid"}
            elif position in {2, 6}:
                if (len(args) != 9 or args[2:7] != ["/v", "Icon", "/t", "REG_SZ", "/d"] or
                        not isinstance(args[7], str) or os.path.normcase(str(Path(args[7]).resolve(strict=True))) != expected_icon or
                        args[8] != "/f"):
                    return {"passed": False, "failure_code": "registry_write_guard_icon_operation_invalid"}
            else:
                if (len(args) != 6 or args[2:4] != ["/ve", "/d"] or not isinstance(args[4], str) or
                        not args[4].endswith(' --open-workspace "%1"') or args[5] != "/f"):
                    return {"passed": False, "failure_code": "registry_write_guard_command_operation_invalid"}
                quote_end = args[4].find('"', 1) if args[4].startswith('"') else -1
                if (quote_end <= 1 or
                        os.path.normcase(str(Path(args[4][1:quote_end]).resolve(strict=True))) != expected_icon):
                    return {"passed": False, "failure_code": "registry_write_guard_command_executable_invalid"}

    return {
        "passed": True,
        "scope": "Electron main child_process.spawn reg.exe and guarded Electron app APIs",
        "os_sandbox": False,
        "request_count": len(records),
        "blocked_menu_request_count": len(menu_records),
        "menu_install_group_count": menu_group_count,
        "blocked_protocol_registration_count": len(protocol_registration_records),
        "blocked_protocol_removal_count": 0,
        "blocked_recent_document_clear_count": len(recent_records),
        "main_pid": main_pid,
        "launcher_pid": launcher_pid,
        "main_process_snapshot_path": str(profile / "main-process-runtime.json"),
        "main_process_snapshot_sha256": sha256(profile / "main-process-runtime.json"),
        "blocked_requests_sha256": sha256(log_path),
        "raw_requests_path": str(log_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, help="absolute P02 candidate assembly directory")
    parser.add_argument("--suite", required=True, choices=("full", "degradation"))
    parser.add_argument("--output", required=True, help="new absolute Desktop run evidence directory")
    args = parser.parse_args()

    candidate = Path(args.candidate)
    output = Path(args.output)
    if not candidate.is_absolute():
        parser.error("--candidate must be absolute")
    if not output.is_absolute():
        parser.error("--output must be absolute")
    if output.exists():
        parser.error("--output must name a new directory")
    if not NODE.is_file() or not VERIFY_LEDGER.is_file():
        raise RuntimeError("fixed_node_or_ledger_verifier_missing")
    registry_before = registry_side_effect_snapshot()

    harness = load_p01_runner()
    verifier = load_candidate_verifier()
    candidate_pin: dict = {}
    harness.UI_DRIVER = UI_DRIVER
    original_verify_candidate = harness.verify_candidate

    def verify_candidate(candidate_arg: str) -> dict:
        verified = verifier.verify_candidate(harness, candidate_arg, original_verify_candidate)
        assembly_root = Path(verified["resolved_paths"]["assemblyRoot"])
        descriptor_path = assembly_root / "candidate-descriptor.json"
        descriptor_bytes = descriptor_path.read_bytes()
        descriptor_sha256 = hashlib.sha256(descriptor_bytes).hexdigest()
        if descriptor_sha256 != verified.get("descriptor_sha256"):
            raise harness.HarnessError("candidate_descriptor_pin_invalid")
        descriptor = json.loads(descriptor_bytes)
        artifacts = descriptor.get("artifacts") if isinstance(descriptor, dict) else None
        if not isinstance(artifacts, list):
            raise harness.HarnessError("candidate_descriptor_artifacts_invalid")
        candidate_pin.update({"descriptor_sha256": descriptor_sha256,
                              "artifacts": json.loads(json.dumps(artifacts))})
        return verified

    harness.verify_candidate = verify_candidate
    original_create_profile = harness.create_profile_and_spec

    def create_profile_and_spec(*positional, **keywords):
        spec_path, spec, markers = original_create_profile(*positional, **keywords)
        profile = positional[1] / "profile"
        scenario_candidate = positional[2]
        scenario_system_env = positional[4]
        probe_root = profile / "sqlite-runtime-probes"
        probe_root.mkdir()
        process_working_directory = profile / "process-working-directory"
        process_working_directory.mkdir()
        profile_root = profile.resolve(strict=True)
        process_working_directory_real = process_working_directory.resolve(strict=True)
        if (verifier.linked(profile) or verifier.linked(process_working_directory) or
                not process_working_directory_real.is_relative_to(profile_root)):
            raise harness.HarnessError("p02_profile_process_cwd_invalid")
        alias_receipt = create_candidate_cli_runtime_alias(
            profile, Path(spec["profile_paths"]["home"]), scenario_candidate, scenario_system_env, verifier)
        write_json(profile / "sqlite-cli-runtime-alias.json", alias_receipt)
        if not alias_receipt.get("passed"):
            raise harness.HarnessError(alias_receipt.get("failure_code", "candidate_cli_alias_creation_failed"))
        spec["env"]["P02_SQLITE_RUNTIME_PROBE_DIR"] = str(probe_root.resolve())
        spec["env"]["P02_REGISTRY_GUARD_LOG"] = str((profile / "registry-write-guard.jsonl").resolve())
        spec["env"]["P02_MAIN_PROCESS_SNAPSHOT"] = str((profile / "main-process-runtime.json").resolve())
        spec["env"]["P01_GUARD_CLI_ENTRY"] = alias_receipt["alias_entry"]
        spec["env"]["P01_GUARD_CLI_ENTRY_SHA256"] = alias_receipt["entry_sha256"]
        spec["guard"] = str(DESKTOP_MAIN_GUARD.resolve())
        spec["process_working_directory"] = str(process_working_directory.resolve())
        spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        return spec_path, spec, markers

    harness.create_profile_and_spec = create_profile_and_spec
    original_run_scenario = harness.run_scenario
    assembly_root = Path(args.candidate).resolve(strict=True)

    def run_scenario(scenario_id: str, run_output: Path, verified_candidate: dict, system_env: dict[str, str]) -> dict:
        before_closure = candidate_artifact_closure(
            verifier, assembly_root, candidate_pin.get("descriptor_sha256"), candidate_pin.get("artifacts"))
        if not before_closure["passed"]:
            scenario_output = run_output / "scenarios" / scenario_id
            scenario_output.mkdir(parents=True, exist_ok=True)
            result = {"scenario_id": scenario_id, "passed": False,
                      "failure_code": "candidate_artifact_closure_changed_before_scenario",
                      "candidate_artifact_closure_before": before_closure,
                      "model_requests": 0}
            write_json(scenario_output / "scenario-result.json", result)
            return result
        result = original_run_scenario(scenario_id, run_output, verified_candidate, system_env)
        scenario_output = run_output / "scenarios" / scenario_id
        profile = scenario_output / "profile"
        alias_binding = verify_candidate_cli_alias(profile, verified_candidate, verifier)
        registry_guard = verify_registry_guard_log(profile, verified_candidate, result)
        attached = attach_ledger_verification(harness, verifier, verified_candidate, scenario_id, scenario_output, result)
        attached["sqlite_cli_runtime_alias"] = alias_binding
        attached["registry_write_guard"] = registry_guard
        if not alias_binding["passed"] or not registry_guard["passed"]:
            attached["passed"] = False
        after_closure = candidate_artifact_closure(
            verifier, assembly_root, candidate_pin.get("descriptor_sha256"), candidate_pin.get("artifacts"))
        attached["candidate_artifact_closure"] = {"before_scenario": before_closure, "after_scenario": after_closure}
        if not after_closure["passed"]:
            attached["passed"] = False
        (scenario_output / "scenario-result.json").write_text(
            json.dumps(attached, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        return attached

    harness.run_scenario = run_scenario
    original_argv = sys.argv
    sys.argv = [str(P01_RUNNER), "--candidate", str(candidate), "--suite", args.suite, "--output", str(output)]
    try:
        exit_code = harness.main()
    finally:
        sys.argv = original_argv

    if output.is_dir():
        registry_after = registry_side_effect_snapshot()
        registry_proof = {
            "schemaVersion": 1,
            "scope": registry_before["scope"],
            "keyCount": len(registry_before["keys"]),
            "readOnly": True,
            "preSnapshotSha256": registry_before["sha256"],
            "postSnapshotSha256": registry_after["sha256"],
            "unchangedDuringThisSuite": registry_before["sha256"] == registry_after["sha256"],
            "baselineBoundary": "The pre-state was captured immediately before this suite; it does not reconstruct a state from before earlier runs.",
        }
        write_json(output / "registry-side-effects-pre.json", registry_before)
        write_json(output / "registry-side-effects-post.json", registry_after)
        write_json(output / "registry-side-effects-verification.json", registry_proof)
        suite_closure = candidate_artifact_closure(
            verifier, assembly_root, candidate_pin.get("descriptor_sha256"), candidate_pin.get("artifacts"))
        summary_path = output / "summary.json"
        if summary_path.is_file():
            summary = json.loads(summary_path.read_bytes())
            summary["candidate_artifact_closure_after_suite"] = suite_closure
            summary["registry_side_effect_state"] = registry_proof
            if not suite_closure["passed"] or not registry_proof["unchangedDuringThisSuite"]:
                summary["passed"] = False
                summary["scenario_status"] = "failed"
                exit_code = 1
            summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
                                    encoding="utf-8", newline="\n")
        write_json(output / "p02-desktop-runner.json", {
            "schemaVersion": 1,
            "suite": args.suite,
            "candidate": str(candidate.resolve(strict=False)),
            "output": str(output.resolve(strict=False)),
            "runner": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
            "ledgerVerifier": {"path": str(VERIFY_LEDGER.resolve()), "sha256": sha256(VERIFY_LEDGER)},
            "candidateVerifier": {"path": str(CANDIDATE_VERIFIER.resolve()), "sha256": sha256(CANDIDATE_VERIFIER)},
            "uiDriver": {"path": str(UI_DRIVER.resolve()), "sha256": sha256(UI_DRIVER)},
            "fixedNode": {"path": str(NODE.resolve()), "sha256": sha256(NODE)},
            "harness": {"path": str(P01_RUNNER.resolve()), "sha256": sha256(P01_RUNNER)},
            "desktopMainGuard": {"path": str(DESKTOP_MAIN_GUARD.resolve()), "sha256": sha256(DESKTOP_MAIN_GUARD)},
            "registryWriteGuard": {"path": str(Path(__file__).with_name("registry-write-guard.cjs").resolve()),
                                   "sha256": sha256(Path(__file__).with_name("registry-write-guard.cjs"))},
            "ownedJunctionScript": {"path": str(OWNED_JUNCTION_SCRIPT.resolve()),
                                    "sha256": sha256(OWNED_JUNCTION_SCRIPT)},
            "p01NetworkGuard": {"path": str(P01_NETWORK_GUARD.resolve()), "sha256": sha256(P01_NETWORK_GUARD)},
            "candidateAssemblyRoot": str(assembly_root),
            "candidateArtifactClosureAfterSuite": suite_closure,
            "pinnedCandidateDescriptorSha256": candidate_pin.get("descriptor_sha256"),
            "processWorkingDirectoryPolicy": "P02 assigns a physical per-scenario profile directory to the reused UI driver process cwd, keeping process-relative Windows caches outside the immutable candidate assembly. The candidate assembly root and descriptor remain separately verified.",
            "nativeCliRuntimeAliasPolicy": "P02 creates a per-scenario junction under the owned profile home that resolves to the verified candidate CLI dist directory; the P01 CLI guard uses the alias path while verifying the same candidate entry hash.",
            "registryGuardPolicy": "P02 Electron main instrumentation blocks reg.exe child_process.spawn, app protocol registration/removal, and recent-document clearing calls, recording original requests before native side effects. It is not an operating-system sandbox; four ZCode.OpenInZCode context-menu keys and five zcode protocol keys are hashed read-only immediately before and after each suite.",
            "registrySideEffectState": registry_proof,
            "qualificationBoundary": "Actual qualification uses the Electron UI with the pinned fixed Node CLI. The durable host and SQLite ledger run in the wrapped CLI protocol process, not Electron main.",
            "processPidRolePolicy": "desktop-main.pid records the Playwright Electron launcher PID; main-process-runtime.json and blocked side-effect records bind to the app.evaluate main PID, cross-checked against P01 process and network evidence.",
            "mainProcessSnapshotCapturePolicy": "The main-process snapshot is written once at the first guarded setAsDefaultProtocolClient call, sampling process argv/defaultApp directly at the API boundary before the call is blocked.",
            "sidecarBoundary": "P01 turn sidecar remains UI correlation evidence; durable claims come only from the read-only SQLite and diagnostics checks recorded per scenario.",
            "exitCode": exit_code,
        })
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
