import hashlib
import json
import pathlib

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
REVIEW = ROOT / ".runtime/P02/reviews/u09-final"
TREE = ROOT / ".runtime/P02/worktrees/u09"
AUTHOR = "90034445be3175038e976b04211369ffada5e975"
BASELINE = "99c8702a34660f36b528efa0cca8c7257e6f98a5"
EVIDENCE = pathlib.Path("evidence/P02-U09/20261003-01")


def binding(root, base, relative):
    path = base / relative
    data = path.read_bytes()
    return {"root": root, "path": str(relative).replace("\\", "/"),
            "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


summary = [
    "# U09 independent exact-commit review",
    "",
    "Decision: **pass**",
    f"Author commit: `{AUTHOR}`; baseline: `{BASELINE}`.",
    "",
    "Verified exact manifest/scope, fixed Node 24 build, 7/7 U09 selector, 126 unchanged pre/post bindings, and two receipt/redaction counterexamples. NOT_RUN boundaries are listed in review-final.json.",
    "",
]
(REVIEW / "review-summary.md").write_text("\n".join(summary), encoding="utf-8")

author_paths = [
    "baseline.json", "command-index.json", "diff.json", "inputs-final-pre.json",
    "inputs-final-post.json", "manifest.json", "result.md", "source-decision.md",
    "commands/01-source-build.json", "commands/02-receipt-unverified-build.json",
    "commands/03-receipt-unverified-build.json", "commands/04-bind-pre.json",
    "commands/05-final-unit.json", "commands/06-bind-post.json",
    "commands/tests-01-unit-initial.json", "commands/tests-02-unit-final.json",
    "commands/tests-03-unit-default-pagination.json", "commands/tests-04-unit-receipt-unverified-page.json",
]
author_artifacts = [binding("author_worktree", TREE, EVIDENCE / item) for item in author_paths]
author_artifacts.extend([
    binding("author_worktree", TREE, pathlib.Path("packages/diagnostics/src/index.ts")),
    binding("author_worktree", TREE, pathlib.Path("packages/diagnostics/test/diagnostics.test.mjs")),
    binding("author_worktree", TREE, pathlib.Path("tools/run-tests.mjs")),
    binding("author_worktree", TREE, pathlib.Path("tsconfig.json")),
])

review_paths = [
    "author-verification.json", "audit-u09.py", "audit-results.json",
    "inputs-pre.json", "inputs-post.json",
    "build-review-final.py", "review-summary.md",
    "commands/verify-author.json", "commands/verify-author-02.json",
    "commands/bind-pre.json", "commands/build-independent.json",
    "commands/unit-independent.json", "commands/counterexamples.json",
    "commands/bind-post.json", "commands/audit-evidence.json",
    "negative-fixtures/u09-counterexamples.mjs",
]
review_artifacts = [binding("review_directory", REVIEW, pathlib.Path(item)) for item in review_paths]
for path in sorted((REVIEW / "negative-fixtures").rglob("*")):
    if path.is_file() and path.name != "u09-counterexamples.mjs":
        review_artifacts.append(binding("review_directory", REVIEW, path.relative_to(REVIEW)))

immutable_paths = [
    "AGENTS.md",
    "planning/Xiadie_V2_v1.1/tasks/P02-U09.md",
    "docs/sources.lock.json",
    "migrations/001-event-store.ts",
]
immutable_paths.extend(f"evidence/P02-U{i:02d}/20261003-01/acceptance.json" for i in range(1, 9))
immutable_inputs = [binding("baseline_repository", ROOT, pathlib.Path(item)) for item in immutable_paths]

report = {
    "schema": "p02-independent-review/v1",
    "decision": "pass",
    "task": "P02-U09",
    "review_target": {
        "author_commit": AUTHOR,
        "baseline_commit": BASELINE,
        "author_worktree": str(TREE),
    },
    "reviewer": "p02_u04_review",
    "scope": "U09 exact-commit review of bounded, redacted diagnostics and provenance summaries; no Native/Desktop integration or G02 acceptance.",
    "checks": [
        {
            "id": "exact-target-manifest-and-scope",
            "status": "pass",
            "detail": "Independent verify-author confirmed exact HEAD and clean worktree. Manifest SHA-256 a9b1f78b8e92cf12f12201bc3fd2e7d08a29c8638179af3b401b1353c941d859 covers 21 files / all 22 changed paths with zero disk/raw-Git-blob mismatches. Scope is limited to packages/diagnostics, tsconfig.json, tools/run-tests.mjs and U09 evidence; migration 001 is byte-identical to baseline.",
        },
        {
            "id": "prerequisites-source-and-history",
            "status": "pass",
            "detail": "U01-U08 acceptance records are accepted; U09 card, source lock and baseline bindings match. Ten author command records match archived originals byte-for-byte and by SHA/exit. Preserved failures include the first repair build (exit 2) and initial tests (exit 1); final source build and U09 unit suite are exit 0.",
        },
        {
            "id": "independent-build-and-selector",
            "status": "pass",
            "detail": "Using the fixed Node v24.14.0 runtime and TypeScript 6.0.2, independent tsc --project tsconfig.json exited 0; tools/run-tests.mjs unit P02-U09 exited 0 with 7 passed, 0 failed, 0 skipped. Actual argv, cwd, stdout/stderr and exit are recorded in review commands.",
        },
        {
            "id": "independent-input-bindings",
            "status": "pass",
            "detail": "Independent pre/post bindings each contain 126 inputs, explicitly including migrations/001-event-store.ts. Both match author pre/post arrays exactly and share digest eacb66d78f784afcccc7d21d185b44877be853a667ca4bd0c85ad3c4c9b76284; no execution-time drift.",
        },
        {
            "id": "receipt-and-redaction-counterexamples",
            "status": "pass",
            "detail": "Review-owned probes against real U05 SQLite data passed: when read-only queryReceipt throws, the evidence receipt is unverified, the fact scan is partial, and no raw ID/path/reason/error canary appears; same-scope evidence with a wrong operation ID or wrong toolCallId is invalid. The second probe confirms the persisted writer receipt is found with matching sequence and canonical hash.",
        },
        {
            "id": "diagnostic-contract-review",
            "status": "pass",
            "detail": "Public report construction binds all four scope fields and attempt, verifies facts against actual writer receipts, uses a closed allowlist with per-report salted references, and suppresses raw IDs, payload/text, locators, argv, hidden reasoning and exception text. Full streams are bounded to 32x256 pages and 64 MiB; partial/corrupt reads remain explicit and do not seal lifecycle. Capture source current validation stays NOT_VERIFIED; empty facts do not claim an empty conversation or Memory history.",
        },
    ],
    "limitations": [
        "NOT_RUN: U10 Native/Desktop composition, full P01 regression, installed ZCode, production data, paid models, installer/portable release and complete native dependency closure.",
        "The extra receipt-query exception is an owned adapter fault injection over actual SQLite facts; it does not claim physical database corruption. Synthetic wrong-association reports test mechanical binding only, not business truth.",
        "SQLite emitted its experimental-feature warning. The diagnostics surface is local/report-scoped; turnSeal remains unavailable and current raw-source integrity remains NOT_VERIFIED.",
        "One review helper invocation initially used a relative script path from the author worktree and exited 2; the retained record is followed by a successful absolute-path exact manifest verification. No author files were changed.",
    ],
    "artifacts": author_artifacts + review_artifacts,
    "immutable_inputs": immutable_inputs,
}

(REVIEW / "review-final.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"report": str(REVIEW / "review-final.json"), "artifact_count": len(report["artifacts"]),
                  "immutable_input_count": len(immutable_inputs)}))
