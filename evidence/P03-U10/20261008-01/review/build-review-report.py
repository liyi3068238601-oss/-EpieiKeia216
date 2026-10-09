from __future__ import annotations
import datetime, hashlib, json, os, pathlib, subprocess

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
AUTHOR = ROOT / r".runtime\P03\worktrees\u10"
REVIEWER = ROOT / r".runtime\P03\worktrees\u10-review-20261009"
REVIEW = ROOT / r".runtime\P03\reviews\u10-independent-20261009"
EXPERIMENT = ROOT / r".runtime\P03\experiments\u10-review-20261009"
CANDIDATE = EXPERIMENT / "candidate"
AUTHOR_COMMIT = "c157967d7440e0c9d3b2b60dedd64b67b6249e71"
BASELINE_COMMIT = "f9b0a9d0d0df784daf601c717ea0f87b5a85c0f3"
NATIVE_COMMIT = "29628c9acdb81b703bbd4080c207a0e7ce5e276e"

def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()

def binding(path: pathlib.Path, root_name: str, root_path: pathlib.Path) -> dict:
    path = path.resolve()
    raw = path.read_bytes()
    return {"root": root_name, "path": path.relative_to(root_path).as_posix(),
            "bytes": len(raw), "sha256": sha(raw)}

def write_json(path: pathlib.Path, value: object) -> None:
    path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

def load(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))

def git(cwd: pathlib.Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()

author_manifest = load(AUTHOR / "evidence/P03-U10/20261008-01/manifest.json")
descriptor_path = CANDIDATE / "candidate-descriptor.json"
descriptor = load(descriptor_path)

def suite_readback(name: str) -> dict:
    suite_dir = EXPERIMENT / name
    summary_path = suite_dir / "summary.json"
    summary = load(summary_path)
    scenario_rows = []
    for scenario in summary["scenarios"]:
        memory = scenario.get("p03_memory_composition", {})
        ledger = scenario.get("ledger_verification", {})
        ui = scenario.get("actual_ui", {})
        error_banner = ui.get("error_banner") or {}
        scenario_rows.append({
            "scenario_id": scenario.get("scenario_id"),
            "passed": scenario.get("passed"),
            "exit_code": scenario.get("exit_code"),
            "synthetic_loopback_model_requests": scenario.get("model_requests"),
            "ui_passed": ui.get("passed"),
            "ui_status": ui.get("status"),
            "ui_flow": ui.get("flow"),
            "visible_error": error_banner.get("visible", False),
            "error_code": error_banner.get("error_code"),
            "memory_capture_count": memory.get("captureCount"),
            "memory_read_count": memory.get("readCount"),
            "desktop_inspector_requests": memory.get("desktopInspectorRequest"),
            "parent_audit_identity_unchanged": memory.get("parentAuditIdentityUnchanged"),
            "ledger_admission": ledger.get("admission"),
            "admitted_turns": ledger.get("admitted_turns"),
        })
    registry = summary["registry_side_effect_state"]
    closure = summary["candidate_artifact_closure_after_suite"]
    return {
        "suite": name,
        "passed": summary.get("passed"),
        "scenario_status": summary.get("scenario_status"),
        "summary_evidence": binding(summary_path, "baseline_repository", ROOT),
        "scenario_count": len(scenario_rows),
        "scenarios": scenario_rows,
        "candidate_descriptor_sha256": summary["candidate"]["descriptor_sha256"],
        "candidate_owned_files_verified": closure.get("owned_files_verified"),
        "candidate_closure_passed": closure.get("passed"),
        "execution_inputs_unchanged": summary.get("execution_unchanged"),
        "production_inputs_unchanged": summary.get("production_unchanged"),
        "registry_read_only": registry.get("readOnly"),
        "registry_unchanged_during_suite": registry.get("unchangedDuringThisSuite"),
        "real_credentials_used": summary.get("real_credentials_used"),
        "real_model_requests": summary.get("real_model_requests"),
        "external_model_requests": summary.get("external_model_requests"),
        "dsh_started": summary.get("DSH_started"),
        "dsh_process_tree_verified": summary.get("DSH_process_tree_verified"),
        "human_visual_review": summary.get("human_visual_review"),
        "visual_acceptance": summary.get("visual_acceptance"),
        "network_boundary": summary.get("network_boundary"),
    }

full = suite_readback("full")
degradation = suite_readback("degradation")
offline_dir = EXPERIMENT / "degradation/scenarios/offline"
offline_ui = load(offline_dir / "ui-result.json")
offline_scenario = load(offline_dir / "scenario-result.json")
seed_spec = load(offline_dir / "history-seed.spec.json")
history_before = (offline_dir / "ui-offline-history-before-offline.txt").read_text(encoding="utf-8")
history_after = (offline_dir / "ui-offline-history-after-offline.txt").read_text(encoding="utf-8")
cli_pids = offline_scenario.get("network_guard", {}).get("cli_spawned_pids", [])
offline_persistence = {
    "ui_status": offline_ui.get("status"),
    "settings_navigation": {k: offline_ui.get("settings_navigation", {}).get(k)
                            for k in ("back_click", "settings_closed", "workspace_visible")},
    "seeded_user_marker_present_before_and_after": (
        seed_spec["user_marker"] in history_before and seed_spec["user_marker"] in history_after),
    "seeded_assistant_marker_present_before_and_after": (
        seed_spec["assistant_marker"] in history_before and seed_spec["assistant_marker"] in history_after),
    "history_evidence": [
        binding(offline_dir / "ui-offline-history-before-offline.txt", "baseline_repository", ROOT),
        binding(offline_dir / "ui-offline-history-after-offline.txt", "baseline_repository", ROOT),
    ],
    "settings_evidence": [
        binding(offline_dir / "ui-offline-settings.txt", "baseline_repository", ROOT),
        binding(offline_dir / "ui-offline-settings-return.txt", "baseline_repository", ROOT),
    ],
    "actual_cli_child_count": len(cli_pids),
    "dsh_like_descendant_count": len(offline_scenario.get("process_evidence", {}).get("dsh_like_descendants", [])),
    "offline_error_visible": offline_ui.get("error_banner", {}).get("visible"),
    "offline_error_code": offline_ui.get("error_banner", {}).get("error_code"),
}
assert offline_persistence["seeded_user_marker_present_before_and_after"]
assert offline_persistence["seeded_assistant_marker_present_before_and_after"]

fixed_node = ROOT / r".runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe"
native_root = ROOT / r".runtime\P01\desktop-source"
node_hash = sha(fixed_node.read_bytes())
source_license = binding(native_root / "LICENSE", "baseline_repository", ROOT)
source_notice = binding(native_root / "NOTICE.md", "baseline_repository", ROOT)
candidate_license = binding(CANDIDATE / "UPSTREAM-LICENSE", "baseline_repository", ROOT)
assert source_license["sha256"] == candidate_license["sha256"]
assert git(native_root, "rev-parse", "HEAD") == NATIVE_COMMIT
assert not git(native_root, "status", "--porcelain")

workspace_integrity = {
    "schema": "p03-u10-independent-workspace-integrity/v1",
    "main_checkout": {"commit": git(ROOT, "rev-parse", "HEAD"),
                      "clean": not bool(git(ROOT, "status", "--porcelain"))},
    "author_worktree": {"commit": git(AUTHOR, "rev-parse", "HEAD"),
                        "clean": not bool(git(AUTHOR, "status", "--porcelain"))},
    "reviewer_worktree": {"commit": git(REVIEWER, "rev-parse", "HEAD"),
                         "clean": not bool(git(REVIEWER, "status", "--porcelain"))},
    "fixed_node": {"version": descriptor["nodeVersion"], "bytes": fixed_node.stat().st_size,
                   "sha256": node_hash},
    "native_source": {"commit": git(native_root, "rev-parse", "HEAD"),
                      "clean": not bool(git(native_root, "status", "--porcelain")),
                      "license": source_license, "notice": source_notice,
                      "candidate_license_copy": candidate_license,
                      "license_copy_matches": source_license["sha256"] == candidate_license["sha256"],
                      "notice_copy_matches": descriptor["upstreamNotice"]["source"]["sha256"] ==
                                             descriptor["upstreamNotice"]["copy"]["sha256"]},
}
write_json(REVIEW / "workspace-integrity.json", workspace_integrity)

qualification_paths = [
    "tests/integration/P03/project-memory-audit.mjs",
    "tests/integration/P03/project-memory-audit.test.mjs",
    "tests/integration/P03/project-memory-host.mjs",
    "tests/integration/P03/seed-memory.mjs",
    "tests/integration/P03/desktop.py",
]
audit_source = (AUTHOR / qualification_paths[0]).read_text(encoding="utf-8")
host_source = (AUTHOR / qualification_paths[2]).read_text(encoding="utf-8")
seed_source = (AUTHOR / qualification_paths[3]).read_text(encoding="utf-8")
desktop_source = (AUTHOR / qualification_paths[4]).read_text(encoding="utf-8")
audit_tests = load(REVIEW / "audit-helper-command.json")
test_lines = audit_tests["stdout"].splitlines()
audit_test_summary = {}
for label, prefix in (("tests", "ℹ tests "), ("pass", "ℹ pass "),
                      ("fail", "ℹ fail "), ("skipped", "ℹ skipped ")):
    vals = [line[len(prefix):] for line in test_lines if line.startswith(prefix)]
    if vals:
        audit_test_summary[label] = int(vals[-1])
audit_test_summary["symlink_skip_reason"] = next(
    (line.split("#", 1)[1].strip() for line in test_lines if "# symlink creation unavailable" in line),
    None)

logger_review = {
    "schema": "p03-u10-audit-identity-review/v1",
    "source_bindings": [binding(AUTHOR / p, "author_worktree", AUTHOR) for p in qualification_paths],
    "design": {
        "fixed_log_name": "p03-memory-audit.jsonl",
        "parent_seeder_exclusive_create": 'open(auditFilePath, "wx", 0o600)' in seed_source,
        "receipt_stores_node_dev_ino_decimal_strings": (
            'auditIdentity = { dev: String(info.dev), ino: String(info.ino) }' in seed_source),
        "host_validates_receipt_project_workspace_and_exact_shape": (
            'key(owner.path) !== key(path.join(owned.profileRoot, "p03-memory-audit.jsonl"))' in host_source and
            'BigInt(identity.dev)' in host_source and 'BigInt(identity.ino)' in host_source),
        "node_create_is_exclusive_append_only": "O_EXCL" in audit_source and "O_APPEND" in audit_source,
        "unknown_existing_file_refused_without_pin": (
            "An existing file without an in-process identity is deliberately refused with EEXIST" in audit_source),
        "path_descriptor_and_pin_identity_validated": (
            "pathIdentity(filename, root, pinned)" in audit_source and
            "verifyDescriptor(descriptor, profileRoot, root, filename, pinned)" in audit_source),
        "no_truncate_or_delete_in_logger": "truncate" not in audit_source.lower() and "unlink" not in audit_source.lower(),
        "python_parent_pins_its_own_full_dev_ino_pair": (
            'actual_identity = {"dev": str(audit_stat.st_dev), "ino": str(audit_stat.st_ino)}' in desktop_source and
            'actual_identity != seed_pin["auditIdentity"]' in desktop_source),
        "no_cross_runtime_dev_comparison": (
            "Python and Node expose different Windows st_dev formats" in desktop_source and
            'str(audit_stat.st_dev) != receipt["auditFile"]["identity"]["dev"]' not in desktop_source),
        "expected_multi_process_offline_cli_count": offline_persistence["actual_cli_child_count"],
        "offline_parent_identity_unchanged": offline_scenario["p03_memory_composition"]["parentAuditIdentityUnchanged"],
    },
    "explicit_fixed_node_test": {"exit_code": audit_tests["exit_code"], **audit_test_summary},
}
write_json(REVIEW / "logger-identity-review.json", logger_review)

desktop_verification = {
    "schema": "p03-u10-independent-desktop-verification/v1",
    "author_commit": AUTHOR_COMMIT,
    "baseline_commit": BASELINE_COMMIT,
    "candidate": {
        "path": str(CANDIDATE.relative_to(ROOT)).replace("\\", "/"),
        "repository_commit": descriptor["repositoryCommit"],
        "native_source_commit": descriptor["sourceCommit"],
        "node_version": descriptor["nodeVersion"],
        "descriptor_sha256": sha(descriptor_path.read_bytes()),
        "owned_files_verified": len(descriptor["artifacts"]),
        "repository_input_count": len(descriptor["repositoryInputs"]),
        "sqlite": {"package_version": descriptor["sqliteRuntime"]["packageVersion"],
                   "sqlite_version": descriptor["sqliteRuntime"]["sqliteVersion"],
                   "addon_sha256": descriptor["sqliteRuntime"]["addonSha256"],
                   "license_sha256": descriptor["sqliteRuntime"]["licenseSha256"]},
    },
    "full": full,
    "degradation": degradation,
    "offline_persistence": offline_persistence,
    "limits": {
        "provider": "synthetic loopback Native provider only; no paid model",
        "real_credentials_used": False,
        "real_model_requests": 0,
        "external_model_requests": 0,
        "dsh_started": False,
        "installed_zcode_used": False,
        "post_move_app_e2e": "NOT_RUN",
        "human_visual_review": "NOT_RUN",
        "network_boundary": "instrumented Node/Electron paths and parent-owned dynamic loopback relay; not an OS sandbox",
        "candidate_portability": "local development candidate, not a portable installer",
    },
}
assert desktop_verification["candidate"]["descriptor_sha256"] == full["candidate_descriptor_sha256"]
assert desktop_verification["candidate"]["descriptor_sha256"] == degradation["candidate_descriptor_sha256"]
write_json(REVIEW / "desktop-verification.json", desktop_verification)

def add_input(items: list, root_name: str, base: pathlib.Path, path: pathlib.Path) -> None:
    item = binding(path, root_name, base)
    key = (root_name, item["path"].casefold())
    if key not in {(x["root"], x["path"].casefold()) for x in items}:
        items.append(item)

immutable = []
for entry in descriptor["repositoryInputs"]:
    add_input(immutable, "author_worktree", AUTHOR, AUTHOR / entry["path"])
# Bind each author manifest file as frozen material, including the five scoped harness paths.
for entry in author_manifest["files"]:
    rel = entry["path"] if isinstance(entry, dict) else entry
    if isinstance(rel, str) and (AUTHOR / rel).is_file():
        add_input(immutable, "author_worktree", AUTHOR, AUTHOR / rel)
# Bind the complete prior acceptance/review set independently checked by the 35-reference audit.
reference_audit = load(REVIEW / "acceptance-reference-audit.json")
for entry in reference_audit["references"]:
    p = pathlib.Path(entry["path"])
    try:
        relative = p.relative_to(AUTHOR)
        add_input(immutable, "author_worktree", AUTHOR, p)
    except ValueError:
        try:
            relative = p.relative_to(REVIEWER)
            add_input(immutable, "author_worktree", AUTHOR, AUTHOR / relative)
        except ValueError:
            add_input(immutable, "baseline_repository", ROOT, p)
for rel in qualification_paths + [
    "tests/integration/P03/build-candidate.mjs",
    "tests/integration/P03/factory-entry.mjs",
    "tools/run-tests.mjs",
    "planning/Xiadie_V2_v1.1/tasks/P03-U10.md",
    "evidence/P03-U10/20261008-01/scope-amendment.json",
    "evidence/P03-U10/20261008-01/scope-amendment-02.json",
]:
    add_input(immutable, "author_worktree", AUTHOR, AUTHOR / rel)

for rel in [
    r".runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe",
    r".runtime\P01\desktop-source\LICENSE",
    r".runtime\P01\desktop-source\NOTICE.md",
    r"evidence\P03\status.json",
    r"planning\Xiadie_V2_v1.1\PACKAGE_MANIFEST.json",
]:
    add_input(immutable, "baseline_repository", ROOT, ROOT / rel)
zip_candidates = [p for p in ROOT.glob("*.zip") if "v1.1" in p.name]
if len(zip_candidates) == 1:
    add_input(immutable, "baseline_repository", ROOT, zip_candidates[0])
else:
    raise RuntimeError("authoritative v1.1 ZIP input not uniquely resolved")

# Safe records only: no profile DB, raw CLI output, credentials, nonce, or node_modules.
artifact_files = []
for p in sorted(REVIEW.iterdir()):
    if p.is_file() and p.name != "review-final.json":
        if p.suffix.lower() in {".json", ".py", ".md"}:
            artifact_files.append(binding(p, "review_directory", REVIEW))
artifact_external = [
    CANDIDATE / "candidate-descriptor.json",
    CANDIDATE / "UPSTREAM-LICENSE",
    EXPERIMENT / "full/summary.json",
    EXPERIMENT / "full/registry-side-effects-verification.json",
    EXPERIMENT / "full/p02-desktop-runner.json",
    EXPERIMENT / "full/p03-desktop-runner.json",
    EXPERIMENT / "degradation/summary.json",
    EXPERIMENT / "degradation/registry-side-effects-verification.json",
    EXPERIMENT / "degradation/p02-desktop-runner.json",
    EXPERIMENT / "degradation/p03-desktop-runner.json",
]
for suite_name in ("full", "degradation"):
    suite_dir = EXPERIMENT / suite_name
    summary = load(suite_dir / "summary.json")
    for scenario in summary["scenarios"]:
        d = suite_dir / "scenarios" / scenario["scenario_id"]
        for filename in ("scenario-result.json", "p03-memory-seed.json",
                         "ledger-verification.json", "ui-result.json"):
            if (d / filename).is_file():
                artifact_external.append(d / filename)
for filename in ("ui-offline-history-before-offline.txt", "ui-offline-history-after-offline.txt",
                 "ui-offline-settings.txt", "ui-offline-settings-return.txt"):
    artifact_external.append(offline_dir / filename)
for p in artifact_external:
    if p.is_file():
        artifact_files.append(binding(p, "baseline_repository", ROOT))

commands = []
command_map = [
    ("author-manifest-before", "author-verification-command.json"),
    ("author-manifest-after", "author-verification-after-command-02.json"),
    ("plan-423-raw-byte-integrity", "plan-integrity-audit-command.json"),
    ("acceptance-reference-readback", "acceptance-reference-audit-command-02.json"),
    ("canonical-prerequisite-semantics", "canonical-unit-semantic-audit-command.json"),
    ("fixed-node-typescript-build", "typescript-build-command.json"),
    ("fixed-node-audit-identity-tests", "audit-helper-command.json"),
    ("U03-U08-regression-selector", "u03-u08-regression-command.json"),
    ("U09-integration-selector", "u09-integration-command.json"),
    ("fresh-candidate-build", "candidate-build-command.json"),
    ("actual-electron-full", "desktop-full-command.json"),
    ("actual-electron-degradation", "desktop-degradation-command.json"),
]
for identifier, filename in command_map:
    row = load(REVIEW / filename)
    commands.append({"id": identifier, "argv": row.get("argv"), "cwd": row.get("cwd"),
                     "exit_code": row.get("exit_code"), "record": filename})
checks = [
    {"id": "exact-author-snapshot", "status": "pass",
     "detail": "Pre/post manifest checks found the frozen author commit, clean worktree, 340 files/341 changed paths, exact manifest size/hash, and zero raw/Git blob mismatches."},
    {"id": "fixed-toolchain-and-build", "status": "pass",
     "detail": "Fixed Node v24.14.0 hash-bound; TypeScript build exited 0; fresh candidate assembled from the exact author and pinned Native commits."},
    {"id": "audit-log-cross-process-ownership", "status": "pass",
     "detail": "Five precisely scoped qualification files add parent exclusive creation, decimal BigInt dev/ino receipt pin, exact Node reopen pin, and an independently compared full Python identity pair. Unknown existing logs remain refused; append-only checks never truncate or delete. Fixed-Node helper tests passed 11/11 with one EPERM symlink-creation skip."},
    {"id": "prior-unit-prerequisites-and-plan", "status": "pass",
     "detail": "Nine U01-U09 acceptance references and exact review targets were semantically consistent; 35 acceptance/reference files matched; the extracted v1.1 plan matched its original archive for 423/423 raw-byte entries."},
    {"id": "u03-u09-regressions", "status": "pass",
     "detail": "U03-U08 unit selector and U09 integration selector exited 0. TAP subflows remain separate; do not add nested summaries as one total. The U03 symlink case had the documented EPERM skip; U07's separate actual probe remains NOT_RUN per its accepted record."},
    {"id": "actual-electron-full", "status": "pass",
     "detail": "Fresh candidate full suite exited 0 with 3/3 scenarios passed: selected Native topic reads, unselected topic refusal, and cancellation/recovery. Parent audit identity and candidate closure were preserved."},
    {"id": "actual-electron-degradation", "status": "pass",
     "detail": "Fresh candidate degradation suite exited 0 with 3/3 scenarios passed: no-key, no-DSH, and offline request failure. Offline retained both seeded history markers before/after, returned from settings to workspace, admitted one durable failure turn after an actual synthetic loopback request, issued no memory Read, and kept the parent audit identity."},
    {"id": "scope-and-runtime-boundaries", "status": "pass",
     "detail": "No external model, paid credential, DSH process, installed ZCode, post-move app E2E, or human visual review was used; runtime network checks are not an OS sandbox."},
]
review_target = {
    "attempt": "20261008-01",
    "author_commit": AUTHOR_COMMIT,
    "baseline_commit": BASELINE_COMMIT,
    "material_commit": AUTHOR_COMMIT,
    "author_worktree": str(AUTHOR),
    "worktree": str(AUTHOR),
    "reviewer_worktree": str(REVIEWER),
    "manifest_files": author_manifest["file_count"] if "file_count" in author_manifest else 340,
    "changed_paths": 341,
    "manifest_sha256": "a6b50448111d56f59d7c070477803d6283c70e1ecc9498d4b74943ed8b35f069",
}
report = {
    "schema": "p03-independent-review/v1",
    "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "task": "P03-U10",
    "decision": "pass",
    "unit_acceptance": "not_decided",
    "reviewer": "Codex independent reviewer (/root/p03_u10_independent)",
    "scope": ("Independent exact-author-commit review of P03-U10 and G03 prerequisites. "
              "Covers author manifest/raw bytes, M1/M2/M3 acceptance boundaries and U01-U09 references, "
              "v1.1 plan archive integrity, fixed-toolchain build, five documented qualification harness paths, "
              "logger identity pin tests, U03-U09 regressions, and fresh actual Electron full plus degradation suites. "
              "This review is independent evidence only; canonical unit acceptance and G03 closure remain undecided."),
    "review_target": review_target,
    "checks": checks,
    "commands": commands,
    "reviewer_readback": {
        "main_checkout": workspace_integrity["main_checkout"],
        "author_manifest_before": load(REVIEW / "author-verification.json"),
        "author_manifest_after": load(REVIEW / "author-verification-after-02.json"),
        "reviewer_worktree": workspace_integrity["reviewer_worktree"],
        "candidate": desktop_verification["candidate"],
        "fresh_build": {"exit_code": load(REVIEW / "typescript-build-command.json")["exit_code"],
                        "fixed_node_sha256": node_hash},
        "logger_identity": logger_review,
        "u03_u08_regression_exit_code": load(REVIEW / "u03-u08-regression-command.json")["exit_code"],
        "u09_integration_exit_code": load(REVIEW / "u09-integration-command.json")["exit_code"],
        "desktop_full": full,
        "degradation": degradation,
        "offline_history_and_settings": offline_persistence,
        "plan_integrity": load(REVIEW / "plan-integrity-audit.json"),
        "acceptance_references": {
            "verified_count": reference_audit["references_verified"],
            "mismatches": reference_audit["mismatches"],
            "canonical_prior_units": load(REVIEW / "canonical-unit-semantic-audit.json"),
        },
        "m1_m2_m3": {
            "M1": "Prior U08 evidence remains byte/Git-hash based; age alone does not promote obsolete memory. This review did not infer semantic freshness from timestamps.",
            "M2": "U03/U06 accepted migration and explicit relocation/import protections were checked via exact acceptance/review bindings. Post-move app E2E remains NOT_RUN.",
            "M3": "P03 Host resolves project identity through registry but reads only the Host-selected Native topic; Native memory remains the content source and automatic Native memory writing/extraction stays disabled. Actual full UI exercised selected read and unselected denial."
        },
        "source_and_prompt_boundary": {
            "native_source_commit": NATIVE_COMMIT,
            "native_source_clean": workspace_integrity["native_source"]["clean"],
            "native_license": source_license,
            "native_notice_copy_matches": workspace_integrity["native_source"]["notice_copy_matches"],
            "tracked_prompt_template_reference": next(
                {"path": r["path"], "bytes": r["bytes"], "sha256": r["sha256"]}
                for r in reference_audit["references"] if r["kind"] == "tracked_prompt_template"),
            "original_prompt_and_role_asset_provenance_or_licensing": "NOT_VERIFIED",
        },
        "status": {"P03": "running", "G03": "pending", "accepted_prior_units": 9},
    },
    "preserved_failures": [
        {"record": r".runtime/P03/commands/u10/desktop-degradation-01.json",
         "bytes": 987, "sha256": "73b906097f5cb1dd6af1ab4721145f70e26584b85d12f20e720e4db514adbd0c",
         "detail": "Author's original actual degradation qualification failed EEXIST and had zero admitted turns; retained as failure, not upgraded."},
        {"record": r".runtime/P03/commands/u10/desktop-degradation-02.json",
         "bytes": 987, "sha256": "45d2954b92df30ed679cd444c3be3edca8a5147d0239aa7e72af98ef3c3a3b98",
         "detail": "Author's second actual degradation qualification failed EEXIST at the fresh Native CLI boundary; retained as failure, not upgraded."},
    ],
    "preserved_attempts": {
        "reviewer_acceptance_audit_01": {
            "record": "acceptance-reference-audit-command.json",
            "exit_code": 1,
            "detail": "Reviewer-only audit helper initially resolved the pinned Native source input under the author worktree. Helper path resolution was corrected; rerun verified all 35 references. No project or candidate files changed."
        },
        "reviewer_author_readback_wrapper_01": {
            "record": "author-verification-after-command.json",
            "exit_code": 1,
            "detail": "The wrapper attempted to write an already-existing verification path; verify-author refused overwrite. A new output path was used for the successful post-run check. No author file was changed."
        },
    },
    "limitations": [
        "The offline provider is a synthetic loopback Native request; no paid-model request, real credential, external model call, DSH process, or installed ZCode was used.",
        "The candidate is a local development assembly, not a portable installer; the instrumented process/network boundary is not an OS sandbox.",
        "Post-move app E2E is NOT_RUN; human visual review and visual acceptance are NOT_RUN.",
        "The original prompt and role-asset source provenance/licensing is NOT_VERIFIED.",
        "The U03 synthetic symlink creation case was skipped under Windows EPERM; the separate U07 actual probe remains NOT_RUN as recorded by its accepted evidence.",
        "The audit-helper symlink-replacement test also skipped because this host returned EPERM creating a symlink; hard-link, wrong-pin, inode replacement, EEXIST preservation, and independent-process pin cases passed.",
    ],
    "artifacts": artifact_files,
    "immutable_inputs": immutable,
    "boundary": ("Independent review pass only. The author worktree remained clean at the frozen commit and the main checkout remained clean at baseline. "
                 "No author, product, Native source, profile, global configuration, or canonical acceptance/status files were edited. "
                 "No P04 work was started."),
}
write_json(REVIEW / "review-final.json", report)
print(json.dumps({
    "report": str(REVIEW / "review-final.json"),
    "decision": report["decision"],
    "artifact_count": len(artifact_files),
    "immutable_input_count": len(immutable),
    "author_files": report["review_target"]["manifest_files"],
    "five_qualification_paths": len(qualification_paths),
    "candidate_descriptor_sha256": desktop_verification["candidate"]["descriptor_sha256"],
    "full_passed": full["passed"],
    "degradation_passed": degradation["passed"],
    "offline_history_markers": [
        offline_persistence["seeded_user_marker_present_before_and_after"],
        offline_persistence["seeded_assistant_marker_present_before_and_after"],
    ],
}))

