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
CANDIDATE_VERIFIER = Path(__file__).with_name("candidate-verifier.py")
ROOT = Path(r"E:\Xiadie\Xiadie")
NODE = ROOT / ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
        probe_root = profile / "sqlite-runtime-probes"
        probe_root.mkdir()
        process_working_directory = profile / "process-working-directory"
        process_working_directory.mkdir()
        profile_root = profile.resolve(strict=True)
        process_working_directory_real = process_working_directory.resolve(strict=True)
        if (verifier.linked(profile) or verifier.linked(process_working_directory) or
                not process_working_directory_real.is_relative_to(profile_root)):
            raise harness.HarnessError("p02_profile_process_cwd_invalid")
        spec["env"]["P02_SQLITE_RUNTIME_PROBE_DIR"] = str(probe_root.resolve())
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
        attached = attach_ledger_verification(harness, verifier, verified_candidate, scenario_id, scenario_output, result)
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
        suite_closure = candidate_artifact_closure(
            verifier, assembly_root, candidate_pin.get("descriptor_sha256"), candidate_pin.get("artifacts"))
        summary_path = output / "summary.json"
        if summary_path.is_file():
            summary = json.loads(summary_path.read_bytes())
            summary["candidate_artifact_closure_after_suite"] = suite_closure
            if not suite_closure["passed"]:
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
            "candidateAssemblyRoot": str(assembly_root),
            "candidateArtifactClosureAfterSuite": suite_closure,
            "pinnedCandidateDescriptorSha256": candidate_pin.get("descriptor_sha256"),
            "processWorkingDirectoryPolicy": "P02 assigns a physical per-scenario profile directory to the reused UI driver process cwd, keeping process-relative Windows caches outside the immutable candidate assembly. The candidate assembly root and descriptor remain separately verified.",
            "qualificationBoundary": "Actual qualification uses the Electron UI with the pinned fixed Node CLI. The durable host and SQLite ledger run in the wrapped CLI protocol process, not Electron main.",
            "sidecarBoundary": "P01 turn sidecar remains UI correlation evidence; durable claims come only from the read-only SQLite and diagnostics checks recorded per scenario.",
            "exitCode": exit_code,
        })
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
