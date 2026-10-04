import hashlib, importlib.util, json, ntpath, pathlib, re, subprocess
ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
WT = ROOT / ".runtime/P02/worktrees/mature-integration"
EVID = WT / "evidence/P02-U10/20261004-02"
CAND = ROOT / ".runtime/P02/experiments/mature-integration/candidate-09"
AUTHOR = "d0952673ed6961cacfc38edf9c39256228c7dfc8"
BASELINE = "178379a8ad9c0c27f833a412ff06f7b0095bab79"
REPO_SOURCE = "cd03ddc3a3f6f7ca67b4313e309db20db4755343"
P01_SOURCE = "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
DESCRIPTOR_SHA = "6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74"
ADDON_SHA = "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a"
CLI_SHA = "c1ef45479de62ffdc37c2e72b7d014fdb1de61d56341b216077199aaa34af1ea"

def sha(raw): return hashlib.sha256(raw).hexdigest()
def digest(path): return sha(path.read_bytes())
def under(path, root):
    resolved = pathlib.Path(path).resolve(strict=True)
    resolved.relative_to(pathlib.Path(root).resolve(strict=True))
    return resolved

def git(*args): return subprocess.check_output(["git", *args], cwd=WT)
assert git("rev-parse", "HEAD").decode().strip() == AUTHOR
assert not git("status", "--porcelain").strip()
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip() == BASELINE
assert not subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT).strip()
manifest_raw = (EVID / "manifest.json").read_bytes()
manifest = json.loads(manifest_raw)
assert manifest["baseline_commit"] == BASELINE and len(manifest["files"]) == 356
assert sha(manifest_raw) == "da87f3a845b577c890bc21232f28b2cabbf271f493dbc4f7b2f4dea1565dac4e"

descriptor_path = CAND / "candidate-descriptor.json"
descriptor_raw = descriptor_path.read_bytes()
descriptor = json.loads(descriptor_raw)
assert sha(descriptor_raw) == DESCRIPTOR_SHA
assert descriptor["sourceCommit"] == P01_SOURCE
assert descriptor["repositoryCommit"] == REPO_SOURCE
assert pathlib.Path(descriptor["assemblyRoot"]).resolve(strict=True) == CAND.resolve(strict=True)
assert len(descriptor["repositoryInputs"]) == 103 and len(descriptor["artifacts"]) == 6717
assert descriptor["sqliteRuntime"]["packageVersion"] == "13.0.3"
assert descriptor["sqliteRuntime"]["sqliteVersion"] == "3.53.4"
assert descriptor["sqliteRuntime"]["addonSha256"] == ADDON_SHA
assert pathlib.Path(descriptor["cli"]["path"]).is_file() and descriptor["cli"]["sha256"] == CLI_SHA
source_root = pathlib.Path(descriptor["sourceRoot"])
borrowed = CAND / "node_modules"
assert borrowed.is_junction() and borrowed.resolve(strict=True) == (source_root / "node_modules").resolve(strict=True)
verifier_path = WT / "tests/integration/P02/candidate-verifier.py"
spec = importlib.util.spec_from_file_location("p02_candidate_verifier_review", verifier_path)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
owned = verifier.verify_owned_artifacts(CAND, descriptor["artifacts"])
sqlite = verifier.verify_sqlite_package(CAND, descriptor["sqliteRuntime"], owned)
assert sqlite["package_files_verified"] == 26 and sqlite["package_version"] == "13.0.3"
# Bind the 103 source inputs to both the candidate source commit and final author disk bytes.
for item in descriptor["repositoryInputs"]:
    name = item["path"]
    rel = pathlib.PurePosixPath(name)
    assert rel.as_posix() == name and not rel.is_absolute() and ".." not in rel.parts and "\\" not in name
    git_bytes = subprocess.check_output(["git", "show", f"{REPO_SOURCE}:{name}"], cwd=WT)
    disk_bytes = (WT / pathlib.Path(*rel.parts)).read_bytes()
    assert len(git_bytes) == item["bytes"] and sha(git_bytes) == item["sha256"]
    assert disk_bytes == git_bytes
# Every archived proof artifact must match its source evidence bytes, without copying external inputs.
proof_index = json.loads((EVID / "candidate-proof-index.json").read_bytes())
proof_items = proof_index["artifacts"]
for item in proof_items:
    staged = under(EVID / pathlib.Path(item["path"]), EVID)
    original = pathlib.Path(item["original"])
    original = under(original, ROOT / ".runtime/P02")
    raw = staged.read_bytes()
    source_raw = original.read_bytes()
    assert len(raw) == item["bytes"] and sha(raw) == item["sha256"]
    assert raw == source_raw and len(source_raw) == item["bytes"] and sha(source_raw) == item["sha256"]
# Runtime raw sidecars: all selected copies and their original synthetic evidence are byte-identical.
raw_index_path = EVID / "runtime-raw-index.json"
raw_index = json.loads(raw_index_path.read_bytes())
assert raw_index["fileCount"] == 45 and raw_index["rawBytesVerified"] is True
assert raw_index["candidateDescriptorSha256"] == DESCRIPTOR_SHA
for key, sha_key in (("sourceStagingIndex", "sourceStagingIndexSha256"), ("sourceCommandRecord", "sourceCommandRecordSha256"), ("sourceProducerScript", "sourceProducerScriptSha256")):
    source = under(raw_index[key], ROOT / ".runtime/P02")
    assert digest(source) == raw_index[sha_key]
for item in raw_index["files"]:
    staged = under(EVID / pathlib.Path(item["path"]), EVID)
    original = under(item["original"], ROOT / ".runtime/P02")
    raw = staged.read_bytes()
    assert len(raw) == item["bytes"] and sha(raw) == item["sha256"]
    assert raw == original.read_bytes() and digest(original) == item["sha256"]
# Scenario summaries and raw runtime sidecars must bind the actual main request, CLI PID and owned addon.
all_scenarios = []
expected_protocol_subkeys = [
    r"Software\Classes\zcode", r"Software\Classes\zcode\DefaultIcon",
    r"Software\Classes\zcode\shell", r"Software\Classes\zcode\shell\open",
    r"Software\Classes\zcode\shell\open\command",
]
raw_by_original = {ntpath.normcase(ntpath.normpath(item["original"])): item for item in raw_index["files"]}
def archived_original_path(original):
    key = ntpath.normcase(ntpath.normpath(original))
    assert key in raw_by_original, original
    return EVID / pathlib.Path(raw_by_original[key]["path"])
for suite, run_dir, expected_ids in (("full", "desktop-full-candidate09", {"success","read_success","read_failure","cancel_recovery","disabled_native","pro_denied"}),
                                    ("degradation", "desktop-degradation-candidate09", {"no_key","no_dsh","offline"})):
    summary_path = EVID / f"candidate-proof/runs/{suite}/summary.json"
    summary = json.loads(summary_path.read_bytes())
    assert summary["suite"] == suite and summary["run_id"] == run_dir
    assert summary["candidate"]["descriptor_sha256"] == DESCRIPTOR_SHA
    assert summary["candidate_artifact_closure_after_suite"]["passed"] is True
    assert summary["candidate_artifact_closure_after_suite"]["owned_files_verified"] == 6717
    assert summary["registry_side_effect_state"]["keyCount"] == 9
    assert summary["registry_side_effect_state"]["preSnapshotSha256"] == summary["registry_side_effect_state"]["postSnapshotSha256"] == "f7271757a866ad841238ecad6b467c0c663c0e32c1a966976179b24e539cb9c1"
    scenarios = summary["scenarios"]
    assert {row["scenario_id"] for row in scenarios} == expected_ids
    assert all(row["passed"] is True for row in scenarios)
    assert summary["external_model_requests"] == 0
    assert sum(row["model_requests"] for row in scenarios) == summary["model_requests"]
    snapshots = {}
    for snapshot_name in ("registry-side-effects-pre.json", "registry-side-effects-post.json"):
        snapshot = json.loads(archived_original_path(ntpath.join(summary["output"], snapshot_name)).read_bytes())
        assert snapshot["access"] == "read-only" and len(snapshot["keys"]) == 9
        names = {entry["path"] for entry in snapshot["keys"]}
        expected_names = {
            r"Software\Classes\Directory\shell\ZCode.OpenInZCode",
            r"Software\Classes\Directory\shell\ZCode.OpenInZCode\command",
            r"Software\Classes\Drive\shell\ZCode.OpenInZCode",
            r"Software\Classes\Drive\shell\ZCode.OpenInZCode\command",
            *expected_protocol_subkeys,
        }
        assert names == expected_names
        assert snapshot["sha256"] == summary["registry_side_effect_state"]["preSnapshotSha256"]
        snapshots[snapshot_name] = snapshot["sha256"]
    verify_snapshot = json.loads(archived_original_path(ntpath.join(summary["output"], "registry-side-effects-verification.json")).read_bytes())
    assert verify_snapshot["readOnly"] is True and verify_snapshot["keyCount"] == 9 and verify_snapshot["unchangedDuringThisSuite"] is True
    assert verify_snapshot["preSnapshotSha256"] == snapshots["registry-side-effects-pre.json"]
    assert verify_snapshot["postSnapshotSha256"] == snapshots["registry-side-effects-post.json"]
    for row in scenarios:
        sid = row["scenario_id"]
        profile = ntpath.join(summary["output"], "scenarios", sid, "profile")
        def raw_item(suffix):
            original = ntpath.normcase(ntpath.normpath(ntpath.join(profile, suffix)))
            assert original in raw_by_original, (sid, suffix)
            item = raw_by_original[original]
            return EVID / pathlib.Path(item["path"])
        main_path = raw_item("main-process-runtime.json")
        guard_path = raw_item("registry-write-guard.jsonl")
        alias_path = raw_item("sqlite-cli-runtime-alias.json")
        main = json.loads(main_path.read_bytes())
        assert main["schemaVersion"] == 1 and main["processType"] == "browser" and type(main["pid"]) is int and main["pid"] > 0
        assert main["execPath"] == descriptor["electronPath"] and main["argv"][0] == main["execPath"]
        assert main["cwd"] == ntpath.join(profile, "process-working-directory")
        assert main["defaultApp"] is True
        assert main["argvSha256"] == sha(json.dumps(main["argv"], ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        assert main["argvEntry"] == main["argv"][1]
        assert ntpath.normcase(ntpath.normpath(main["resolvedArgvEntry"])) == ntpath.normcase(ntpath.normpath(ntpath.join(main["cwd"], main["argvEntry"])))
        assert "-r" in main["argv"] and descriptor["desktopPath"] in main["argv"]
        assert summary["registry_side_effect_state"]["unchangedDuringThisSuite"] is True
        registry = row["registry_write_guard"]
        assert registry["passed"] is True and registry["main_pid"] == main["pid"] and registry["request_count"] >= 18
        lines = [json.loads(line) for line in guard_path.read_text(encoding="utf-8").splitlines() if line]
        assert len(lines) == registry["request_count"]
        menu = protocol_reg = clear_recent = 0
        for event in lines:
            assert event["pid"] == main["pid"] and event["processType"] == main["processType"] and event["cwd"] == main["cwd"]
            kind = event["kind"]
            if kind == "blocked_reg_exe":
                args = event["rawArgv"]
                assert len(args) >= 3 and ntpath.basename(args[0]).lower() == "reg.exe" and args[1].lower() == "add"
                assert event["rawArgvSha256"] == sha(json.dumps(args, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                menu += 1
            elif kind == "blocked_default_protocol_registration":
                args = event["rawArgs"]
                assert event["method"] == "app.setAsDefaultProtocolClient" and event["blocked"] is True
                assert event["returnValue"] is False and event["returnType"] == "boolean" and event["defaultApp"] is main["defaultApp"]
                assert args == ["zcode", main["execPath"], [main["resolvedArgvEntry"]]]
                assert event["expectedRegistrySubkeys"] == expected_protocol_subkeys
                assert event["rawArgsSha256"] == sha(json.dumps(args, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                protocol_reg += 1
            elif kind == "blocked_clear_recent_documents":
                assert event["method"] == "app.clearRecentDocuments" and event["blocked"] is True
                assert event["returnType"] == "undefined" and event["rawArgs"] == []
                assert event["rawArgsSha256"] == sha(b"[]")
                clear_recent += 1
            elif kind == "blocked_default_protocol_removal":
                raise AssertionError("unexpected protocol removal request")
            else:
                raise AssertionError(f"unrecognized guard kind: {kind}")
        assert menu >= 8 and menu % 8 == 0 and protocol_reg >= 1 and clear_recent >= 1
        alias = json.loads(alias_path.read_bytes())
        cli = pathlib.Path(descriptor["cli"]["path"])
        assert alias["passed"] is True
        assert ntpath.normcase(ntpath.normpath(alias["candidate_cli_entry"])) == ntpath.normcase(ntpath.normpath(str(cli)))
        assert ntpath.normcase(ntpath.normpath(alias["alias_entry_realpath"])) == ntpath.normcase(ntpath.normpath(str(cli)))
        assert alias["entry_sha256"] == CLI_SHA
        assert alias["junction_operation"]["exit_code"] == 0
        binding = row["sqlite_runtime_binding"]
        probe_origins = [p for p in raw_index["files"] if ntpath.normcase(ntpath.normpath(p["original"])).startswith(ntpath.normcase(ntpath.normpath(ntpath.join(profile, "sqlite-runtime-probes"))))]
        if sid == "disabled_native":
            assert binding["status"] == "not_instantiated" and not binding["probes"] and not probe_origins
            assert row["model_requests"] == 2 and row["ledger_verification"]["admission"] == "ledger_absent_not_admitted_allowed"
        else:
            assert binding["status"] == "verified_actual_cli_load" and len(probe_origins) == len(binding["probes"]) > 0
            guard_pids = set(row["network_guard"]["cli_guarded_pids"])
            assert row["network_guard"]["status"] == "verified"
            for p in probe_origins:
                probe = json.loads((EVID / pathlib.Path(p["path"])).read_bytes())
                assert probe["pid"] in guard_pids and probe["pid"] != main["pid"]
                assert probe["packageVersion"] == "13.0.3" and probe["sqliteVersion"] == "3.53.4" and probe["addonSha256"] == ADDON_SHA
                expected_addon = str(CAND / "apps/zcode-cli/packages/cli/dist/node_modules/better-sqlite3/prebuilds/win32-x64.node")
                assert ntpath.normcase(ntpath.normpath(probe["addonPath"])) == ntpath.normcase(ntpath.normpath(expected_addon))
                assert any(load["pid"] == probe["pid"] and ntpath.normcase(ntpath.normpath(load["path"])) == ntpath.normcase(ntpath.normpath(expected_addon)) for load in probe["processDlopenLoads"])
        all_scenarios.append({"suite":suite,"scenario":sid,"passed":row["passed"],"mainPid":main["pid"],"cliGuardedPids":row["network_guard"]["cli_guarded_pids"],"guardRequests":len(lines),"sqliteBinding":binding["status"],"probeFiles":len(probe_origins),"modelRequests":row["model_requests"]})
# Independently check full-suite synthetic backup/restore summary and bounded registry evidence.
full = json.loads((EVID / "candidate-proof/runs/full/summary.json").read_bytes())
success = next(row for row in full["scenarios"] if row["scenario_id"] == "success")
backup = success["ledger_verification"]["backup_restore"]
assert backup["passed"] is True and backup["mode"] == "snapshot-v1-only"
assert backup["backupSha256"] == backup["restoredDatabaseSha256"]
assert backup["verification"]["integrityCheck"] == "ok" and backup["verification"]["foreignKeyCheck"] == "ok"
assert backup["verification"]["userVersion"] == backup["verification"]["schemaVersion"] == 1
# The earlier bounded independent guards can be reused only where exact current source bytes still match.
prep = ROOT / ".runtime/P02/reviews/mature-integration-u10/preparation/precheck-30c00b-20261004-0958"
post = json.loads((prep / "source-post.json").read_bytes())
current_source_checks = []
for item in post["sources"]:
    path = pathlib.Path(item["path"])
    raw = path.read_bytes()
    assert len(raw) == item["bytes"] and sha(raw) == item["sha256"] and item["matchesPre"] is True
    current_source_checks.append({"path":str(path),"bytes":len(raw),"sha256":sha(raw)})
for item in post["runtimeInputs"]:
    raw = pathlib.Path(item["path"]).read_bytes()
    assert len(raw) == item["bytes"] and sha(raw) == item["sha256"] and item["matchesPre"] is True
# Selected nine-key snapshots only describe each suite's immediate pre/post state.
result_text = (EVID / "result.md").read_text(encoding="utf-8")
assert "Native fallback 仍运行并完成两次 loopback 请求" in result_text
assert "不表示 Native 未运行" in result_text
output = {
    "schema":"p02-u10-independent-candidate-review/v1",
    "authorCommit":AUTHOR,"baselineCommit":BASELINE,"manifestSha256":sha(manifest_raw),
    "candidateDescriptorSha256":DESCRIPTOR_SHA,"candidateOwnedFilesVerified":len(owned),
    "betterSqlitePackageFilesVerified":sqlite["package_files_verified"],"betterSqliteVersion":sqlite["package_version"],
    "sqliteVersion":descriptor["sqliteRuntime"]["sqliteVersion"],"candidateNativeAddonSha256":ADDON_SHA,
    "repositoryCommitInputs":len(descriptor["repositoryInputs"]),"repositoryInputsMatchGitAndAuthorDisk":True,
    "candidateProofArtifactsByteVerified":len(proof_items),"runtimeSidecarArtifactsByteVerified":raw_index["fileCount"],
    "runtimeSourcesBound":3,"runtimeSidecarsByteIdenticalToOriginals":True,
    "scenarios":all_scenarios,
    "scenarioCounts":{"full":6,"degradation":3,"passed":9,"loopbackModelRequests":11,"externalModelRequests":0},
    "registrySnapshots":{"selectedKeyCountPerSuite":9,"suitePrePostSha256":"f7271757a866ad841238ecad6b467c0c663c0e32c1a966976179b24e539cb9c1","historicalPriorStateRecovered":False},
    "backupRestore":{"passed":True,"mode":backup["mode"],"backupAndRestoredDbSameSha256":True,"integrity":"ok","foreignKeyCheck":"ok","factCount":backup["verification"]["facts"]["count"],"observationCount":backup["verification"]["observations"]["count"],"originCount":backup["verification"]["origins"]["count"],"receiptCount":backup["verification"]["receipts"]["count"]},
    "reusedPrecheckInputsMatchFinalSources":len(current_source_checks),"precheckRuntimeInputsMatch":len(post["runtimeInputs"]),
    "boundary":"Raw candidate-09 synthetic reports and selected sidecars were hash verified. Native8/Unit161 remain historical checkpoint evidence; no UI/model/registry write was initiated by this independent review. Candidate/DB paths remain ignored experiment data and are intentionally not copied into the review archive."
}
print(json.dumps(output,ensure_ascii=False,separators=(",",":")))




