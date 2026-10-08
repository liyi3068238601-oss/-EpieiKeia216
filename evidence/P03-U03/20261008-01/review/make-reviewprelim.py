import datetime
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
AUTHOR = ROOT / ".runtime/P03/worktrees/u03"
REVIEW = ROOT / ".runtime/P03/reviews/u03-20261008"
BASELINE = "1326a8b036d4695271d194f3bcb1611382433303"
EXPECTED_TEST = "packages/projects/test/registry.test.mjs"
ACTUAL_TEST = "packages/projects/test/registry.test.mjs"
OUT = REVIEW / "reviewprelim.json"


def digest(path):
    raw = pathlib.Path(path).read_bytes()
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, text=True).strip()


def bind(path, root_name, base):
    path = pathlib.Path(path).resolve()
    return {"path": path.relative_to(base.resolve()).as_posix(), "root": root_name, **digest(path)}


root_head = git(ROOT, "rev-parse", "HEAD")
author_head = git(AUTHOR, "rev-parse", "HEAD")
root_status = git(ROOT, "status", "--porcelain=v1")
author_status = git(AUTHOR, "status", "--porcelain=v1")
baseline = json.loads((AUTHOR / "evidence/P03-U03/20261008-01/baseline.json").read_text(encoding="utf-8"))
test_source = AUTHOR / ACTUAL_TEST
runner = (AUTHOR / "tools/run-tests.mjs").read_text(encoding="utf-8")
configured_path_present = EXPECTED_TEST in runner and (AUTHOR / EXPECTED_TEST).exists()
current_test_exists = test_source.is_file()
build1 = json.loads((AUTHOR / "evidence/P03-U03/20261008-01/build-01-command.json").read_text(encoding="utf-8"))
build2 = json.loads((AUTHOR / "evidence/P03-U03/20261008-01/build-02-command.json").read_text(encoding="utf-8"))

assert root_head == BASELINE
assert baseline["baseline_commit"] == BASELINE
assert baseline["scope_mapping"] == [
    "packages/projects/registry.ts",
    "packages/projects/test",
    "tsconfig.json",
    "tools/run-tests.mjs",
    "evidence/P03-U03/20261008-01",
]
assert not root_status
assert current_test_exists and configured_path_present
assert build1["exit_code"] == 0 and build2["exit_code"] == 0

files = [
    (ROOT / "AGENTS.md", "baseline_repository", ROOT),
    (ROOT / "planning/Xiadie_V2_v1.1/tasks/P03-U03.md", "baseline_repository", ROOT),
    (ROOT / "planning/Xiadie_V2_v1.1/02_计划执行书.md", "baseline_repository", ROOT),
    (ROOT / "evidence/P03/status.json", "baseline_repository", ROOT),
    (AUTHOR / "docs/adr/P03-reuse.md", "author_worktree", AUTHOR),
    (AUTHOR / "packages/projects/registry.ts", "author_worktree", AUTHOR),
    (AUTHOR / ACTUAL_TEST, "author_worktree", AUTHOR),
    (AUTHOR / "tools/run-tests.mjs", "author_worktree", AUTHOR),
    (AUTHOR / "tsconfig.json", "author_worktree", AUTHOR),
    (AUTHOR / "evidence/P03-U03/20261008-01/baseline.json", "author_worktree", AUTHOR),
    (AUTHOR / "evidence/P03-U03/20261008-01/command-baseline.json", "author_worktree", AUTHOR),
    (AUTHOR / "evidence/P03-U03/20261008-01/build-01-command.json", "author_worktree", AUTHOR),
    (AUTHOR / "evidence/P03-U03/20261008-01/build-02-command.json", "author_worktree", AUTHOR),
    (ROOT / ".runtime/P01/desktop-source/apps/zcode-cli/packages/core/src/memory/project-root.ts", "baseline_repository", ROOT),
    (ROOT / ".runtime/P01/desktop-source/apps/zcode-cli/packages/bootstrap/src/app/paths.ts", "baseline_repository", ROOT),
    (AUTHOR / "packages/storage/events/src/sqlite.ts", "author_worktree", AUTHOR),
]

report = {
    "schema": "p03-u03-independent-review-preliminary/v1",
    "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "task": "P03-U03",
    "status": "preliminary",
    "decision": "not_decided",
    "review_target": {
        "baseline_commit": BASELINE,
        "author_head_snapshot": author_head,
        "author_branch": git(AUTHOR, "branch", "--show-current"),
        "author_worktree": str(AUTHOR),
        "main_head": root_head,
        "main_tree_clean": not bool(root_status),
        "author_tree_clean": not bool(author_status),
    },
    "scope": "Read-only early review of current U03 implementation and tests. This is not a final commit review or acceptance decision.",
    "findings": [
        {
            "id": "test-entrypoint-path-mismatch",
            "severity": "resolved during preliminary review",
            "status": "closed-in-current-snapshot",
            "detail": f"An earlier read found the new test under registry.behavior.test.mjs while the baseline mapping and tools/run-tests.mjs named {EXPECTED_TEST}. The author renamed the file; the configured path now exists and matches the runner. The current test file is bound below. The test itself still requires an executed command result before final review.",
            "evidence": ["tools/run-tests.mjs", "evidence/P03-U03/20261008-01/baseline.json", ACTUAL_TEST],
        },
        {
            "id": "drive-move-coverage-not-yet-present",
            "severity": "medium; resolve in final test evidence",
            "status": "coverage-gap-at-snapshot",
            "detail": "The behavior suite tests same-volume rename of a registered main repository and expects RELOCATION_REQUIRED while retaining the old mapping. It does not yet exercise the task's drive-change branch or a registered linked worktree moved to another volume and repaired with git worktree repair. The intended safe split is: known physical worktree identity yields RELOCATION_REQUIRED; an unlinked standalone copy with new Git metadata remains a separate UUID/fork and requires explicit U06 migration to carry identity.",
            "evidence": [ACTUAL_TEST],
        },
        {
            "id": "legacy-root-ownership-boundary",
            "severity": "review-note; not a blocker under current U03/U06 split",
            "status": "design-consistent-with-open-followup",
            "detail": "The implementation requires explicit adoptLegacy for a pre-existing path-key root on first registration, stores the prior Native path-memory key per workspace, and returns MEMORY_CONFLICT for a sibling worktree whose distinct legacy root differs from the canonical mapping, even when adoption is requested. That matches the coordinator's stated rule: do not silently choose or merge sibling stores; resolve ownership/export in U06. The registry stores pointers only and does not create, move, or copy Native memory bytes. A useful final regression is to confirm the prior pointer and memory tree remain unchanged on this conflict path.",
            "evidence": ["packages/projects/registry.ts", ACTUAL_TEST],
        },
        {
            "id": "sqlite-atomicity-and-mapping-only-scope",
            "severity": "reviewed",
            "status": "no-blocking-defect-seen-in-static-read",
            "detail": "Project and workspace rows are written under BEGIN IMMEDIATE in one try/rollback/commit boundary. The registry reuses the accepted P02 SQLite wrapper in a separate application-owned DB, checks application_id/user_version and integrity, and its mutation paths contain no writes to Native memory roots. The existing tests cover persisted mapping, unknown database preservation, pointer-only registration, and no partial mapping after a canonical-key conflict. Concurrent first-open initialization is not covered; if multiple application instances can initialize one directory concurrently, verify that case before treating schema creation as concurrency-safe.",
            "evidence": ["packages/projects/registry.ts", "packages/storage/events/src/sqlite.ts", ACTUAL_TEST],
        },
        {
            "id": "native-key-resolvers-and-project-identity",
            "severity": "reviewed",
            "status": "no-blocking-defect-seen-in-static-read",
            "detail": "The test harness injects the pinned Native resolveProjectMemoryRoot and projectIdFromDirectory helpers. The registry calls the memory-root helper once without workspaceIdentity to record the legacy/path key and with the generated UUID for a new canonical key; the runtime path key is kept in a separate field. Tests include a real Native runtime-key collision while ensuring distinct Git common directories receive separate Xiadie UUIDs.",
            "evidence": ["packages/projects/registry.ts", ACTUAL_TEST, ".runtime/P01/desktop-source/apps/zcode-cli/packages/core/src/memory/project-root.ts", ".runtime/P01/desktop-source/apps/zcode-cli/packages/bootstrap/src/app/paths.ts"],
        },
        {
            "id": "git-identity-and-worktree-boundaries",
            "severity": "reviewed",
            "status": "no-blocking-defect-seen-in-static-read",
            "detail": "The registry uses actual Git common/private directories, filesystem identities and the Git worktree registry back-reference. Linked worktrees of one common repository share one project mapping; independent clones/forks and complete copied repositories have distinct common-directory identities; an unregistered copy of a linked worktree is rejected. A replaced path conflicts with its prior identity. Same-volume relocation is surfaced without rewriting the old row.",
            "evidence": ["packages/projects/registry.ts", ACTUAL_TEST],
        },
    ],
    "current_validation": {
        "typescript_build_01_exit_code": build1["exit_code"],
        "typescript_build_02_exit_code": build2["exit_code"],
        "configured_test_target_exists": configured_path_present,
        "test_file_present": current_test_exists,
        "tests_executed_by_reviewer": False,
    },
    "open_before_final_review": [
        "Capture and review the actual test command and output against the now-matching test mapping.",
        "Add or document the required drive-change/repair case and its expected identity behavior.",
        "Freeze an exact author commit and clean tree, then bind the final source, test, evidence, baseline, and manifest before a pass/fail review decision.",
    ],
    "artifacts": [bind(path, root_name, base) for path, root_name, base in files],
    "snapshot_status_porcelain": author_status,
}
OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": report["status"], "finding_count": len(report["findings"]), "report": str(OUT)}))
