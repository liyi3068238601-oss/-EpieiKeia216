import datetime, hashlib, json, os, pathlib, subprocess, sys, collections

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
WT = ROOT / ".runtime/P02/worktrees/mature-freeze"
ATTEMPT = "20261004-02"
E = WT / "evidence/P02-U11" / ATTEMPT
REVIEW = ROOT / ".runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004"
BASE = "b95cfd2be02959dd8c390e2b141d24d1093daf81"
AUTHOR = "e11e7343e8f3dd15f7420ceb14bdf7c6e3dec241"
DESC_SHA = "6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74"
ADDON_SHA = "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a"
checks = []
mismatches = []

def check(name, ok, detail):
    checks.append({"id": name, "status": "pass" if ok else "fail", "detail": detail})
    if not ok:
        mismatches.append(name)

def readb(path):
    p = pathlib.Path(path).resolve()
    s = str(p)
    if os.name == "nt" and not s.startswith("\\\\?\\"):
        p = pathlib.Path("\\\\?\\" + s)
    return p.read_bytes()

def digest(b):
    return hashlib.sha256(b).hexdigest()

def jread(path):
    return json.loads(readb(path))

def git(*args, cwd=ROOT):
    return subprocess.check_output(["git", *args], cwd=cwd)

def rel_to_root(path):
    return pathlib.Path(path).resolve().relative_to(ROOT).as_posix()

# Exact root, author commit, manifest, clean state, and allowed scope.
root_head = git("rev-parse", "HEAD").decode().strip()
root_clean = not git("status", "--porcelain", "--untracked-files=all")
author_head = git("rev-parse", "HEAD", cwd=WT).decode().strip()
author_clean = not git("status", "--porcelain", "--untracked-files=all", cwd=WT)
check("exact-target-and-clean-worktrees", root_head == BASE and root_clean and author_head == AUTHOR and author_clean,
      f"root={root_head} clean={root_clean}; author={author_head} clean={author_clean}")
manifest_rel = f"evidence/P02-U11/{ATTEMPT}/manifest.json"
manifest_path = WT / manifest_rel
manifest_raw = readb(manifest_path)
manifest = json.loads(manifest_raw)
changed = set(git("diff", "--name-only", BASE, AUTHOR).decode().splitlines())
manifest_paths = [row["path"] for row in manifest["files"]]
scope_ok = all(p.startswith("docs/releases/0.2.0/") or p.startswith(f"evidence/P02-U11/{ATTEMPT}/") for p in changed)
coverage_ok = len(manifest_paths) == 220 and len(changed) == 221 and set(manifest_paths) == changed - {manifest_rel}
verify = jread(REVIEW / "author-verification.json")
check("manifest-scope-and-author-verifier", digest(manifest_raw) == "eaefb0ef6d844a6674959a4ae6db9e5befd4ccd9bc479fabe21dca915dceba3a" and scope_ok and coverage_ok and verify.get("disk_and_git_mismatches") == [] and verify.get("worktree_clean") is True,
      f"manifest={digest(manifest_raw)} files={len(manifest_paths)} changed_paths={len(changed)} allowed_scope={scope_ok}; verify-author files={verify.get('files')} mismatches={verify.get('disk_and_git_mismatches')}")

# Canonical prerequisite status and all plan bytes.
status_path = ROOT / "evidence/P02/status.json"
status_raw = readb(status_path)
status = json.loads(status_raw)
pre = jread(E / "prerequisite-audit.json")
tasks = {x["id"]: x for x in status["tasks"]}
ids10 = [f"P02-U{i:02d}" for i in range(1, 11)]
canonical_ok = status.get("current_task") == "P02-U11" and status.get("next_stage_started") is False and status.get("G02") == "pending_revalidation" and all(tasks[i].get("status") == "accepted" for i in ids10) and tasks["P02-U11"].get("status") == "running"
acceptance_checks = []
for task_id in ids10:
    t = tasks[task_id]
    for kind, binding in [("acceptance", t["acceptance"]), ("review", t["review"]["evidence"])]:
        raw = readb(ROOT / binding["path"])
        obj = json.loads(raw)
        ok = len(raw) == binding["bytes"] and digest(raw) == binding["sha256"]
        if kind == "acceptance":
            ok = ok and obj.get("status") == "accepted" and obj.get("author_commit") == t.get("author_commit")
        else:
            ok = ok and obj.get("decision") == "pass"
        acceptance_checks.append(ok)
status_binding = pre["status"]
status_audit_ok = status_binding["path"] == "evidence/P02/status.json" and status_binding["bytes"] == len(status_raw) and status_binding["sha256"] == digest(status_raw) and readb(WT / status_binding["path"]) == status_raw
plan_files = pre.get("plan_files", [])
plan_mismatches = []
for row in plan_files:
    b = readb(ROOT / row["path"])
    if len(b) != row["bytes"] or digest(b) != row["sha256"]:
        plan_mismatches.append(row["path"])
for key in ["plan_manifest", "source_lock", "card", "historical_g01"]:
    row = pre[key]
    b = readb(ROOT / row["path"])
    if len(b) != row["bytes"] or digest(b) != row["sha256"]:
        plan_mismatches.append(row["path"])
check("canonical-ten-prerequisites-and-plan", canonical_ok and len(acceptance_checks) == 20 and all(acceptance_checks) and status_audit_ok and pre.get("current_task") == "P02-U11" and pre.get("head") == BASE and len(plan_files) == 423 and not pre.get("plan_mismatches") and not plan_mismatches,
      f"canonical_U01-U10={sum(tasks[i].get('status') == 'accepted' for i in ids10)}/10; acceptance_review_bytes={sum(acceptance_checks)}/20; plan_files={len(plan_files)}/423; plan_mismatches={len(plan_mismatches)}; status_binding={status_audit_ok}")

# U10 material reuse: compare the 103 exact inputs to both Git commits, not the 6,717-file closure.
mat = jread(E / "candidate-material-audit.json")
descriptor_path = E / "candidate-proof/candidate-descriptor.json"
descriptor_raw = readb(descriptor_path)
desc = json.loads(descriptor_raw)
mat_inputs = mat.get("inputs", [])
desc_inputs = {x["path"]: x for x in desc.get("repositoryInputs", [])}
material_bad = []
for row in mat_inputs:
    path = row["path"]
    base_blob = git("show", f"{BASE}:{path}")
    material_blob = git("show", f"{mat['material_commit']}:{path}")
    if (not row.get("candidate_match") or not row.get("baseline_blob_match") or
        path not in desc_inputs or
        row["bytes"] != desc_inputs[path].get("bytes") or row["sha256"] != desc_inputs[path].get("sha256") or
        len(base_blob) != row["bytes"] or digest(base_blob) != row["sha256"] or
        len(material_blob) != row["bytes"] or digest(material_blob) != row["sha256"]):
        material_bad.append(path)
candidate_descriptor_actual = readb(pathlib.Path(mat["descriptor"]["path"]))
check("accepted-U10-material-103", mat.get("baseline_commit") == BASE and mat.get("material_commit") == "cd03ddc3a3f6f7ca67b4313e309db20db4755343" and mat.get("descriptor", {}).get("sha256") == DESC_SHA and digest(descriptor_raw) == DESC_SHA and digest(candidate_descriptor_actual) == DESC_SHA and len(mat_inputs) == 103 and len(desc_inputs) == 103 and mat.get("artifact_count") == 6717 and mat.get("verified_input_count") == 103 and not mat.get("mismatches") and not material_bad,
      f"inputs={len(mat_inputs)}/103 baseline/material Git blobs + descriptor matches; mismatches={len(material_bad)}; descriptor={DESC_SHA}; reused 6,717 closure from accepted U10, no full rehash")
candidate_root = pathlib.Path(desc["assemblyRoot"])
sqlite = desc["sqliteRuntime"]
def candidate_file(value):
    p = pathlib.Path(value)
    return p if p.is_absolute() else candidate_root / p
addon_path = candidate_file(sqlite["addonPath"])
license_path = candidate_file(sqlite["licensePath"])
pkg_path = candidate_file(sqlite["packageRoot"]) / "package.json"
pkg = json.loads(readb(pkg_path))
target_hashes_ok = digest(readb(addon_path)) == ADDON_SHA and digest(readb(license_path)) == sqlite["licenseSha256"] and pkg.get("version") == "13.0.3" and sqlite.get("packageVersion") == "13.0.3" and sqlite.get("sqliteVersion") == "3.53.4" and len(sqlite.get("closedFiles", [])) == 26
freeze = jread(WT / "docs/releases/0.2.0/freeze.json")
for lic in [freeze["upstream_license"], freeze["third_party_notices"]]:
    fp = candidate_file(lic["path"])
    if not fp.exists() or digest(readb(fp)) != lic["sha256"]:
        target_hashes_ok = False
check("better-addon-and-license-binding", target_hashes_ok and freeze.get("sqlite_runtime_package", {}).get("package_version") == "13.0.3" and freeze.get("sqlite_runtime_package", {}).get("sqlite_version") == "3.53.4" and freeze.get("sqlite_runtime_package", {}).get("addon_sha256") == ADDON_SHA,
      f"targeted addon/license/package and upstream notice hashes checked; package=13.0.3 SQLite=3.53.4 addon={ADDON_SHA}; closed package files={len(sqlite.get('closedFiles', []))}, no full closure rehash")

# Previous README/freeze are exact original Git blobs.
history = jread(E / "historical-release-copy.json")
history_bad = []
for item in history["files"]:
    blob = git("show", f"{item['source_commit']}:{item['source_path']}")
    blob_sha1 = git("rev-parse", f"{item['source_commit']}:{item['source_path']}").decode().strip()
    copy = readb(WT / item["target_path"])
    if (len(blob) != item["bytes"] or digest(blob) != item["sha256"] or digest(copy) != item["sha256"] or
        copy != blob or blob_sha1 != item["git_blob_sha1"] or item.get("byte_identical") is not True):
        history_bad.append(item["target_path"])
check("historical-release-byte-preservation", len(history["files"]) == 2 and not history_bad,
      f"old 20261003-01 README/freeze compared byte-for-byte with ead4b6bff78250ae9a538819062fd7cb00bd4113; mismatches={len(history_bad)}")

# Candidate proof archive and 42 raw runtime sidecars: compare every archived byte to its original source.
proof = jread(E / "candidate-proof-index.json")
proof_bad = []
for item in proof["artifacts"]:
    original = pathlib.Path(item["original"])
    source = readb(original)
    copy = readb(E / item["path"])
    if len(source) != item["bytes"] or digest(source) != item["sha256"] or copy != source:
        proof_bad.append(item["path"])
rawidx = jread(E / "runtime-raw-candidate09/index.json")
raw_bad = []
raw_paths = {}
for item in rawidx["files"]:
    source = pathlib.Path(item["source"])
    source_bytes = readb(source)
    copy_bytes = readb(E / "runtime-raw-candidate09" / item["path"])
    raw_paths[item["path"]] = item
    if len(source_bytes) != item["bytes"] or digest(source_bytes) != item["sha256"] or copy_bytes != source_bytes:
        raw_bad.append(item["path"])
raw_categories = {
    "registry_root": sum("/registry-side-effects-" in "/" + x for x in raw_paths),
    "main_snapshot": sum(x.endswith("/main-process-runtime.json") for x in raw_paths),
    "effect_log": sum(x.endswith("/registry-write-guard.jsonl") for x in raw_paths),
    "cli_alias": sum(x.endswith("/sqlite-cli-runtime-alias.json") for x in raw_paths),
    "sqlite_probe": sum("/sqlite-runtime-probes/" in "/" + x for x in raw_paths),
}
check("proof-archive-139-and-runtime-sidecars-42", len(proof["artifacts"]) == 139 and not proof_bad and rawidx.get("fileCount") == 42 and len(rawidx["files"]) == 42 and rawidx.get("rawBytesVerified") is True and not raw_bad and raw_categories == {"registry_root": 6, "main_snapshot": 9, "effect_log": 9, "cli_alias": 9, "sqlite_probe": 9},
      f"candidate reports {len(proof['artifacts'])}/139 and runtime originals {len(rawidx['files'])}/42 are byte-identical; categories={raw_categories}; mismatches={len(proof_bad)+len(raw_bad)}")

# Fresh full6 + degradation3: summary state, per-scene actual PID, alias, CLI addon and 9-key registry evidence.
suite_summaries = {}
runtime_scene_checks = []
scenario_expectations = {
    "full": {"success", "read_success", "read_failure", "cancel_recovery", "disabled_native", "pro_denied"},
    "degradation": {"no_key", "no_dsh", "offline"},
}
runtime_bad = []
for suite, expected_ids in scenario_expectations.items():
    s = jread(E / f"candidate-proof/runs/{suite}/summary.json")
    suite_summaries[suite] = s
    rows = {x["scenario_id"]: x for x in s.get("scenarios", [])}
    registry_state = s.get("registry_side_effect_state", {})
    suite_ok = (
        s.get("passed") is True and s.get("scenario_status") == "passed" and set(rows) == expected_ids and
        len(rows) == len(expected_ids) and s.get("real_model_requests") == 0 and
        s.get("external_model_requests") == 0 and s.get("real_credentials_used") is False and
        s.get("DSH_started") is False and s.get("visual_acceptance") == "NOT_RUN" and
        s.get("execution_unchanged") is True and s.get("production_unchanged") is True and
        s.get("execution_bindings_before") == s.get("execution_bindings_after") and
        s.get("production_before") == s.get("production_after") and
        s.get("candidate_artifact_closure_after_suite", {}).get("passed") is True and
        s.get("candidate_artifact_closure_after_suite", {}).get("owned_files_verified") == 6717 and
        s.get("candidate_artifact_closure_after_suite", {}).get("descriptor_sha256") == DESC_SHA and
        registry_state.get("keyCount") == 9 and registry_state.get("readOnly") is True and
        registry_state.get("unchangedDuringThisSuite") is True and
        registry_state.get("preSnapshotSha256") == registry_state.get("postSnapshotSha256")
    )
    if not suite_ok:
        runtime_bad.append(f"{suite}:summary")
    for sid in sorted(expected_ids):
        row = rows[sid]
        scenario = jread(E / f"candidate-proof/runs/{suite}/scenarios/{sid}/scenario-result.json")
        ledger = jread(E / f"candidate-proof/runs/{suite}/scenarios/{sid}/ledger-verification.json")
        prefix = f"runtime-raw-candidate09/{suite}/scenarios/{sid}/profile"
        main_rel = f"{prefix}/main-process-runtime.json"
        log_rel = f"{prefix}/registry-write-guard.jsonl"
        alias_rel = f"{prefix}/sqlite-cli-runtime-alias.json"
        main = jread(E / main_rel)
        alias = jread(E / alias_rel)
        log_raw = readb(E / log_rel)
        records = [json.loads(line) for line in log_raw.decode("utf-8").splitlines() if line]
        ui = scenario["actual_ui"]["desktop"]
        ng = scenario["network_guard"]
        binding = scenario["sqlite_runtime_binding"]
        alias_report = scenario["sqlite_cli_runtime_alias"]
        guard = scenario["registry_write_guard"]
        main_pid = main.get("pid")
        cli_pids = set(ng.get("cli_guarded_pids", []))
        loads = []
        probes_ok = True
        probe_rows = binding.get("probes", [])
        probe_files = [p for p in raw_paths if p.startswith(prefix + "/sqlite-runtime-probes/")]
        probe_by_pid = {}
        for rel in probe_files:
            probe_by_pid[int(pathlib.PurePosixPath(rel).stem)] = jread(E / f"runtime-raw-candidate09/{suite}/scenarios/{sid}/profile/sqlite-runtime-probes/{pathlib.PurePosixPath(rel).name}")
        if binding.get("status") == "not_instantiated":
            probes_ok = sid == "disabled_native" and not probe_rows and not probe_by_pid and ledger.get("admission") == "ledger_absent_not_admitted_allowed" and ledger.get("admitted_turns") == 0
        else:
            for pr in probe_rows:
                pid = pr["pid"]
                probe = probe_by_pid.get(pid)
                expected_addon = str(candidate_file(sqlite["addonPath"]))
                if (probe is None or pid not in cli_pids or pid not in set(binding.get("cli_guarded_pids", [])) or
                    probe.get("pid") != pid or probe.get("addonPath", "").casefold() != expected_addon.casefold() or
                    probe.get("addonSha256") != ADDON_SHA or probe.get("packageVersion") != "13.0.3" or
                    probe.get("sqliteVersion") != "3.53.4" or
                    not probe.get("processDlopenLoads") or
                    any(load.get("pid") != pid or load.get("path", "").casefold() != expected_addon.casefold() for load in probe["processDlopenLoads"]) or
                    pr.get("sha256") != digest(readb(E / f"runtime-raw-candidate09/{suite}/scenarios/{sid}/profile/sqlite-runtime-probes/{pid}.json"))):
                    probes_ok = False
                loads.append(pid)
        try:
            runner = jread(E / f"candidate-proof/runs/{suite}/p02-desktop-runner.json")
            runner_ok = runner.get("exitCode") == 0 and "Electron 41.0.3" in runner.get("qualificationBoundary", "") and "ELECTRON_RUN_AS_NODE=1" in runner.get("qualificationBoundary", "")
            raw_source = rawidx["files"]
            def source_rel(rel):
                destrel = rel.removeprefix("runtime-raw-candidate09/")
                match = next((x for x in raw_source if x["path"].replace("\\", "/") == destrel), None)
                return pathlib.Path(match["source"]) if match else None
            src_log = source_rel(log_rel)
            src_main = source_rel(main_rel)
            src_alias = source_rel(alias_rel)
            pids_ok = (
                main.get("processType") == "browser" and
                main_pid == ui.get("main_pid") == ng.get("main", {}).get("pid") == guard.get("main_pid") and
                guard.get("launcher_pid") != main_pid and guard.get("os_sandbox") is False and
                main.get("execPath", "").casefold() == desc.get("electronPath", "").casefold() and
                guard.get("request_count") == len(records) and len(records) == 18 and
                all(rec.get("pid") == main_pid and rec.get("kind", "").startswith("blocked_") for rec in records) and
                guard.get("blocked_requests_sha256") == digest(log_raw) and
                src_log is not None and src_main is not None and src_alias is not None and
                pathlib.Path(guard.get("raw_requests_path", "")).resolve() == src_log.resolve() and
                pathlib.Path(guard.get("main_process_snapshot_path", "")).resolve() == src_main.resolve()
            )
            alias_ok = (
                alias.get("passed") is True and alias_report.get("passed") is True and
                pathlib.Path(alias.get("alias_entry_realpath", "")).resolve().as_posix().casefold() == pathlib.Path(desc["cliEntry"]).resolve().as_posix().casefold() and
                alias.get("entry_sha256") == desc.get("cli", {}).get("sha256") and
                alias_report.get("realpath", "").casefold() == desc["cliEntry"].casefold() and
                alias_report.get("entry_sha256") == desc.get("cli", {}).get("sha256")
            )
            scenario_ok = (
                scenario.get("passed") is True and scenario.get("exit_code") == 0 and
                row.get("passed") is True and ledger.get("passed") is True and
                scenario.get("ledger_verification", {}).get("passed") is True and
                binding.get("passed") is True and
                (binding.get("status") == "not_instantiated" or binding.get("status") == "verified_actual_cli_load") and
                probes_ok and alias_ok and pids_ok and runner_ok and
                scenario.get("candidate_artifact_closure", {}).get("before_scenario", {}).get("owned_files_verified") == 6717 and
                scenario.get("candidate_artifact_closure", {}).get("after_scenario", {}).get("owned_files_verified") == 6717
            )
        except Exception as exc:
            scenario_ok = False
            pids_ok = False
            alias_ok = False
            runner_ok = False
            runtime_bad.append(f"{suite}/{sid}:exception:{type(exc).__name__}:{exc}")
        if not scenario_ok:
            runtime_bad.append(f"{suite}/{sid}:scenario")
        runtime_scene_checks.append({"suite": suite, "scenario": sid, "main_pid": main_pid,
             "launcher_pid": guard.get("launcher_pid"), "cli_guarded_pids": sorted(cli_pids),
             "probe_pids": sorted(loads), "binding": binding.get("status"), "passed": scenario_ok})
    suite_summaries[suite]["_checked_ok"] = suite_ok

# Compare copied registry snapshots at suite scope, parse the 9 read-only key records, and confirm explicit legacy-report qualification.
registry_bad = []
for suite in ["full", "degradation"]:
    pre_b = readb(E / f"runtime-raw-candidate09/{suite}/registry-side-effects-pre.json")
    post_b = readb(E / f"runtime-raw-candidate09/{suite}/registry-side-effects-post.json")
    ver = jread(E / f"runtime-raw-candidate09/{suite}/registry-side-effects-verification.json")
    snap = json.loads(pre_b)
    if pre_b != post_b or len(snap.get("keys", [])) != 9 or ver.get("readOnly") is not True or ver.get("keyCount") != 9 or ver.get("unchangedDuringThisSuite") is not True or ver.get("preSnapshotSha256") != ver.get("postSnapshotSha256"):
        registry_bad.append(suite)
reader = jread(E / "candidate-proof/runs/full/scenarios/success/ledger-verification.json")
known = freeze.get("known_qualification_text_limitations", [])
legacy_note_ok = ("fixed Node CLI" in reader.get("qualificationBoundary", "") and
                  any(x.get("field") == "qualificationBoundary" and "not used to identify" in x.get("note", "") for x in known))
rawidx_ok = rawidx.get("onboardingTimeoutFallbackObserved") is False and all(
    rawidx.get("onboardingTimeoutFallbackMarker") not in actions
    for suite_map in rawidx.get("scenarioUiActions", {}).values() for actions in suite_map.values())
check("fresh-nine-scenarios-PID-addon-alias-guard-and-registry", len(runtime_scene_checks) == 9 and all(x["passed"] for x in runtime_scene_checks) and not runtime_bad and not registry_bad and legacy_note_ok and rawidx_ok,
      f"scenarios={sum(x['passed'] for x in runtime_scene_checks)}/9; PID/main/launcher/CLI addon/alias checks passed; probe PIDs={sum(len(x['probe_pids']) for x in runtime_scene_checks)}; nine-key pre/post unchanged; legacy reader wording explicitly disqualified; onboarding fallback observed={rawidx.get('onboardingTimeoutFallbackObserved')}")

# Commands and failure retention.
cmdidx = jread(E / "command-index.json")
cmd_bad = []
nonzero = []
for c in cmdidx["commands"]:
    raw = readb(E / c["path"])
    x = json.loads(raw)
    if len(raw) != c["bytes"] or digest(raw) != c["sha256"] or x.get("exit_code") != c.get("exit_code"):
        cmd_bad.append(c["path"])
    if c.get("exit_code") != 0:
        nonzero.append({"path": c["path"], "exit_code": c["exit_code"]})
cmd17 = E / "commands/17-write-release-proof-final-command.json"
check("command-records-and-preserved-failures", not cmd_bad and len(cmdidx["commands"]) == 16 and len(nonzero) >= 1 and cmd17.exists() and any(x["path"] == "commands/17-write-release-proof-final-command.json" for x in manifest_paths),
      f"indexed commands={len(cmdidx['commands'])}; failures retained={len(nonzero)}; final self-reference-excluded generator record is in manifest; mismatches={len(cmd_bad)}")

# Documentation: accepted/pending boundary, source hashes, requirements, licenses, and explicit limits.
readme_raw = readb(WT / "docs/releases/0.2.0/README.md")
freeze_raw = readb(WT / "docs/releases/0.2.0/freeze.json")
result_raw = readb(E / "result.md")
source_raw = readb(E / "source-decision.md")
rollback_raw = readb(E / "rollback.md")
req_raw = readb(WT / "docs/evals/P02/requirement-evidence.md")
texts = [x.decode("utf-8") for x in [readme_raw, freeze_raw, result_raw, source_raw, rollback_raw, req_raw]]
readme, freeze_text, result_text, source_text, rollback_text, req_text = texts
input_groups = freeze.get("input_groups", {})
doc_ok = (
    freeze.get("attempt") == ATTEMPT and freeze.get("baseline_commit") == BASE and
    freeze.get("accepted") is False and freeze.get("G02") == "pending_independent_acceptance" and freeze.get("next_stage_started") is False and
    set(freeze.get("requirement_mapping", {})) == {"R03", "R04", "R05", "R24"} and
    freeze.get("repository_input_count") == 103 and freeze.get("artifact_count") == 6717 and
    sum(group.get("count", 0) for group in input_groups.values()) == 103 and
    "Electron 41.0.3" in readme and "ELECTRON_RUN_AS_NODE=1" in readme and "Node 24.14.0" in readme and "node:sqlite" in readme and "sandbox" in readme.lower() and
    "ready_for_review" in result_text and "accepted:false" in result_text and "P03 has not started" in result_text and
    "fixed Node CLI" in result_text and "new onboarding-timeout fallback" in result_text and
    "Native itself remains on node:sqlite" in freeze.get("native_storage_boundary", "") and
    "fixed Node CLI" in reader.get("qualificationBoundary", "") and legacy_note_ok and
    freeze.get("sqlite_runtime_package", {}).get("package_version") == "13.0.3" and
    freeze.get("sqlite_runtime_package", {}).get("sqlite_version") == "3.53.4" and
    all(t.encode("utf-8").decode("utf-8") == t for t in texts)
)
check("release-docs-and-support-limits", doc_ok,
      f"README/freeze/result/source-decision/rollback/requirement evidence are valid UTF-8 and bind P02 source/prompt/schema/requirements, Better license/notices, pending G02, Electron/Node distinction, not-OS-sandbox and untested limits; input-group count={sum(x.get('count',0) for x in input_groups.values())}")
check("P03-not-started-and-no-reviewer-reruns", status.get("next_stage_started") is False and "P03 has not started" in result_text and not any("run-tests.mjs" in str(json.loads(readb(E / c["path"])).get("argv", [])) or "native.integration.test" in str(json.loads(readb(E / c["path"])).get("argv", [])) for c in cmdidx["commands"]),
      "No unit161/Native8 rerun is recorded for this attempt; new full6/degradation3 were the required candidate suites.")

report = {
    "schema": "p02-u11-independent-readback/v1",
    "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "task": "P02-U11",
    "attempt": ATTEMPT,
    "author_commit": AUTHOR,
    "baseline_commit": BASE,
    "author_worktree": str(WT),
    "manifest_sha256": digest(manifest_raw),
    "manifest_files": len(manifest_paths),
    "changed_paths": len(changed),
    "decision": "pass" if not mismatches else "block",
    "checks": checks,
    "runtime_scenarios": runtime_scene_checks,
    "candidate_proof_archive": {"files": len(proof["artifacts"]), "byte_mismatches": proof_bad},
    "runtime_raw_sidecars": {"files": len(rawidx["files"]), "categories": raw_categories, "byte_mismatches": raw_bad},
    "command_failures_preserved": nonzero,
    "limitations": [
        "Main-process effect guard is instrumentation, not an OS sandbox.",
        "disabled_native means the P02 durable wrapper is not instantiated; its two loopback requests are Native fallback, not P02 ledger facts.",
        "The independent ledger reader retains its legacy fixed-Node-CLI wording, explicitly excluded from actual CLI identity evidence.",
        "Candidate-09 onboarding timeout fallback was not observed in this attempt.",
        "No unit161, Native8, extra UI, model, DSH, registry mutation, or source modification was performed by this reviewer."
    ],
    "mismatches": mismatches
}
out = REVIEW / "readback-audit.json"
assert not out.exists(), f"refusing to overwrite {out}"
out.write_bytes((json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
print(json.dumps({"decision": report["decision"], "checks": [{"id": c["id"], "status": c["status"]} for c in checks],
                  "manifest_files": len(manifest_paths), "changed_paths": len(changed),
                  "proof_archive_files": len(proof["artifacts"]), "runtime_sidecars": len(rawidx["files"]),
                  "scenario_passes": sum(x["passed"] for x in runtime_scene_checks), "mismatches": mismatches,
                  "report": str(out)}))
