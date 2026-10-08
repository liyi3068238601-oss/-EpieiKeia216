"""P03 actual Electron/Native memory composition with the accepted P02 guards.

P01/P02 stay unchanged. The reused UI/ledger/egress/process checks are retained;
this wrapper adds Native-memory fixtures, Read transcript assertions and actual
listener snapshots. A loopback provider is a synthetic model, not a paid model.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
P02_RUNNER = REPO / "tests/integration/P02/desktop.py"
SEED = HERE / "seed-memory.mjs"
RELAY = HERE / "memory-relay.py"
FAILURE_REPLY = "未获准读取该主题，这一步未完成，我没有读到文件内容。"


def load_module(name: str, file: Path):
    spec = importlib.util.spec_from_file_location(name, file)
    if spec is None or spec.loader is None:
        raise RuntimeError("p03_helper_unloadable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def binding(file: Path) -> dict:
    data = file.read_bytes()
    return {"path": str(file.resolve()), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest()}


def write_new(file: Path, value: object) -> None:
    with file.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def listeners(env: dict[str, str]) -> list[dict]:
    executable = Path(env["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    command = [str(executable), "-NoProfile", "-Command",
               "$ErrorActionPreference='Stop'; Get-NetTCPConnection -State Listen | "
               "Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress"]
    result = subprocess.run(command, env=env, capture_output=True, text=True,
                            timeout=30, check=False)
    if result.returncode != 0:
        raise RuntimeError("p03_listener_snapshot_failed")
    value = json.loads(result.stdout) if result.stdout.strip() else []
    rows = [value] if isinstance(value, dict) else value
    if not isinstance(rows, list) or any(not isinstance(row, dict) or
            not isinstance(row.get("LocalAddress"), str) or
            type(row.get("LocalPort")) is not int or
            type(row.get("OwningProcess")) is not int for row in rows):
        raise RuntimeError("p03_listener_snapshot_invalid")
    return sorted(rows, key=lambda row: (row["LocalPort"], row["LocalAddress"], row["OwningProcess"]))


def verify_memory(scenario: str, directory: Path, result: dict, seed_pin: dict) -> dict:
    profile = directory / "profile"
    receipt_file = directory / "p03-memory-seed.json"
    if binding(receipt_file) != seed_pin["binding"]:
        raise RuntimeError("p03_memory_seed_receipt_changed")
    # This parent-held copy predates Electron launch. Runtime files cannot
    # redefine expected source hashes by rewriting their seed receipt.
    receipt = seed_pin["receipt"]
    source_files = receipt.get("sourceFiles")
    if not isinstance(source_files, list) or len(source_files) != 5:
        raise RuntimeError("p03_memory_source_bindings_missing")
    expected_paths = {str((Path(receipt["projectMemoryRoot"]) / "MEMORY.md").resolve()),
                      receipt["selectedTopicPath"], receipt["unselectedTopicPath"],
                      str((Path(receipt["foreignMemoryRoot"]) / "MEMORY.md").resolve()),
                      receipt["foreignTopicPath"]}
    if len(expected_paths) != 5 or {entry["path"] for entry in source_files} != expected_paths:
        raise RuntimeError("p03_memory_source_file_set_invalid")
    selected = next(entry for entry in source_files if entry["path"] == receipt["selectedTopicPath"])
    if selected["sha256"] != receipt["selectedTopicSha256"] or selected["bytes"] != receipt["selectedTopicBytes"]:
        raise RuntimeError("p03_selected_source_binding_invalid")
    source_readback = []
    for expected in source_files:
        file = Path(expected["path"])
        if (not file.is_absolute() or not file.resolve(strict=True).is_relative_to(profile.resolve(strict=True))
                or file.is_symlink() or file.is_junction()):
            raise RuntimeError("p03_memory_source_outside_owned_profile")
        actual = binding(file)
        if actual["bytes"] != expected["bytes"] or actual["sha256"] != expected["sha256"]:
            raise RuntimeError("p03_native_memory_changed_by_application")
        source_readback.append(actual)
    # These fixtures have flat, closed roots. Enumerating exact file sets also
    # detects added Native notes/directories at the end of this scenario.
    for memory_root, names in ((Path(receipt["projectMemoryRoot"]),
                               {"MEMORY.md", "p03-topic.md", "p03-unselected.md"}),
                              (Path(receipt["foreignMemoryRoot"]), {"MEMORY.md", "p03-foreign.md"})):
        children = list(memory_root.iterdir())
        if ({child.name for child in children} != names or any(not child.is_file() or
                child.is_symlink() or child.is_junction() for child in children)):
            raise RuntimeError("p03_native_memory_file_set_changed")
    audit_file = profile / "p03-memory-audit.jsonl"
    audit = [json.loads(line) for line in audit_file.read_text(encoding="utf-8").splitlines()
             if line] if audit_file.is_file() else []
    fields = {"event", "projectId", "path", "kind", "code", "sampledAt", "hash", "size"}
    if any(not isinstance(row, dict) or set(row) != fields or
           row["projectId"] != receipt["projectId"] or not isinstance(row["sampledAt"], str)
           or row["event"] not in {"capture", "read"} for row in audit):
        raise RuntimeError("p03_reader_audit_invalid")
    captures = [row for row in audit if row["event"] == "capture"]
    reads = [row for row in audit if row["event"] == "read"]
    relay_records = result.get("relay_records", [])
    if scenario == "read_success":
        observed = [row for row in reads if row["kind"] == "present" and row["code"] == "OK"]
        if (not captures or len(observed) < 2 or any(row["path"] != "p03-topic.md" or
                row["hash"] != receipt["selectedTopicSha256"] for row in observed) or
                not any(row.get("p03_marker_present") is True for row in relay_records)):
            raise RuntimeError("p03_actual_native_memory_read_unverified")
    elif scenario == "read_failure":
        denied = [row for row in reads if row["kind"] == "unreadable" and
                  row["code"] == "READ_NOT_ADMITTED" and row["path"] == "p03-unselected.md" and
                  row["hash"] is None and row["size"] is None]
        if (not captures or not denied or any(row["kind"] == "present" for row in reads) or
                not any(row.get("p03_permission_denied") is True and
                        row.get("p03_unselected_marker_present") is False for row in relay_records)):
            raise RuntimeError("p03_unselected_memory_authority_unverified")
    elif scenario == "cancel_recovery":
        if (len(captures) < 2 or len({row["sampledAt"] for row in captures}) < 2 or
                any(row["kind"] != "present" for row in captures)):
            raise RuntimeError("p03_cancel_recovery_fresh_capture_unverified")
    elif scenario in {"no_key", "no_dsh", "offline"}:
        # Credentials/offline/process proof comes from the reused actual UI path.
        # No Read is requested here; memory fixture preservation is still checked.
        if reads:
            raise RuntimeError("p03_degradation_unexpected_memory_read")
    else:
        raise RuntimeError("p03_unknown_desktop_scenario")
    port_proof = json.loads((directory / "p03-listeners.json").read_bytes())
    port = port_proof["relayPort"]
    if (port in {9229, 9230} or any(row["LocalPort"] == port for row in port_proof["beforeRelay"]) or
            not any(row["LocalPort"] == port and row["LocalAddress"] == "127.0.0.1"
                    for row in port_proof["beforeElectron"])):
        raise RuntimeError("p03_dynamic_relay_listener_unverified")
    ui_runtime = result.get("actual_ui", {}).get("desktop", {})
    if ui_runtime.get("remote_debugging_port") != "0":
        raise RuntimeError("p03_desktop_fixed_inspector_not_disabled")
    return {"passed": True, "seed": binding(receipt_file), "readerAudit": binding(audit_file) if audit_file.is_file() else None,
            "captureCount": len(captures), "readCount": len(reads), "projectId": receipt["projectId"],
            "selectedTopicSha256": receipt["selectedTopicSha256"], "sourceFilesUnchanged": source_readback,
            "observedMemoryRootsFileSetsUnchanged": True,
            "listeners": binding(directory / "p03-listeners.json"), "relayPort": port,
            "desktopInspectorRequest": "0",
            "boundary": "Actual Electron and Native Read with accepted Host bridge; synthetic loopback model; no installed app or external model."}


def main() -> int:
    base = load_module("p03_reused_p02_desktop", P02_RUNNER)
    relay_module = load_module("p03_memory_relay", RELAY)
    original_loader = base.load_p01_runner
    seed_pins: dict[str, dict] = {}
    own_inputs = [Path(__file__).resolve(), RELAY, SEED,
                  HERE / "factory-entry.mjs", HERE / "project-memory-host.mjs", HERE / "build-candidate.mjs"]
    before = [binding(file) for file in own_inputs]

    def load_harness():
        harness = original_loader()
        relay_module.configure(harness)
        harness.ALLOWED_DESCRIPTOR_KEYS = harness.ALLOWED_DESCRIPTOR_KEYS | {"upstreamNotice"}
        original_verify = harness.verify_candidate

        def verify_candidate(candidate_arg):
            verified = original_verify(candidate_arg)
            paths = verified["resolved_paths"]
            assembly = Path(paths["assemblyRoot"])
            descriptor = json.loads((assembly / "candidate-descriptor.json").read_bytes())
            notice = descriptor.get("upstreamNotice")
            source = Path(paths["sourceRoot"]) / "NOTICE.md"
            copy = assembly / "UPSTREAM-NOTICE.md"
            expected_copy = {**binding(copy), "path": "UPSTREAM-NOTICE.md"}
            if (not isinstance(notice, dict) or set(notice) != {"source", "copy"} or
                    notice["source"] != binding(source) or notice["copy"] != expected_copy or
                    copy.read_bytes() != source.read_bytes() or
                    expected_copy not in descriptor["artifacts"]):
                raise harness.HarnessError("p03_upstream_notice_binding_invalid")
            verified["p03_upstream_notice"] = notice
            return verified

        harness.verify_candidate = verify_candidate
        original_prompt = harness.scenario_prompt
        harness.scenario_prompt = lambda scenario: {
            "read_success": "请用 Read 读取本轮允许的项目记忆主题，并告诉我标记。",
            "read_failure": "请尝试读取未获授权的项目主题；若拒绝，说明未完成。",
        }.get(scenario, original_prompt(scenario))
        harness.FULL_SCENARIOS = ("read_success", "read_failure", "cancel_recovery")
        harness.EXPECTED_REPLIES = {**harness.EXPECTED_REPLIES, "read_failure": FAILURE_REPLY}

        class MemoryRelay(relay_module.MockRelay):
            def __init__(self, *args, **kwargs):
                self.listeners_before = listeners(harness.safe_system_environment())
                super().__init__(*args, **kwargs)

        harness.MockRelay = MemoryRelay
        original_profile = harness.create_profile_and_spec

        def create_profile(*args, **kwargs):
            spec_path, spec, markers = original_profile(*args, **kwargs)
            scenario, output, _, relay, system_env = args[:5]
            # This fresh owned fixture becomes a P03 project before its first
            # commit. The historical P01 source and its other fixtures stay intact.
            (Path(spec["workspace"]) / "AGENTS.md").write_text(
                "Use Read only on the exact synthetic file requested for this test. "
                "Project memory selection is checked by the Host; reject unselected "
                "and foreign memory topics. Do not write any project file.\n",
                encoding="utf-8", newline="\n")
            receipt_path = output / "p03-memory-seed.json"
            command = harness.run_logged([str(base.NODE), str(SEED), "--spec", str(spec_path),
                                          "--output", str(receipt_path)], REPO, spec["env"],
                                         output, "p03-memory-seed", 90)
            if command.get("exit_code") != 0 or not receipt_path.is_file():
                raise harness.HarnessError("p03_memory_seed_failed")
            receipt = json.loads(receipt_path.read_bytes())
            seed_pins[scenario] = {"binding": binding(receipt_path),
                                   "receipt": json.loads(json.dumps(receipt))}
            relay.memory_target = receipt["selectedTopicPath"] if scenario == "read_success" else receipt["unselectedTopicPath"]
            if scenario == "read_failure":
                spec["expected_reply"] = FAILURE_REPLY
            current_listeners = listeners(system_env)
            relay_port = urlparse(relay.origin).port
            write_new(output / "p03-listeners.json", {"beforeRelay": relay.listeners_before,
                      "beforeElectron": current_listeners, "relayPort": relay_port,
                      "relayOrigin": relay.origin, "desktopInspectorRequest": "0",
                      "fixedInspectorDisabled": spec["env"].get("ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT") == "1"})
            spec["occupied_ports_before"] = current_listeners
            spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
            return spec_path, spec, markers

        harness.create_profile_and_spec = create_profile
        original_scenario = harness.run_scenario

        def run_scenario(scenario, output, candidate, system_env):
            result = original_scenario(scenario, output, candidate, system_env)
            directory = output / "scenarios" / scenario
            try:
                result["p03_memory_composition"] = verify_memory(scenario, directory, result, seed_pins[scenario])
            except (OSError, ValueError, RuntimeError, KeyError, TypeError) as error:
                result["passed"] = False
                result["p03_memory_composition"] = {"passed": False, "errorType": type(error).__name__,
                                                    "failureCode": str(error)}
            return result

        harness.run_scenario = run_scenario
        return harness

    base.load_p01_runner = load_harness
    exit_code = base.main()
    if "--output" in sys.argv:
        output = Path(sys.argv[sys.argv.index("--output") + 1])
        if output.is_dir():
            after = [binding(file) for file in own_inputs]
            unchanged = before == after
            proof = {"schema": "p03-desktop-composition-runner/v1", "reusedRunner": binding(P02_RUNNER),
                     "inputsBefore": before, "inputsAfter": after, "unchanged": unchanged,
                     "scenariosFull": ["read_success", "read_failure", "cancel_recovery"],
                     "degradation": ["no_key", "no_dsh", "offline"], "externalModelCalls": 0,
                     "boundary": "The unchanged P02 runner retains its historical schema names and ledger/registry/egress guards; P03 adds actual Native memory Read validation.",
                     "exitCode": exit_code if unchanged else 1}
            write_new(output / "p03-desktop-runner.json", proof)
            if not unchanged:
                exit_code = 1
                summary_file = output / "summary.json"
                if summary_file.is_file():
                    summary = json.loads(summary_file.read_bytes())
                    summary.update(passed=False, scenario_status="failed", p03_execution_inputs_unchanged=False)
                    summary_file.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
