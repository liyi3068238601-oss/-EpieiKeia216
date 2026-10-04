import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
REVIEW = ROOT / ".runtime/P02/reviews/mature-sqlite-backup-u08"
AUTHOR = ROOT / ".runtime/P02/worktrees/mature-sqlite-backup"
AUTHOR_COMMIT = "3d8e45d4e468dc1e932b01a2711496527600e619"
BASELINE_COMMIT = "325707b4725f13c10ea0695f825c913c2043ee99"
MANIFEST_SHA = "deb937eafdb3fe49f01033d6c885e6667997b7ca22629234f8ad6462fce2105d"

author_pre = json.loads((REVIEW / "author-verify-independent.json").read_bytes())
author_post = json.loads((REVIEW / "author-verify-post.json").read_bytes())
state = json.loads((REVIEW / "state-comparison.json").read_bytes())
negatives = json.loads((REVIEW / "negative-results.json").read_bytes())
check_records = [
    json.loads((REVIEW / "commands/01-typecheck-noemit.json").read_bytes()),
    json.loads((REVIEW / "commands/02-build.json").read_bytes()),
    json.loads((REVIEW / "commands/04-targeted-U08-U05.json").read_bytes()),
    json.loads((REVIEW / "commands/06-negative-cases-rerun.json").read_bytes()),
]
assert author_pre["manifest"]["sha256"] == MANIFEST_SHA and author_post["manifest"]["sha256"] == MANIFEST_SHA
assert author_pre["disk_and_git_mismatches"] == [] and author_post["disk_and_git_mismatches"] == []
assert author_pre["worktree_clean"] and author_post["worktree_clean"]
assert state["allPass"] is True
assert all(item["exitCode"] == 0 for item in check_records[:3])
assert check_records[3]["exitCode"] == 0
assert [case["status"] for case in negatives["cases"]] == ["pass", "pass"]
assert len(negatives["cases"]) == 2

review_md = """# P02-U08 independent review

Decision: pass. Reviewed the frozen author commit `3d8e45d4e468dc1e932b01a2711496527600e619` against baseline `325707b4725f13c10ea0695f825c913c2043ee99`; author manifest SHA-256 `deb937eafdb3fe49f01033d6c885e6667997b7ca22629234f8ad6462fce2105d` covers 23 content files and 24 changed paths. Pre- and post-run `verify-author.py` checks both report a clean worktree and no disk/Git mismatch.

Using the pinned Node v24.14.0 executable, direct TypeScript no-emit check and build passed. Independent `unit P02-U08 P02-U05` passed 31/31 tests. This review did not rerun the author's complete suite; the frozen author record reports 161/161. The initial selector `P02-U08 P02-U07` produced 29 passing tests and was superseded because the requested fresh scope is backup plus events. The initial reviewer negative harness also stopped at a reviewer-only field-path assertion after product conflict/validation assertions had passed; the corrected harness used new reviewer-owned fixtures and both negative cases passed.

Both product transfer sites check `performance.now()` after the returned backup promise resolves (`packages/storage/backup/src/index.ts:183-194` and `:355-367`). The two fresh U08 regressions wrap the real Better SQLite transfer, delay its resolved promise by 300 ms against a 250 ms deadline, and verify that the backup is not published or migrated and that restore does not publish `events.sqlite`. The pinned upstream implementation resolves the zero-remaining-pages transfer before invoking the progress callback, which makes these post-await checks necessary.

Reviewer-owned negatives passed: a pre-existing backup name returned `PUBLISH_CONFLICT` at `publish` and preserved the sentinel's exact 33 bytes and SHA-256; an unsafe integer was injected only into the completed private staged snapshot after the real transfer, then validation returned `CORRUPT_DATABASE` at `validate-backup` and did not publish the final name. The source v1 event remained readable and unchanged.

The production diff is limited to the backup module, its tests/worker, and the internal `SQLiteConnection.backup` delegate. The v1 DDL, migrations, EventStore public contract, package manifest, and lockfile are unchanged. The coordinator still sets foreign keys, 180 ms busy timeout, and `synchronous=FULL`; read-only opens still require an existing file; the connection wrapper enables safe BigInt reads and rejects values outside the JavaScript safe range. Fresh backup/events tests cover active WAL, migration `SQLITE_FULL`, commit-acknowledgement recovery, and read-only boundaries.

Pre/post hashes matched for author sources, built `dist`, better-sqlite3 and type/addon-api package trees, install metadata, actual loaded Windows addon, pinned Node executable, author HEAD/clean state, and baseline HEAD/clean state. No dependency installation ran.

Limits: the deadline is cooperative; an in-flight native copy cannot be interrupted, while the post-await check prevents verification/publication/migration after expiry. Worker termination is process-kill evidence, not physical power-loss evidence. The author boundary command reported `BOUNDARY_SCAN_NOT_RUN` because `packages/core` is absent; treat it as NOT_RUN. No Desktop cold start, G02 integration, production database, or real model was used; this review accepts only the U08 unit implementation.
"""
(REVIEW / "review-final.md").write_text(review_md, encoding="utf-8")

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def artifact_list():
    rows = []
    for item in sorted(REVIEW.rglob("*")):
        if not item.is_file() or item.name == "review-final.json":
            continue
        raw = item.read_bytes()
        rows.append({"path": item.relative_to(REVIEW).as_posix(), "root": "review_directory",
                     "bytes": len(raw), "sha256": sha(raw)})
    return rows

def immutable(root_name, base, relative):
    item = base / pathlib.PurePosixPath(relative)
    raw = item.read_bytes()
    return {"path": relative.replace("\\", "/"), "root": root_name, "bytes": len(raw), "sha256": sha(raw)}

author_paths = [
    "AGENTS.md", "package.json", "pnpm-lock.yaml", "tsconfig.json", "tools/run-tests.mjs",
    "packages/storage/backup/src/index.ts", "packages/storage/backup/test/backup.test.mjs",
    "packages/storage/backup/test/backup-worker.mjs", "packages/storage/events/src/sqlite.ts",
    "packages/storage/events/src/index.ts", "migrations/001-event-store.ts",
    "dist/packages/storage/backup/src/index.js", "dist/packages/storage/events/src/sqlite.js",
    "dist/packages/storage/events/src/index.js", "evidence/P02-U08/20261004-02/manifest.json",
    "evidence/P02-U08/20261004-02/result.md", "evidence/P02-U08/20261004-02/inputs-pre.json",
    "evidence/P02-U08/20261004-02/inputs-post.json", "evidence/P02-U08/20261004-02/dependencies-pre.json",
    "evidence/P02-U08/20261004-02/dependencies-post.json",
    "evidence/P02-U08/20261004-02/commands/07-backup-focused-final.json",
    "evidence/P02-U08/20261004-02/commands/08-unit-full-final.json",
    "evidence/P02-U08/20261004-02/commands/06-binding-pre.json",
    "evidence/P02-U08/20261004-02/commands/10-binding-post.json",
    "node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml",
    "node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/package.json",
    "node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/lib/methods/backup.js",
    "node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/LICENSE",
    "node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/prebuilds/win32-x64.node",
    "node_modules/@types/better-sqlite3/index.d.ts",
]
baseline_paths = [
    "planning/Xiadie_V2_v1.1/tasks/P02-U02.md", "planning/Xiadie_V2_v1.1/tasks/P02-U05.md",
    "planning/Xiadie_V2_v1.1/tasks/P02-U07.md", "planning/Xiadie_V2_v1.1/tasks/P02-U08.md",
    "evidence/P02-U02/20261004-02/acceptance.json", "evidence/P02-U02/20261004-02/review-final.json",
    "evidence/P02-U05/20261004-02/acceptance.json", "evidence/P02-U07/20261003-01/acceptance.json",
    "evidence/P02/status.json", ".runtime/P02/reviews/mature-sqlite-store-u05/review-final.json",
    ".runtime/P02/coord/verify-author.py", ".runtime/P02/coord/verify-review.py",
    ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe",
]
immutable_inputs = [immutable("author_worktree", AUTHOR, item) for item in author_paths]
immutable_inputs.extend(immutable("baseline_repository", ROOT, item) for item in baseline_paths)

report = {
    "schema": "p02-independent-review/v1",
    "decision": "pass",
    "review_target": {"author_commit": AUTHOR_COMMIT, "baseline_commit": BASELINE_COMMIT,
                      "author_worktree": str(AUTHOR)},
    "attempt": "20261004-02-independent",
    "author_manifest_sha256": MANIFEST_SHA,
    "artifacts": artifact_list(),
    "immutable_inputs": immutable_inputs,
    "checks": [
        {"id": "frozen_author_manifest", "status": "pass",
         "details": "Exact author commit and manifest verified both before and after independent runs: 23 content files, 24 changed paths, clean worktree, no disk/Git mismatches."},
        {"id": "fixed_node_build_and_targeted_units", "status": "pass",
         "details": "Direct pinned Node v24.14.0 TypeScript no-emit check and build exited 0; independent unit P02-U08 plus P02-U05 passed 31/31."},
        {"id": "actual_better_sqlite_binding", "status": "pass",
         "details": "Loaded better-sqlite3 13.0.3 with SQLite 3.53.4 and Windows x64 addon SHA-256 e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a; package, type, addon-api, metadata and Node hashes matched pre/post."},
        {"id": "post_transfer_deadline_checks", "status": "pass",
         "details": "Both source backup and restore check elapsed monotonic time after the actual Better backup promise resolves; fresh tests wrap an already completed real transfer with a 300 ms delay against a 250 ms deadline. Neither late result is published."},
        {"id": "publication_and_integer_negative_cases", "status": "pass",
         "details": "Existing destination conflict preserved exact sentinel bytes; unsafe 9007199254740993 injected into the privately staged copy after real transfer was rejected at validate-backup, with no final backup publication and unchanged source."},
        {"id": "sqlite_migration_and_scope", "status": "pass",
         "details": "Fresh target tests passed across backup and event-store modules. Source review confirms unchanged v1 DDL, internal-only backup delegate, FK and FULL sync setup, bounded busy timeout, and readonly fileMustExist behavior; package and lockfile are unchanged."},
        {"id": "nonmutation_pre_post_binding", "status": "pass",
         "details": "Pre/post capture matched author source inputs, dist tree, package trees, install metadata, loaded addon, pinned Node, author HEAD/clean state, and baseline HEAD/clean state."},
    ],
    "limitations": [
        "The 300 ms/250 ms deadline is cooperative; it cannot interrupt an in-flight native transfer, but the post-await check prevents validation, publication, and migration after expiry.",
        "Worker termination exercises process kill, not physical power loss or storage hardware failure.",
        "The author boundary check reports BOUNDARY_SCAN_NOT_RUN because packages/core is absent; it is NOT_RUN, not a pass.",
        "No Desktop cold start, G02 integration, production database, or real model was used. This is a P02-U08 unit review only.",
        "The frozen author record reports 161/161 full unit tests; the independent reviewer ran 31 targeted backup and event-store tests, not the full suite.",
        "The initial reviewer-only negative assertion used the wrong nested field path; after correcting the harness and using new owned fixtures, both negative cases passed. An initial 29-test U08/U07 selector was superseded by the requested U08/U05 31-test run.",
    ],
    "external_references": [
        {"url": "https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3",
         "description": "Official release identity for the pinned better-sqlite3 13.0.3 package."},
        {"url": "https://raw.githubusercontent.com/WiseLibs/better-sqlite3/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/lib/methods/backup.js",
         "description": "Pinned upstream implementation: resolves the completed transfer before calling progress for that final step; callback rate 100 preserves ordinary default copying."},
    ],
}
(REVIEW / "review-final.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"decision": report["decision"], "author_commit": AUTHOR_COMMIT,
                  "artifacts": len(report["artifacts"]), "immutable_inputs": len(immutable_inputs),
                  "review_report": str(REVIEW / "review-final.json"), "review_md": str(REVIEW / "review-final.md")}, indent=2))
