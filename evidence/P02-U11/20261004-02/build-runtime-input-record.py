import hashlib
import json
import pathlib

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
RUNS = {
    "full": ROOT / ".runtime/P02/experiments/mature-freeze/full-candidate09",
    "degradation": ROOT / ".runtime/P02/experiments/mature-freeze/degradation-candidate09",
}
OUT = pathlib.Path(__file__).with_name("runtime-input-protection.json")
DESCRIPTOR_SHA256 = "6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74"

def sha(data):
    return hashlib.sha256(data).hexdigest()

def bind(path):
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": sha(raw)}

assert not OUT.exists()
runs = {}
addon_sha = None
for suite, root in RUNS.items():
    summary_path = root / "summary.json"
    runner_path = root / "p02-desktop-runner.json"
    summary = json.loads(summary_path.read_bytes())
    runner = json.loads(runner_path.read_bytes())
    assert summary["passed"] is True and summary["suite"] == suite
    assert summary["external_model_requests"] == 0
    assert summary["real_model_requests"] == 0 and summary["real_credentials_used"] is False
    assert summary["DSH_started"] is False
    assert summary["execution_unchanged"] is True and summary["production_unchanged"] is True
    assert summary["execution_bindings_before"] == summary["execution_bindings_after"]
    assert summary["production_before"] == summary["production_after"]
    assert summary["candidate_artifact_closure_after_suite"] == {
        "passed": True,
        "owned_files_verified": 6717,
        "descriptor_sha256": DESCRIPTOR_SHA256,
    }
    assert runner["pinnedCandidateDescriptorSha256"] == DESCRIPTOR_SHA256
    assert runner["candidateArtifactClosureAfterSuite"]["passed"] is True
    assert "Electron 41.0.3 executable in ELECTRON_RUN_AS_NODE=1 app-server mode" in runner["qualificationBoundary"]
    addon = None
    for scenario in summary["scenarios"]:
        binding = scenario["sqlite_runtime_binding"]
        if binding["status"] == "not_instantiated":
            assert scenario["scenario_id"] == "disabled_native"
            continue
        assert binding["status"] == "verified_actual_cli_load"
        for probe in binding["probes"]:
            assert probe["package_version"] == "13.0.3" and probe["sqlite_version"] == "3.53.4"
            assert probe["addon_sha256"] == "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a"
            if addon_sha is None:
                addon_sha = probe["addon_sha256"]
            assert addon_sha == probe["addon_sha256"]
    runs[suite] = {
        "summary": bind(summary_path),
        "runner": bind(runner_path),
        "nativeSource": summary["native_source"],
        "executionBindings": {
            "before": summary["execution_bindings_before"],
            "after": summary["execution_bindings_after"],
            "unchanged": summary["execution_unchanged"],
        },
        "production": {
            "before": summary["production_before"],
            "after": summary["production_after"],
            "unchanged": summary["production_unchanged"],
        },
        "selectedRegistryKeys": summary["registry_side_effect_state"],
        "candidateArtifactClosureAfterSuite": summary["candidate_artifact_closure_after_suite"],
        "sqliteRuntimeBoundary": runner["qualificationBoundary"],
        "fixedNodeHelper": runner["fixedNode"],
        "scenarioCount": len(summary["scenarios"]),
        "modelRequestCount": summary["model_requests"],
        "DSHStarted": summary["DSH_started"],
        "realModelRequests": summary["real_model_requests"],
        "realCredentialsUsed": summary["real_credentials_used"],
    }

assert addon_sha == "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a"
payload = {
    "schema": "p02-u11-runtime-input-protection/v1",
    "attempt": "20261004-02",
    "candidateDescriptorSha256": DESCRIPTOR_SHA256,
    "binding": {"betterSqlite3": "13.0.3", "sqlite": "3.53.4", "windowsAddonSha256": addon_sha},
    "suiteComparisons": runs,
    "boundary": "Hashes and metadata only. No configuration/key contents copied. Candidate closure, Desktop runner qualification string, Electron CLI PID and process.dlopen addon probes are separate evidence sources; the independent Node ledger reader is readback only.",
}
OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps({"output": str(OUT), "sha256": sha(OUT.read_bytes()), "suites": list(runs)}))
