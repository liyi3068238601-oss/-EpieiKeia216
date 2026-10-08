import datetime, hashlib, json, pathlib, re

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
REVIEW = ROOT / ".runtime/P03/reviews/u09-20261008-independent"
AUTHOR = ROOT / ".runtime/P03/worktrees/u09"
REVIEW_WT = ROOT / ".runtime/P03/worktrees/u09-review-20261008-independent"
EXPERIMENT = ROOT / ".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498"
CANDIDATE = EXPERIMENT / "candidate"
DESKTOP = EXPERIMENT / "desktop-full"
AUTHOR_COMMIT = "7ceb6660381d31d267ee4fb0732879585469fa97"
BASELINE_COMMIT = "84ccbbb3735f3022f9d2075b857cae610f6199c9"
ATTEMPT = "20261008-01"
sha = lambda data: hashlib.sha256(data).hexdigest()

def read_json(path):
    return json.loads(pathlib.Path(path).read_bytes())

def bind(root_name, rel, expected=None):
    rel = pathlib.Path(rel)
    base = {"author_worktree": AUTHOR, "baseline_repository": ROOT, "review_directory": REVIEW}[root_name]
    path = base / rel
    data = path.read_bytes()
    digest = sha(data)
    if expected:
        assert len(data) == expected["bytes"], f"bytes mismatch: {root_name}:{rel}"
        assert digest == expected["sha256"], f"hash mismatch: {root_name}:{rel}"
    return {"root": root_name, "path": rel.as_posix(), "bytes": len(data), "sha256": digest}

immutable = {}
def add_input(root_name, rel, expected=None):
    item = bind(root_name, rel, expected)
    key = (item["root"], item["path"])
    if key in immutable:
        assert immutable[key] == item, f"conflicting duplicate immutable input: {key}"
    else:
        immutable[key] = item

author_before = read_json(REVIEW / "author-verification.json")
author_after = read_json(REVIEW / "author-verification-after.json")
assert author_before["author_commit"] == AUTHOR_COMMIT == author_after["author_commit"]
assert author_before["baseline_commit"] == BASELINE_COMMIT == author_after["baseline_commit"]
assert author_before["worktree_clean"] and author_after["worktree_clean"]
assert author_before["files"] == author_after["files"] == 111
assert author_before["changed_paths"] == author_after["changed_paths"] == 112
assert author_before["manifest"]["sha256"] == author_after["manifest"]["sha256"] == "934e5a5b53619cdb3eeec863c68f0d1b95c51617d6dc48d2b9979175db088471"
assert not author_before["disk_and_git_mismatches"] and not author_after["disk_and_git_mismatches"]

manifest_rel = pathlib.Path("evidence/P03-U09/20261008-01/manifest.json")
manifest = read_json(AUTHOR / manifest_rel)
for row in manifest["files"]:
    add_input("author_worktree", row["path"], row)
add_input("author_worktree", manifest_rel, {"bytes": 30675, "sha256": "934e5a5b53619cdb3eeec863c68f0d1b95c51617d6dc48d2b9979175db088471"})

for rel in [
    "evidence/P03-U09/20261008-01/result.json",
    "evidence/P03-U09/20261008-01/result.md",
    "evidence/P03-U09/20261008-01/source-adoption.json",
    "evidence/P03-U09/20261008-01/candidate-proof-index.json",
    "docs/evals/P03/coverage.md",
]:
    add_input("author_worktree", rel)
add_input("baseline_repository", "planning/Xiadie_V2_v1.1/tasks/P03-U09.md")
add_input("baseline_repository", "docs/policies/project-memory.md")

ledger = read_json(ROOT / "evidence/P03/status.json")
assert ledger["current_task"] == "P03-U09"
accepted = {}
for task in ledger["tasks"]:
    if task["id"] in {f"P03-U{i:02d}" for i in range(1, 9)}:
        assert task["status"] == "accepted", task["id"]
        accepted[task["id"]] = task["status"]
        for ref in [task["acceptance"], task["review"]["evidence"]]:
            add_input("baseline_repository", ref["path"], ref)
assert len(accepted) == 8
add_input("baseline_repository", "evidence/P03/status.json")

exec_before = read_json(REVIEW / "execution-inputs-before.json")
exec_after = read_json(REVIEW / "execution-inputs-after.json")
assert exec_before["bindings"] == exec_after["bindings"]
assert exec_before["digest"] == exec_after["digest"] == "7c721c7b4a587a8e97da6871520b6dceacca6680445069c720218b0edd096768"
assert exec_after.get("unchanged") is True
for row in exec_after["bindings"]:
    source_path = pathlib.Path(row["path"])
    try:
        rel = source_path.relative_to(REVIEW_WT)
        mirror = AUTHOR / rel
        data = mirror.read_bytes()
        assert len(data) == row["bytes"] and sha(data) == row["sha256"], f"review input not mirrored by author WT: {rel}"
        add_input("author_worktree", rel, row)
    except ValueError:
        rel = source_path.relative_to(ROOT)
        add_input("baseline_repository", rel, row)

native_readback = read_json(REVIEW / "native-accepted-read.json")
assert native_readback["commit"] == "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
assert native_readback["clean"] is True
assert native_readback["source_inputs"] == 1181
assert native_readback["compiled_outputs"] == 1163
assert native_readback["mismatches"] == []
for row in native_readback["accepted_records"]:
    add_input("baseline_repository", row["path"], row)
for rel in [
    ".runtime/P01/desktop-source/LICENSE",
    ".runtime/P01/desktop-source/NOTICE.md",
    ".runtime/P03/coord/verify-author.py",
    ".runtime/P03/coord/run-command.py",
    ".runtime/P03/coord/bind-execution.py",
    ".runtime/P03/coord/read-native-accepted.py",
    ".runtime/P03/coord/verify-review.py",
]:
    add_input("baseline_repository", rel)

desktop_summary = read_json(DESKTOP / "summary.json")
assert desktop_summary["suite"] == "full" and desktop_summary["passed"] is True
assert desktop_summary["scenario_status"] == "passed"
assert len(desktop_summary["scenarios"]) == 3
assert all(s["passed"] and s["exit_code"] == 0 for s in desktop_summary["scenarios"])
assert desktop_summary["external_model_requests"] == 0
assert desktop_summary["real_model_requests"] == 0
assert desktop_summary["real_credentials_used"] is False
assert desktop_summary["production_unchanged"] is True
assert desktop_summary["DSH_started"] is False
assert desktop_summary["human_visual_review"] == "NOT_RUN"
assert desktop_summary["visual_acceptance"] == "NOT_RUN"
closure = desktop_summary["candidate_artifact_closure_after_suite"]
assert closure["passed"] and closure["owned_files_verified"] == 6732
descriptor_raw = (CANDIDATE / "candidate-descriptor.json").read_bytes()
descriptor = json.loads(descriptor_raw)
descriptor_sha = sha(descriptor_raw)
assert descriptor_sha == "7ba4e96d5f22cc30609a492a5bf8694e17d753833cc4657ec95a56962354ca44"
assert descriptor["repositoryCommit"] == AUTHOR_COMMIT
assert descriptor["sourceCommit"] == native_readback["commit"]
assert len(descriptor["artifacts"]) == 6732
assert closure["descriptor_sha256"] == descriptor_sha
runner = read_json(DESKTOP / "p03-desktop-runner.json")
assert runner["unchanged"] is True and runner["externalModelCalls"] == 0 and runner["exitCode"] == 0
scenario_map = {s["scenario_id"]: s for s in desktop_summary["scenarios"]}
assert set(scenario_map) == {"read_success", "read_failure", "cancel_recovery"}
for name, expected_flow in [("read_success", "reply"), ("read_failure", "reply"), ("cancel_recovery", "cancel_recovery")]:
    s = scenario_map[name]
    assert s["actual_ui"]["flow"] == expected_flow
    assert s["p03_memory_composition"]["passed"] is True
    assert s["p03_memory_composition"]["observedMemoryRootsFileSetsUnchanged"] is True
    assert s["actual_ui"]["desktop"]["remote_debugging_port"] == "0"
    assert s["process_evidence"]["dsh_like_descendants"] == []
    listeners = read_json(DESKTOP / "scenarios" / name / "p03-listeners.json")
    assert listeners["fixedInspectorDisabled"] is True and listeners["desktopInspectorRequest"] == "0"
    assert listeners["relayOrigin"].startswith("http://127.0.0.1:")
assert scenario_map["read_success"]["relay_records"][-1]["p03_marker_present"] is True
assert scenario_map["read_success"]["relay_records"][-1]["p03_unselected_marker_present"] is False
assert scenario_map["read_failure"]["relay_records"][-1]["p03_permission_denied"] is True
assert scenario_map["read_failure"]["relay_records"][-1]["p03_unselected_marker_present"] is False

def artifact(root_name, rel):
    return bind(root_name, rel)

artifact_paths = [
    ("review_directory", "review-metadata.json"),
    ("review_directory", "author-verification.json"),
    ("review_directory", "author-verification-after.json"),
    ("review_directory", "typescript-build.json"),
    ("review_directory", "candidate-build.json"),
    ("review_directory", "native-accepted-read.json"),
    ("review_directory", "execution-inputs-before.json"),
    ("review_directory", "execution-inputs-after.json"),
    ("review_directory", "u09-integration-selector.json"),
    ("review_directory", "u03-u08-unit-regression.json"),
    ("review_directory", "desktop-full.json"),
    ("review_directory", "build-review-report.py"),
    ("baseline_repository", ".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498/candidate/candidate-descriptor.json"),
]
for rel in [
    ".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498/desktop-full/run-start.json",
    ".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498/desktop-full/summary.json",
    ".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498/desktop-full/p03-desktop-runner.json",
    ".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498/desktop-full/registry-side-effects-verification.json",
]:
    artifact_paths.append(("baseline_repository", rel))
for name in ["read_success", "read_failure", "cancel_recovery"]:
    prefix = f".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498/desktop-full/scenarios/{name}"
    for rel in [
        "scenario-result.json", "ui-result.json", "p03-memory-seed.json",
        "p03-listeners.json", "relay-requests.json", "ledger-verification.json",
        "profile/p03-memory-audit.jsonl", "network-guard.jsonl",
    ]:
        artifact_paths.append(("baseline_repository", f"{prefix}/{rel}"))
artifacts = [artifact(root_name, rel) for root_name, rel in artifact_paths]
artifacts.sort(key=lambda item: (item["root"], item["path"]))

def command_from_record(command_id, filename):
    rec = read_json(REVIEW / filename)
    assert rec["exit_code"] == 0, f"command failed: {filename}"
    return {
        "id": command_id, "argv": rec["argv"], "cwd": rec["cwd"],
        "exit_code": rec["exit_code"], "started_at": rec["started_at"],
        "completed_at": rec["completed_at"], "record": filename,
    }

commands = [
    command_from_record("fresh-typescript-build", "typescript-build.json"),
    command_from_record("fresh-candidate-build", "candidate-build.json"),
    command_from_record("official-u09-native-integration-selector", "u09-integration-selector.json"),
    command_from_record("official-u03-u08-unit-regression", "u03-u08-unit-regression.json"),
    command_from_record("fresh-actual-electron-desktop-full", "desktop-full.json"),
]
commands.extend([
    {"id": "verify-author-before", "argv": ["python", ".runtime/P03/coord/verify-author.py", "P03-U09", AUTHOR_COMMIT, BASELINE_COMMIT, str(AUTHOR), "--attempt", ATTEMPT, "--output", str(REVIEW / "author-verification.json")], "cwd": str(ROOT), "exit_code": 0, "record": "author-verification.json"},
    {"id": "verify-author-after", "argv": ["python", ".runtime/P03/coord/verify-author.py", "P03-U09", AUTHOR_COMMIT, BASELINE_COMMIT, str(AUTHOR), "--attempt", ATTEMPT, "--output", str(REVIEW / "author-verification-after.json")], "cwd": str(ROOT), "exit_code": 0, "record": "author-verification-after.json"},
    {"id": "native-accepted-readback-no-build", "argv": ["python", ".runtime/P03/coord/read-native-accepted.py", str(REVIEW / "native-accepted-read.json")], "cwd": str(ROOT), "exit_code": 0, "record": "native-accepted-read.json"},
    {"id": "execution-input-binding-before", "argv": ["python", ".runtime/P03/coord/bind-execution.py", str(REVIEW_WT), str(REVIEW / "execution-inputs-before.json")], "cwd": str(ROOT), "exit_code": 0, "record": "execution-inputs-before.json"},
    {"id": "execution-input-binding-after", "argv": ["python", ".runtime/P03/coord/bind-execution.py", str(REVIEW_WT), str(REVIEW / "execution-inputs-after.json"), "--compare", str(REVIEW / "execution-inputs-before.json")], "cwd": str(ROOT), "exit_code": 0, "record": "execution-inputs-after.json"},
])

unit_record = read_json(REVIEW / "u03-u08-unit-regression.json")
u09_record = read_json(REVIEW / "u09-integration-selector.json")
assert unit_record["exit_code"] == 0 and u09_record["exit_code"] == 0
u09_lines = u09_record["stdout"].splitlines()
u09_counts = {key: int(re.search(rf"ℹ {key} (\d+)", "\n".join(u09_lines)).group(1)) for key in ["tests", "pass", "fail", "skipped"]}
assert u09_counts == {"tests": 13, "pass": 13, "fail": 0, "skipped": 0}
unit_text = unit_record["stdout"]
assert "symbolic directory link (0.5859ms) # the Windows host does not allow this synthetic directory symlink" in unit_text
assert "real source write and Git commit before the final registry resolution" in unit_text
assert "repaired cross-drive linked-worktree copy requires relocation" in unit_text
assert "export round-trips the complete raw memory tree" in unit_text
assert "schema 1 migrates transactionally to schema 2" in unit_text
assert "model adapter rejects a call without the current Hook receipt" in unit_text

source_result = read_json(AUTHOR / "evidence/P03-U09/20261008-01/result.json")
assert source_result["material_commit"] == "d56d02f5b16bff2b98dcd1ca9c8adf1cf5bb420d"
assert any("post-relocation application end-to-end was NOT_RUN" in item for item in source_result["boundaries"])
coverage_text = (AUTHOR / "docs/evals/P03/coverage.md").read_text(encoding="utf-8")
assert "U09 只核验新注册 fixture 的 Native 绑定，移动后应用端到端 NOT_RUN" in coverage_text

checks = [
    {"id": "exact-author-commit-manifest-raw-bytes-and-cleanliness", "status": "pass",
     "detail": f"Independent pre/post verify-author checks confirmed clean author HEAD {AUTHOR_COMMIT}, baseline {BASELINE_COMMIT}, 111 manifest-bound files covering 112 changed paths, manifest SHA-256 934e5a5b53619cdb3eeec863c68f0d1b95c51617d6dc48d2b9979175db088471, and zero disk/Git blob mismatches. Reviewer build/tests ran in a separate detached worktree {REVIEW_WT}; the main checkout remained clean at baseline.",
     "records": ["author-verification.json", "author-verification-after.json"]},
    {"id": "accepted-u01-u08-prerequisites-m2-migration-evidence-and-authority-boundary", "status": "pass",
     "detail": "The baseline P03 status ledger and exact acceptance/review artifacts confirm U01-U08 accepted. Accepted U03/U06 reviews document actual Git/SQLite/Native resolver identity and path checks, movement/import/export, rollback and raw-byte hash evidence; this reviewer also executed the official U03-U08 regression, including U06's 24 passing migration tests. Final coverage/result correctly limit U09 Native/Desktop to newly registered UUID fixtures and mark post-relocation application end-to-end NOT_RUN. Project-memory policy keeps notes at experience-lead and does not infer owner/progress or semantic truth.",
     "records": ["evidence/P03/status.json", "evidence/P03-U03/20261008-01/acceptance.json", "evidence/P03-U03/20261008-01/review-final.json", "evidence/P03-U06/20261008-01/acceptance.json", "evidence/P03-U06/20261008-01/review-final.json", "evidence/P03-U09/20261008-01/result.json", "docs/evals/P03/coverage.md"]},
    {"id": "native-source-adoption-and-license", "status": "pass",
     "detail": "Pinned Native commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e is clean and Apache-2.0; accepted source/dist readback matched 1,181 source inputs and 1,163 compiled outputs with zero mismatches. The accepted-source readback itself did not build or launch Native; actual Native was exercised by the U09 selector and Desktop checks. The fresh candidate retained pinned LICENSE/NOTICE and notices; its owned better-sqlite3 13.0.3 package is MIT with the accepted Windows x64 addon hash.",
     "record": "native-accepted-read.json"},
    {"id": "scope-license-factual-authority-and-negative-paths", "status": "pass",
     "detail": "Static review of exact manifest-bound source/tests and project-memory policy found one Host Read path for explicitly selected Native raw bytes, no Native memory writer or second content authority, no fact promotion from memory frontmatter, and no TaskLedger/owner/progress inference. U09 Native selector exercised foreign/unselected path denials, Hook failures, source race, cancel/recovery and real owned Windows ACL denial/restoration; Desktop confirmed selected Read and unselected-topic refusal on isolated synthetic memory."},
    {"id": "fresh-typescript-build-and-candidate-build", "status": "pass",
     "detail": f"Fresh Node v24.14.0 / TypeScript 6.0.2 build exited 0 in reviewer worktree. A separate actual Desktop candidate built from {AUTHOR_COMMIT} against pinned Native; descriptor SHA-256 {descriptor_sha}, 6,732 owned files, SQLite 3.53.4 and accepted addon binding.",
     "command_records": ["typescript-build.json", "candidate-build.json"]},
    {"id": "official-u09-native-integration-selector-and-acl", "status": "pass",
     "detail": "Official integration P03-U09 exited 0: 13 passed, 0 failed/skipped. Eight actual pinned Native scenarios ran with synthetic loopback only, and three real Windows ACL parent-denial cases passed with restoration; each loopback listener was dynamic 127.0.0.1. The mockserver inbound-socket checks observed no non-loopback requests; this was not a whole-process egress audit.",
     "command_record": "u09-integration-selector.json"},
    {"id": "official-u03-u08-related-unit-regressions-including-u06", "status": "pass",
     "detail": "Official unit selectors P03-U03 through P03-U08 all ran from the fresh build and exited 0. U06 relocation/export/import/rollback/SQLite migration file reported 24 pass, 0 fail/skip. U03 registry reported 14 pass, 0 fail, 1 skip because Windows returned EPERM creating a synthetic directory symlink; junction and hard-link/path cases ran. Remaining selected unit files completed with zero failures; nested test counts are not summed with file-completion counts.",
     "command_record": "u03-u08-unit-regression.json"},
    {"id": "fresh-actual-electron-desktop-full", "status": "pass",
     "detail": f"Fresh candidate Desktop full suite exited 0 for read_success, read_failure and cancel_recovery (3/3). Actual Electron and Native CLI/Host Read used owned synthetic fixtures and parent-pinned receipts. Selected topic returned its marker; unselected topic was denied without marker leakage; cancellation recovered. Candidate descriptor {descriptor_sha} bound 6,732 files before/after each scenario. Inspector request was 0, fixed port disabled, relay used dynamic loopback, DSH descendants absent, registry side effects unchanged. External/real model requests 0 and real credentials false.",
     "command_record": "desktop-full.json"},
    {"id": "production-data-protection-and-environment", "status": "pass",
     "detail": "The Desktop runner's protection snapshot read only selected production credential/config file bytes to record sizes/SHA-256 before/after; it did not parse or print contents or pass them to the candidate. The candidate used an isolated profile and synthetic loopback authentication; the command environment was reduced to system/runtime variables and contained no inherited credential variables. Summary reports production_unchanged=true and real_credentials_used=false.",
     "record": ".runtime/P03/experiments/u09-review-9f31f01e4518464cbfc830941c345498/desktop-full/summary.json"},
    {"id": "execution-input-and-candidate-closure-stability", "status": "pass",
     "detail": f"Pre/post source/compiled/toolchain binding covered {len(exec_after['bindings'])} files with identical tuples and digest {exec_after['digest']}; all reviewer-worktree bindings matched their exact author-worktree mirror. Candidate closure stayed pinned at 6,732 files. The author manifest remained byte-identical after execution.",
     "records": ["execution-inputs-before.json", "execution-inputs-after.json", "author-verification-after.json"]},
    {"id": "not-run-boundaries-preserved", "status": "pass",
     "detail": "Human visual/screenshots NOT_RUN; no paid model, DSH, installed app, portable installer or U10 degradation; U09 uses new registered projects, so post-relocation Desktop app end-to-end is NOT_RUN. Reports and checks retain these exact boundaries.",
     "records": ["evidence/P03-U09/20261008-01/result.json", "docs/evals/P03/coverage.md"]},
]

preserved = []
for key, value in source_result.get("preserved_attempts", {}).items():
    if key in {"candidate-build-01", "integration-final-01", "parent-acl-01"}:
        preserved.append({
            "record": f"author_worktree:evidence/P03-U09/20261008-01/candidate-proof/commands/{key}.json",
            "detail": value,
        })

report = {
    "schema": "p03-independent-review/v1",
    "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "task": "P03-U09",
    "decision": "pass",
    "unit_acceptance": "not_decided",
    "reviewer": "Codex independent reviewer (/root/p03_u09_independent)",
    "scope": "Independent exact-author-commit review of P03-U09. Covers author manifest/raw bytes, fresh build, official Native selector, U03-U08 regressions, fresh actual Electron Desktop full suite, and the stated G03 M2 boundary. This is an independent review only; coordinator unit acceptance and G03 closure remain undecided.",
    "review_target": {
        "author_commit": AUTHOR_COMMIT,
        "baseline_commit": BASELINE_COMMIT,
        "author_worktree": str(AUTHOR),
        "worktree": str(AUTHOR),
        "reviewer_worktree": str(REVIEW_WT),
        "attempt": f"{ATTEMPT}; exact manifest-bound commit",
        "material_commit": source_result["material_commit"],
        "changed_paths": 112,
        "manifest_files": 111,
        "manifest_sha256": author_after["manifest"]["sha256"],
    },
    "checks": checks,
    "commands": commands,
    "reviewer_readback": {
        "author_manifest_before": {"record": "author-verification.json", "files": 111, "changed_paths": 112, "mismatches": 0, "manifest_sha256": author_before["manifest"]["sha256"]},
        "author_manifest_after": {"record": "author-verification-after.json", "files": 111, "changed_paths": 112, "mismatches": 0, "manifest_sha256": author_after["manifest"]["sha256"]},
        "fresh_build": {"record": "typescript-build.json", "exit_code": 0, "node": "v24.14.0", "typescript": "6.0.2"},
        "candidate": {"record": "candidate-build.json", "descriptor": str(CANDIDATE / "candidate-descriptor.json"), "descriptor_sha256": descriptor_sha, "artifact_count": len(descriptor["artifacts"]), "sqlite_version": descriptor["sqliteRuntime"]["sqliteVersion"], "native_commit": descriptor["sourceCommit"]},
        "native_readback": {"record": "native-accepted-read.json", "commit": native_readback["commit"], "source_inputs": 1181, "compiled_outputs": 1163, "mismatches": 0, "native_build_run": False},
        "u09_selector": {"record": "u09-integration-selector.json", "exit_code": 0, **u09_counts, "native_scenarios": 8, "acl_parent_cases": 3},
        "related_units": {"record": "u03-u08-unit-regression.json", "exit_code": 0, "selectors": ["P03-U03", "P03-U04", "P03-U05", "P03-U06", "P03-U07", "P03-U08"], "u03": {"passed": 14, "failed": 0, "skipped": 1, "skip_reason": "Windows returned EPERM for synthetic directory symlink"}, "u06": {"passed": 24, "failed": 0, "skipped": 0}},
        "desktop_full": {"record": "desktop-full.json", "summary": str(DESKTOP / "summary.json"), "passed": True, "scenario_ids": ["read_success", "read_failure", "cancel_recovery"], "external_model_requests": 0, "real_model_requests": 0, "real_credentials_used": False, "production_unchanged": True, "human_visual_review": "NOT_RUN", "candidate_descriptor_sha256": descriptor_sha, "candidate_artifact_count": 6732, "DSH_started": False},
        "execution_input_stability": {"before": "execution-inputs-before.json", "after": "execution-inputs-after.json", "bindings": len(exec_after["bindings"]), "digest": exec_after["digest"], "unchanged": True},
        "main_checkout": {"head": BASELINE_COMMIT, "clean": True},
        "reviewer_worktree": {"head": AUTHOR_COMMIT, "clean": True, "path": str(REVIEW_WT)},
        "production_protection": {"method": "raw bytes length/SHA-256 only", "parsed_or_logged_contents": False, "passed_to_candidate": False},
        "m2_boundary": "accepted U03/U06 real Git/SQLite/Native resolver movement, rollback and raw-hash evidence plus final U03-U08 regressions; U09 actual Native/Desktop only covers new registered UUID fixtures; post-relocation app end-to-end NOT_RUN.",
    },
    "preserved_failures": preserved,
    "preserved_attempts": source_result.get("preserved_attempts", {}),
    "limitations": [
        "The U03 registry selector had one Windows EPERM skip for synthetic directory-symlink creation; 14 other cases passed and junction/hard-link/path checks ran. The author report also retains its specific U07 EPERM probe as NOT_RUN.",
        "U09 Native and Desktop tests use newly registered synthetic projects. They do not prove application end-to-end behavior after project relocation; that evidence comes from accepted U03/U06 movement/rollback tests and this final related regression.",
        "Desktop model traffic used the synthetic loopback provider only. No paid model, DSH, installed ZCode app, portable installer or U10 degradation was run.",
        "Human visual review and screenshots were NOT_RUN; Desktop UI evidence is actual rendered DOM/actions and Native process/tool correlation.",
        "The candidate is a local development assembly that borrows one pinned Native dependency junction, not a portable installer or full standalone dependency closure.",
        "Network and registry protections are scoped process instrumentation and snapshots, not an OS sandbox.",
        "The mockserver inbound-socket checks observed no non-loopback requests; this was not a whole-process egress audit.",
        "Native cancellation reopen was within one process; Desktop cancel/recovery validates a fresh capture and recovery reply, with actual post-cancel Native Read covered by the Native worker scenario.",
    ],
    "artifacts": artifacts,
    "immutable_inputs": sorted(immutable.values(), key=lambda item: (item["root"], item["path"])),
    "boundary": "Independent review pass only. No author source/test files were edited, no Native build was run, no actual credential was passed to the candidate, no production source/memory/profile was modified, no installed application was stopped, and no coordinator acceptance or P03/G03 status was created.",
}
out = REVIEW / "unit-review-final.json"
temporary_out = REVIEW / "unit-review-final.json.tmp"
temporary_out.write_bytes((json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
temporary_out.replace(out)
print(json.dumps({
    "report": str(out), "bytes": out.stat().st_size, "sha256": sha(out.read_bytes()),
    "artifact_count": len(artifacts), "immutable_input_count": len(report["immutable_inputs"]),
    "accepted_prerequisites": accepted, "execution_binding_count": len(exec_after["bindings"]),
    "candidate_artifacts": len(descriptor["artifacts"]), "u09_counts": u09_counts,
}, ensure_ascii=False))
