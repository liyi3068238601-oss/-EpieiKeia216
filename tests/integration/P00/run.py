"""Run the bounded P00 integration replay against fixed local sources only."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def git(root: Path, source: Path, *args: str) -> dict[str, str | int]:
    result = subprocess.run(["git", "-C", str(source), *args], cwd=root, env=ENV,
                            capture_output=True, text=True, check=False)
    return {"args": list(args), "cwd": str(source), "exitCode": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr}


parser = argparse.ArgumentParser(description="Bounded P00 integration replay; no credentials or external models")
parser.add_argument("--root", required=True, help="Explicit Xiadie project root")
parser.add_argument("--output-dir", required=True, help="Fresh directory below evidence/P00-U11")
args = parser.parse_args()
ROOT = Path(args.root).resolve()
OUT = Path(args.output_dir).resolve()
assert OUT.is_relative_to(ROOT / "evidence/P00-U11"), "Output must stay under evidence/P00-U11"
assert not OUT.exists(), "Use a fresh --output-dir; this runner never overwrites a prior attempt"
OUT.mkdir(parents=True)

SYSTEM = Path(os.environ.get("SystemRoot", r"C:\Windows"))
NODE = Path(r"C:\Program Files\nodejs\node.exe")
GIT = Path(r"C:\Program Files\Git\cmd")
ENV_ROOT = OUT / "runner-environment"
for name in ("userprofile", "appdata", "localappdata", "temp"):
    (ENV_ROOT / name).mkdir(parents=True, exist_ok=True)
ENV = {
    "SystemRoot": str(SYSTEM), "WINDIR": str(SYSTEM),
    "ComSpec": str(SYSTEM / "System32/cmd.exe"), "PATHEXT": ".COM;.EXE;.BAT;.CMD",
    "PATH": os.pathsep.join((str(NODE.parent), str(GIT), str(SYSTEM / "System32"), str(Path(sys.executable).parent))),
    "USERPROFILE": str(ENV_ROOT / "userprofile"), "APPDATA": str(ENV_ROOT / "appdata"),
    "LOCALAPPDATA": str(ENV_ROOT / "localappdata"), "TEMP": str(ENV_ROOT / "temp"),
    "TMP": str(ENV_ROOT / "temp"), "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
}

pins = {
    ".runtime/P00/zcode/source": "29628c9acdb81b703bbd4080c207a0e7ce5e276e",
    ".runtime/P00/dsh/source": "639ed015397290b3745d163aafe02ffee4aa3f84",
    "references/herta-4623df12": "4623df120adf99340ce5f7e25ed829466975e3ae",
}
pin_state: dict[str, dict[str, object]] = {}
for rel, expected in pins.items():
    source = ROOT / rel
    head = git(ROOT, source, "rev-parse", "HEAD")
    status = git(ROOT, source, "status", "--porcelain")
    pin_state[rel] = {"expected": expected, "head": head["stdout"].strip(), "clean": status["stdout"] == "",
                      "headCommand": head, "statusCommand": status}
    assert head["exitCode"] == 0 and status["exitCode"] == 0
    assert pin_state[rel]["head"] == expected and pin_state[rel]["clean"] is True

acceptances = []
for number in range(1, 11):
    unit = f"P00-U{number:02d}"
    path = ROOT / "evidence" / unit / "20261001-01" / "acceptance.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    acceptances.append({"unit": unit, "status": value.get("status"),
                        "path": path.relative_to(ROOT).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)})
assert all(row["status"] == "accepted" for row in acceptances), "Every P00-U01..U10 prerequisite must be accepted"

requirements_path = ROOT / "planning/Xiadie_V2_v1.1/requirements.json"
requirements = json.loads(requirements_path.read_text(encoding="utf-8"))["requirements"]
p00_musts = sorted(row["id"] for row in requirements if row.get("priority") == "must" and "P00" in row.get("stages", []))
assert p00_musts == ["R02", "R03", "R08", "R17", "R24", "R25", "R27"]
card_text = (ROOT / "planning/Xiadie_V2_v1.1/tasks/P00-U11.md").read_text(encoding="utf-8")
card_musts = [item.strip().rstrip("。. ") for item in card_text.split("**需求：**", 1)[1].splitlines()[0].split(",")]
assert "R03" not in card_musts and set(card_musts) == set(p00_musts) - {"R03"}

command_dir = OUT / "commands"
command_dir.mkdir()
records: dict[str, dict[str, object]] = {}


def run(label: str, command: list[str], timeout: int) -> dict[str, object]:
    stdout_path = command_dir / f"{label}.stdout"
    stderr_path = command_dir / f"{label}.stderr"
    started = time.monotonic()
    timed_out = False
    try:
        result = subprocess.run(command, cwd=ROOT, env=ENV, capture_output=True, timeout=timeout, check=False)
        stdout, stderr, code = result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        stdout, stderr, code, timed_out = error.stdout or b"", error.stderr or b"", None, True
    stdout_path.write_bytes(stdout)
    stderr_path.write_bytes(stderr)
    row = {"command": command, "cwd": str(ROOT), "exitCode": code, "timedOut": timed_out,
           "elapsedSeconds": round(time.monotonic() - started, 3),
           "stdout": {"path": stdout_path.relative_to(ROOT).as_posix(), "bytes": len(stdout), "sha256": sha(stdout_path)},
           "stderr": {"path": stderr_path.relative_to(ROOT).as_posix(), "bytes": len(stderr), "sha256": sha(stderr_path)}}
    records[label] = row
    write_json(command_dir / f"{label}.json", row)
    return row


def expect(label: str, condition: bool, detail: str) -> None:
    records.setdefault("assertions", {})[label] = {"passed": bool(condition), "detail": detail}


PY = sys.executable
ZCODE_COPY = ROOT / "tests/integration/P00/u07_mock_probe.py"
tsx_loader = ROOT / ".runtime/P00/zcode/source/node_modules/tsx/dist/esm/index.mjs"
assert NODE.is_file() and tsx_loader.is_file()
out_u07 = OUT / "outputs/u07-mock"
run("u07_mock", [PY, str(ZCODE_COPY), "--root", str(ROOT), "--output-dir", str(out_u07)], 240)
u07_summary_path = out_u07 / "summary-mock.json"
u07 = json.loads(u07_summary_path.read_text(encoding="utf-8")) if u07_summary_path.exists() else {}
expect("u07_mock_exit_zero", records["u07_mock"]["exitCode"] == 0, "Mock-only copied native ZCode loop completed")
expect("u07_no_global_credential_reads", u07.get("global_files_read") is False and u07.get("global_before") == [] and u07.get("global_after") == [], "The integration copy reads no global config or credential files")
expect("u07_success_failure_compact_resume_permission", bool(u07.get("passed")) and len(u07.get("results", [])) == 6 and u07.get("model_calls") == 0, "New, compact/postcompact, Read failure, denied Write and same-session resume ran with zero model calls")
u07_run = u07.get("run_id", "")
u07_requests_path = out_u07 / "runs" / u07_run / "requests.json"
u07_personal_path = out_u07 / "runtime-data" / u07_run / "personal.json"
u07_requests = json.loads(u07_requests_path.read_text(encoding="utf-8")) if u07_requests_path.exists() else []
u07_personal = json.loads(u07_personal_path.read_text(encoding="utf-8")) if u07_personal_path.exists() else {}
u07_base_url = u07_personal.get("config", {}).get("providerConfigRules", {}).get("providerRules", [{}])[0].get("config", {}).get("api", {}).get("baseUrl", "")
expect("u07_local_only_requests", bool(u07.get("passed")) and len(u07_requests) > 0 and u07.get("model_calls") == 0 and u07_base_url.startswith("http://127.0.0.1:"), "Requests use the copied probe's synthetic loopback provider; no upstream calls are possible")

out_u08 = OUT / "outputs/u08-memory"
node_loader = tsx_loader.as_uri()
run("u08_memory", [str(NODE), "--import", node_loader, "spikes/zcode-memory/probe.mjs",
                    "--root", str(ROOT), "--output-dir", str(out_u08)], 240)
u08_path = out_u08 / "probe-results.json"
u08 = json.loads(u08_path.read_text(encoding="utf-8")) if u08_path.exists() else {}
expect("u08_all_18_assertions", records["u08_memory"]["exitCode"] == 0 and u08.get("status") == "passed" and len(u08.get("assertions", {})) == 18 and all(u08.get("assertions", {}).values()), "Fresh integration output reproduced all 18 source-pinned Memory/executor assertions")
expect("u08_scope_and_permission_negative", len(u08.get("writes", [])) == 6 and all(row.get("success") is True for row in u08.get("writes", [])) and u08.get("negativeCases", {}).get("planOutsideMemory", {}).get("success") is False, "Six synthetic writes completed while Plan/out-of-memory negative was denied")

out_job_ab = OUT / "outputs/u09-job-ab"
run("u09_job_ab", [PY, "spikes/dsh-sdk/windows-job.py", "--root", str(ROOT), "--output-dir", str(out_job_ab)], 60)
job_ab_path = out_job_ab / "summary.json"
job_ab = json.loads(job_ab_path.read_text(encoding="utf-8")) if job_ab_path.exists() else {}
expect("u09_independent_jobs", records["u09_job_ab"]["exitCode"] == 0 and job_ab.get("status") == "passed" and job_ab.get("a_all_exited") is True and all(job_ab.get("b_members_alive_after_a_close", [])) and job_ab.get("b_all_exited") is True, "Closing Job A terminated A members while Job B remained alive, then closed independently")

out_detached = OUT / "outputs/u09-detached"
run("u09_detached_leaf", [PY, "spikes/dsh-sdk/job-detached-test.py", "--root", str(ROOT), "--output-dir", str(out_detached)], 45)
detached_path = out_detached / "summary.json"
detached = json.loads(detached_path.read_text(encoding="utf-8")) if detached_path.exists() else {}
expect("u09_external_job_closes_detached_leaf", records["u09_detached_leaf"]["exitCode"] == 0 and detached.get("status") == "passed" and detached.get("detached_leaf_alive_after_parent_exit") is True and detached.get("leaf_wait_after_job_close") == 0, "Detached synthetic leaf outlived its parent and was closed by the owning Job")

out_native_job = OUT / "outputs/u09-native-sdk-job"
out_native = out_native_job / "native"
driver = ROOT / "spikes/dsh-sdk/job-sdk-bootstrap.mjs"
run("u09_native_sdk_job", [PY, "spikes/dsh-sdk/windows-job.py", "--root", str(ROOT), "--output-dir", str(out_native_job),
                            "--driver", str(driver), "--driver-args", "--root", str(ROOT),
                            "--probe", str(ROOT / "spikes/dsh-sdk/probe.ts"), "--output-dir", str(out_native)], 180)
native_path = out_native / "probe.json"
native = json.loads(native_path.read_text(encoding="utf-8")) if native_path.exists() else {}
faults = {row.get("case"): row for row in native.get("protocolFaults", [])}
forced = faults.get("forced-direct-child-kill", {})
checkpoint = native.get("hostCheckpointRecovery", {})
expect("u09_native_sdk_loopback_success", records["u09_native_sdk_job"]["exitCode"] == 0 and native.get("status") == "passed_with_limit" and native.get("receiptMatched") is True and native.get("idle") is True and native.get("paidModelCalls") == 0 and native.get("actualProductRuntimeTest") is False, "Pinned DSH SDK returned receipt/idle/business result through loopback under an assigned Windows Job")
expect("u09_whole_instance_close_not_prompt_cancel", bool(forced) and forced.get("status") == "passed" and forced.get("runtimeChildExited") is True and "not per-prompt cancellation" in forced.get("interpretation", ""), "Forced case closes/reaps the whole owned runtime; no per-prompt cancellation claim")
expect("u09_completed_recovery_and_unknown_hold", checkpoint.get("completedCheckpointRecovered") is True and checkpoint.get("unknownStatePreserved") is True and checkpoint.get("providerResubmittedDuringRecovery") is False, "Completed synthetic result is read after close; unknown remains held without retry")
expect("u09_fault_cases", len(faults) >= 5 and all(case.get("status") == "passed" for case in faults.values()), "Duplicate receipt, empty final, dirty stdout, forced close and detached-child contrast retained")

out_herta = OUT / "outputs/herta-pure"
out_herta.mkdir(parents=True)
run("herta_pure_functions", [str(NODE), "--experimental-strip-types", "spikes/P00/herta-pure/poc.mjs"], 30)
herta_raw = records["herta_pure_functions"]["stdout"]
herta_bytes = (ROOT / herta_raw["path"]).read_bytes()
try:
    herta = json.loads(herta_bytes.decode("utf-8").strip().splitlines()[-1])
except (ValueError, IndexError):
    herta = {}
expect("herta_pure_function_recompute", records["herta_pure_functions"]["exitCode"] == 0 and herta.get("status") == "PASS" and herta.get("modelCalls") == 0 and herta.get("persistenceOrProductRuntime") is False and herta.get("scenarios", {}).get("recovery", {}).get("selectedAfterResume") == 2, "Fresh Herta pure-function input recomputed selection; this is not database recovery")

for name in ("u07_mock", "u08_memory", "u09_job_ab", "u09_detached_leaf", "u09_native_sdk_job", "herta_pure_functions"):
    expect(name + "_command_exit_zero", records[name]["exitCode"] == 0 and records[name]["timedOut"] is False, "Actual command completed with exit code zero")

source_files = [
    "tests/integration/P00/run.py", "tests/integration/P00/u07_mock_probe.py",
    "spikes/zcode-context/probe.py", "spikes/zcode-context/host.mjs",
    "spikes/zcode-context/plugin/hooks/context.mjs", "spikes/zcode-memory/probe.mjs",
    "spikes/dsh-sdk/probe.ts", "spikes/dsh-sdk/windows-job.py", "spikes/dsh-sdk/job-gate.mjs",
    "spikes/dsh-sdk/job-sdk-bootstrap.mjs", "spikes/dsh-sdk/job-detached-test.py",
    "spikes/P00/herta-pure/poc.mjs",
]
source_bindings = [{"path": path, "bytes": (ROOT / path).stat().st_size, "sha256": sha(ROOT / path)} for path in source_files]
inputs = ["docs/sources.lock.json", "docs/legal/reuse.md", "assets/manifest.json",
          "docs/adr/host-and-reuse.md", "evidence/P00/final-baseline-confirmation.json",
          "planning/Xiadie_V2_v1.1/requirements.json", "planning/Xiadie_V2_v1.1/tasks/P00-U11.md"]
input_bindings = [{"path": path, "bytes": (ROOT / path).stat().st_size, "sha256": sha(ROOT / path)} for path in inputs]
input_bindings.extend({"path": row["path"], "bytes": row["bytes"], "sha256": row["sha256"], "status": row["status"]} for row in acceptances)

failures = [name for name, row in records.get("assertions", {}).items() if not row["passed"]]
summary = {
    "unit": "P00-U11", "status": "passed_with_limits" if not failures else "failed",
    "baselineCommit": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, env=ENV, capture_output=True, text=True, check=False).stdout.strip(),
    "cwd": str(ROOT), "outputDir": str(OUT), "execution": "author integration replay; no commit or status-file update",
    "sourcePinsBefore": pin_state, "sourceBindings": source_bindings, "inputBindings": input_bindings,
    "requirements": {"p00Musts": p00_musts, "u11CardMusts": card_musts,
                     "cardMatrixDifference": {"omittedFromCard": ["R03"], "matrixR03Tasks": ["P00-U01", "P00-U02", "P00-U12"],
                                               "handling": "U01/U02 evidence is bound; U12 remains pending and is required before G00."}},
    "commands": records, "failures": failures, "paidModelCalls": 0,
    "networkScope": "Only 127.0.0.1 synthetic relays in ZCode/DSH fixtures; Herta pure functions have no network path.",
    "globalCredentialFilesRead": False,
    "packageOrInstallerTest": "NOT_RUN; no Windows release/package claim",
    "productImplementationStarted": False,
}
write_json(OUT / "runner-summary.json", summary)
print(json.dumps({"status": summary["status"], "failures": failures, "paidModelCalls": 0,
                  "runnerSummary": str(OUT / "runner-summary.json")}, ensure_ascii=False))
raise SystemExit(0 if summary["status"] == "passed_with_limits" else 1)
