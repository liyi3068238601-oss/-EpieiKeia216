"""P02 Desktop runner: frozen P01 UI harness plus read-only durable-ledger verification."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


REPO = Path(__file__).resolve().parents[3]
P01_RUNNER = REPO / "tests/integration/P01/desktop.py"
VERIFY_LEDGER = Path(__file__).with_name("verify-ledger.mjs")
UI_DRIVER = Path(__file__).with_name("desktop-ui.mjs")
ROOT = Path(r"E:\Xiadie\Xiadie")
NODE = ROOT / ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def attach_ledger_verification(harness, scenario_id: str, scenario_output: Path, result: dict) -> dict:
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
    result_path = scenario_output / "scenario-result.json"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return result


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

    harness = load_p01_runner()
    harness.UI_DRIVER = UI_DRIVER
    original_run_scenario = harness.run_scenario

    def run_scenario(scenario_id: str, run_output: Path, verified_candidate: dict, system_env: dict[str, str]) -> dict:
        result = original_run_scenario(scenario_id, run_output, verified_candidate, system_env)
        return attach_ledger_verification(harness, scenario_id, run_output / "scenarios" / scenario_id, result)

    harness.run_scenario = run_scenario
    original_argv = sys.argv
    sys.argv = [str(P01_RUNNER), "--candidate", str(candidate), "--suite", args.suite, "--output", str(output)]
    try:
        exit_code = harness.main()
    finally:
        sys.argv = original_argv

    if output.is_dir():
        write_json(output / "p02-desktop-runner.json", {
            "schemaVersion": 1,
            "suite": args.suite,
            "candidate": str(candidate.resolve(strict=False)),
            "output": str(output.resolve(strict=False)),
            "runner": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
            "ledgerVerifier": {"path": str(VERIFY_LEDGER.resolve()), "sha256": sha256(VERIFY_LEDGER)},
            "uiDriver": {"path": str(UI_DRIVER.resolve()), "sha256": sha256(UI_DRIVER)},
            "fixedNode": {"path": str(NODE.resolve()), "sha256": sha256(NODE)},
            "harness": {"path": str(P01_RUNNER.resolve()), "sha256": sha256(P01_RUNNER)},
            "qualificationBoundary": "Actual qualification uses the Electron UI with the pinned fixed Node CLI. The durable host and SQLite ledger run in the wrapped CLI protocol process, not Electron main.",
            "sidecarBoundary": "P01 turn sidecar remains UI correlation evidence; durable claims come only from the read-only SQLite and diagnostics checks recorded per scenario.",
            "exitCode": exit_code,
        })
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
