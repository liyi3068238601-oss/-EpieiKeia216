import datetime
import hashlib
import json
import pathlib
import stat
import sys

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
ATTEMPT = "20261004-02"
DESCRIPTOR_SHA256 = "6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74"
ADDON_SHA256 = "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a"
SUITES = {
    "full": (ROOT / ".runtime/P02/experiments/mature-freeze/full-candidate09",
             {"success", "read_success", "read_failure", "cancel_recovery", "disabled_native", "pro_denied"}),
    "degradation": (ROOT / ".runtime/P02/experiments/mature-freeze/degradation-candidate09",
                    {"no_key", "no_dsh", "offline"}),
}
EVIDENCE = ROOT / ".runtime/P02/worktrees/mature-freeze/evidence/P02-U11" / ATTEMPT
DEST = EVIDENCE / "runtime-raw-candidate09"
CANDIDATE = ROOT / ".runtime/P02/experiments/mature-integration/candidate-09"
DESCRIPTOR = CANDIDATE / "candidate-descriptor.json"

def sha(data):
    return hashlib.sha256(data).hexdigest()

def is_reparse(path):
    st = path.lstat()
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()) or bool(getattr(st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))

def checked_read(path, boundary):
    boundary = boundary.resolve()
    path = path.absolute()
    assert path.resolve().is_relative_to(boundary), f"escape: {path}"
    current = path
    while current != boundary.parent:
        assert not is_reparse(current), f"reparse/link: {current}"
        current = current.parent
    assert stat.S_ISREG(path.lstat().st_mode), f"not regular file: {path}"
    return path.read_bytes()

assert sha(checked_read(DESCRIPTOR, ROOT / ".runtime/P02/experiments")) == DESCRIPTOR_SHA256
assert not DEST.exists(), f"destination exists: {DEST}"
assert EVIDENCE.resolve().is_relative_to(ROOT / ".runtime/P02/worktrees/mature-freeze/evidence/P02-U11")
DEST.mkdir()
copied = []
suite_summary = []
onboarding_actions = {}

for label, (run, expected_scenarios) in SUITES.items():
    summary_bytes = checked_read(run / "summary.json", ROOT / ".runtime/P02/experiments/mature-freeze")
    summary = json.loads(summary_bytes)
    assert summary.get("passed") is True and summary.get("suite") == label
    assert summary.get("external_model_requests") == 0
    assert summary.get("execution_unchanged") is True and summary.get("production_unchanged") is True
    registry = summary.get("registry_side_effect_state", {})
    assert registry.get("keyCount") == 9 and registry.get("unchangedDuringThisSuite") is True
    assert registry.get("preSnapshotSha256") == registry.get("postSnapshotSha256")
    scenario_rows = {item["scenario_id"]: item for item in summary["scenarios"]}
    assert set(scenario_rows) == expected_scenarios, (label, sorted(scenario_rows))
    suite_summary.append({
        "suite": label, "summaryPath": str(run / "summary.json"), "summaryBytes": len(summary_bytes),
        "summarySha256": sha(summary_bytes), "scenarioCount": len(scenario_rows),
        "externalModelRequests": summary["external_model_requests"],
        "registryKeyCount": registry["keyCount"], "registryPreSha256": registry["preSnapshotSha256"],
        "registryPostSha256": registry["postSnapshotSha256"],
        "executionUnchanged": summary["execution_unchanged"], "productionUnchanged": summary["production_unchanged"]
    })
    selected = [run / f"registry-side-effects-{name}.json" for name in ("pre", "post", "verification")]
    actions = {}
    for scenario_id, row in sorted(scenario_rows.items()):
        assert row.get("passed") is True, (label, scenario_id)
        actions[scenario_id] = row.get("actual_ui", {}).get("ui_actions", [])
        result_path = run / "scenarios" / scenario_id / "scenario-result.json"
        result = json.loads(checked_read(result_path, run))
        assert result.get("passed") is True
        binding = result.get("sqlite_runtime_binding", {})
        profile = run / "scenarios" / scenario_id / "profile"
        selected.extend(profile / name for name in ("main-process-runtime.json", "registry-write-guard.jsonl", "sqlite-cli-runtime-alias.json"))
        probes_dir = profile / "sqlite-runtime-probes"
        probes = sorted(probes_dir.glob("*.json"))
        if scenario_id == "disabled_native":
            assert not probes and binding.get("status") == "not_instantiated"
            ledger = row.get("ledger_verification", {})
            assert ledger.get("admission") == "ledger_absent_not_admitted_allowed"
            assert ledger.get("admitted_turns") == 0
        else:
            assert probes and binding.get("status") == "verified_actual_cli_load", (label, scenario_id)
            for probe_path in probes:
                probe_bytes = checked_read(probe_path, run)
                probe = json.loads(probe_bytes)
                assert probe["pid"] == int(probe_path.stem)
                assert probe["addonSha256"] == ADDON_SHA256
                assert probe["packageVersion"] == "13.0.3" and probe["sqliteVersion"] == "3.53.4"
                addon = pathlib.Path(probe["addonPath"])
                assert addon.resolve().is_relative_to(CANDIDATE.resolve()), str(addon)
                assert sha(checked_read(addon, CANDIDATE)) == ADDON_SHA256
                dlopen = probe.get("processDlopenLoads", [])
                assert any(x.get("pid") == probe["pid"] and pathlib.Path(x.get("path", "")).resolve() == addon.resolve() for x in dlopen)
            selected.extend(probes)

    onboarding_actions[label] = actions
    pre = json.loads(checked_read(run / "registry-side-effects-pre.json", run))
    post = json.loads(checked_read(run / "registry-side-effects-post.json", run))
    verification = json.loads(checked_read(run / "registry-side-effects-verification.json", run))
    assert pre.get("sha256") == post.get("sha256") == registry["preSnapshotSha256"]
    assert verification.get("readOnly") is True
    assert verification.get("unchangedDuringThisSuite") is True
    assert verification.get("preSnapshotSha256") == registry["preSnapshotSha256"]
    assert verification.get("postSnapshotSha256") == registry["postSnapshotSha256"]
    for source in selected:
        data = checked_read(source, run)
        relative = pathlib.Path(label) / source.relative_to(run)
        target = DEST / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)
        copied_bytes = checked_read(target, DEST)
        assert copied_bytes == data
        copied.append({
            "source": str(source), "path": relative.as_posix(),
            "bytes": len(data), "sha256": sha(data)
        })

# The onboarding-transition timeout path remains unexercised unless its explicit UI action is observed.
timeout_marker = "observed-api-key-onboarding-transition"
assert all(timeout_marker not in action for suite in onboarding_actions.values()
           for actions in suite.values() for action in actions)

# Recheck exact source/copy bytes and candidate descriptor after all reads/copies.
for item in copied:
    original = pathlib.Path(item["source"])
    assert checked_read(original, ROOT / ".runtime/P02/experiments/mature-freeze") == checked_read(DEST / item["path"], DEST)
assert sha(checked_read(DESCRIPTOR, ROOT / ".runtime/P02/experiments")) == DESCRIPTOR_SHA256

script_bytes = pathlib.Path(__file__).read_bytes()
record = {
    "schema": "p02-u11-runtime-raw-sidecars/v1",
    "createdAtUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "attempt": ATTEMPT,
    "candidateDescriptorSha256": DESCRIPTOR_SHA256,
    "addonSha256": ADDON_SHA256,
    "addon": str(CANDIDATE / "apps/zcode-cli/packages/cli/dist/node_modules/better-sqlite3/prebuilds/win32-x64.node"),
    "binding": {"betterSqlite3": "13.0.3", "sqlite": "3.53.4", "loadProof": "Electron 41.0.3 executable with ELECTRON_RUN_AS_NODE=1; each direct process.dlopen probe is PID-bound"},
    "suites": suite_summary,
    "scenarioUiActions": onboarding_actions,
    "onboardingTimeoutFallbackObserved": False,
    "onboardingTimeoutFallbackMarker": timeout_marker,
    "files": copied,
    "fileCount": len(copied),
    "rawBytesVerified": True,
    "command": {"argv": [sys.executable, str(pathlib.Path(__file__).resolve())],
                "cwd": str(pathlib.Path.cwd()), "exitCode": 0},
    "scriptSha256": sha(script_bytes),
    "readerBoundary": "Fixed Node 24.14.0 independent ledger-reader output is not used as CLI-load proof; the actual Electron CLI PID and addon sidecars are.",
    "guardBoundary": "Main-process write guard is instrumentation, not an OS sandbox. Selected nine-key registry snapshots were unchanged across these suites. Full logs, profiles, databases, credentials and key material are excluded."
}
index = DEST / "index.json"
with index.open("xb") as output:
    output.write((json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
print(json.dumps({"destination": str(DEST), "indexSha256": sha(index.read_bytes()), "fileCount": len(copied),
                  "addonSha256": ADDON_SHA256, "candidateDescriptorSha256": DESCRIPTOR_SHA256,
                  "onboardingTimeoutFallbackObserved": False}))
