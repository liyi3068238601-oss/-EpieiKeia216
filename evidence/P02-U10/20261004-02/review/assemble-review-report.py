from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(r"E:\Xiadie\Xiadie")
REVIEW = ROOT / ".runtime/P02/reviews/mature-integration-u10/final-663de06-20261004"
AUTHOR = ROOT / ".runtime/P02/worktrees/mature-integration"
AUTHOR_COMMIT = "d0952673ed6961cacfc38edf9c39256228c7dfc8"
BASELINE_COMMIT = "178379a8ad9c0c27f833a412ff06f7b0095bab79"
MANIFEST = "evidence/P02-U10/20261004-02/manifest.json"
MANIFEST_SHA = "da87f3a845b577c890bc21232f28b2cabbf271f493dbc4f7b2f4dea1565dac4e"


def item(root_name: str, base: Path, relative: str) -> dict[str, object]:
    path = base / relative
    raw = path.read_bytes()
    return {
        "root": root_name,
        "path": relative.replace("\\", "/"),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


author_artifacts = [
    MANIFEST,
    "evidence/P02-U10/20261004-02/result.md",
    "evidence/P02-U10/20261004-02/candidate-proof-index.json",
    "evidence/P02-U10/20261004-02/runtime-raw-index.json",
    "evidence/P02-U10/20261004-02/candidate-proof/candidate-descriptor.json",
    "evidence/P02-U10/20261004-02/candidate-proof/commands/73-candidate-09-build.json",
    "evidence/P02-U10/20261004-02/candidate-proof/commands/74-candidate-09-desktop-full.json",
    "evidence/P02-U10/20261004-02/candidate-proof/commands/75-candidate-09-desktop-degradation.json",
    "evidence/P02-U10/20261004-02/candidate-proof/runs/full/summary.json",
    "evidence/P02-U10/20261004-02/candidate-proof/runs/degradation/summary.json",
    "evidence/P02-U10/20261004-02/fixed-node-unit-161.json",
    "evidence/P02-U10/20261004-02/fixed-node-native-8.json",
    "evidence/P02-U10/20261004-02/04-tsc-noemit.json",
    "evidence/P02-U10/20261004-02/05-import-boundaries.json",
    "evidence/P02-U10/20261004-02/06-tsc-build.json",
]
for source in [
    "tests/integration/P02/build-candidate.mjs",
    "tests/integration/P02/desktop.py",
    "tests/integration/P02/desktop-ui.mjs",
    "tests/integration/P02/verify-ledger.mjs",
    "tests/integration/P02/durable-host.mjs",
    "tests/integration/P02/sqlite-runtime-probe.test.mjs",
    "tests/integration/P02/registry-write-guard.cjs",
    "tests/integration/P02/desktop-main-guard.cjs",
    "tests/integration/P02/candidate-verifier.py",
]:
    if (AUTHOR / source).is_file():
        author_artifacts.append(source)

immutable_author = [
    "planning/Xiadie_V2_v1.1/PACKAGE_MANIFEST.json",
    "planning/Xiadie_V2_v1.1/tasks/P02-U10.md",
    "docs/sources.lock.json",
    "evidence/P02/status.json",
]
for unit in ("U02", "U05", "U08"):
    base = f"evidence/P02-{unit}/20261003-01"
    for filename in ("acceptance.json", "review-final.json"):
        path = f"{base}/{filename}"
        if (AUTHOR / path).is_file():
            immutable_author.append(path)

artifacts = []
seen: set[tuple[str, str]] = set()
for relative in author_artifacts:
    key = ("author_worktree", relative)
    if key not in seen:
        artifacts.append(item("author_worktree", AUTHOR, relative))
        seen.add(key)

baseline_artifacts = [
    ".runtime/P02/coord/P02-U10-author-d0952673ed69.json",
    ".runtime/P02/coord/verify-review.py",
]
for relative in baseline_artifacts:
    key = ("baseline_repository", relative)
    artifacts.append(item("baseline_repository", ROOT, relative))
    seen.add(key)

for path in sorted(REVIEW.rglob("*")):
    if not path.is_file() or path.name == "review-final.json":
        continue
    relative = path.relative_to(REVIEW).as_posix()
    key = ("review_directory", relative)
    if key in seen:
        continue
    artifacts.append(item("review_directory", REVIEW, relative))
    seen.add(key)

immutable_inputs = [item("author_worktree", AUTHOR, relative) for relative in immutable_author]

report = {
    "schema": "p02-independent-review/v1",
    "decision": "pass",
    "task": "P02-U10",
    "review_target": {
        "author_commit": AUTHOR_COMMIT,
        "baseline_commit": BASELINE_COMMIT,
        "author_worktree": str(AUTHOR),
        "manifest_path": MANIFEST,
        "manifest_sha256": MANIFEST_SHA,
    },
    "reviewer": "p02_u10_independent",
    "scope": "Exact-commit independent review of the P02-U10 candidate source closure, actual CLI SQLite binding evidence, bounded-effects Desktop suites, archive bindings, and runtime probe. No additional UI, model, registry mutation, Native launch, installation, or production change was performed.",
    "checks": [
        {
            "id": "exact-author-target-and-manifest",
            "status": "pass",
            "detail": "Author worktree is clean at the exact d0952673 commit; root repository is clean at baseline 178379a8. The exact manifest has 356 file entries/357 changed paths and SHA-256 da87f3a8...; the independent digest audit matched all Git blobs and disk bytes with zero mismatch.",
        },
        {
            "id": "candidate-closure-and-license",
            "status": "pass",
            "detail": "Independent audit matched all 6,717 owned candidate files, 103 repository inputs against candidate source commit cd03ddc3 and final author files, 250 proof copies, and 45 runtime sidecars/provenance copies. Better SQLite 13.0.3 / SQLite 3.53.4 and the 26-file MIT package closure, including the exact Windows addon hash, match the descriptor. The final raw-index path correction is verified; the earlier missing separators at the 36e9d2c checkpoint are retained as resolved history.",
        },
        {
            "id": "actual-runtime-and-nine-scenario-correlation",
            "status": "pass",
            "detail": "The final candidate-09 evidence is 6/6 full and 3/3 degradation. Independent sidecar correlation binds each scenario's Electron main process, argv/cwd/execPath, 18 guard records and registry request hashes, per-profile CLI alias, guarded CLI PID, and actual candidate addon load. Eight enabled-P02 scenarios have actual load evidence; offline records two CLI probes. disabled_native bypasses only the P02 durable wrapper and remains Native fallback with two loopback requests; not_instantiated means no P02 ledger/probe, not Native shutdown or addon proof. Combined traffic is 11 loopback and zero external model requests.",
        },
        {
            "id": "backup-restore-readback-and-registry-boundary",
            "status": "pass",
            "detail": "The archived success readback report and indexed bytes record snapshot-v1 backup/restore, equal backup/restored database digest, integrity=ok, foreign_key_check=ok, and expected row counts. The reviewer validated the archived report/hash bindings without independently opening the ignored DB file. Each suite's nine selected registry-key pre/post snapshots match SHA-256 f7271757...; this covers only the suite interval.",
        },
        {
            "id": "fresh-probe-and-reused-prechecks",
            "status": "pass",
            "detail": "Fresh pinned Node 24.14.0 targeted sqlite-runtime-probe test passed 1/1. The 30c00b reviewer prechecks (guard 5/5, desktop side-effect 2/2, candidate-verifier 10/10) are reused only because their code/runtime input hashes match the final author input; they were not rerun on d095. Author typecheck/build and fixed-node unit 161/161/Native 8/8 are archived author evidence; the last two are an earlier checkpoint, not reviewer reruns.",
        },
        {
            "id": "failure-history-and-scope-limitations",
            "status": "pass",
            "detail": "Reviewer-harness failures and superseded candidate failures remain preserved and are not counted as product passes. Candidate-07 offline EEXIST and Candidate-08 UI locator timeout remain historical failures; candidate-09 passes, but its narrow onboarding timeout fallback was not exercised. Boundary scan output says BOUNDARY_SCAN_NOT_RUN because packages/core is absent.",
        },
    ],
    "limitations": [
        "The P02 effect guard is main-process instrumentation, not an OS sandbox. Better SQLite covers only P02 event storage/backup; Native-owned session, TaskIndex, and automation stores still use node:sqlite.",
        "Human visual review, separate Native launch, installer/portable deployment, paid Desktop/production release, physical power-loss recovery, and the onboarding timeout fallback branch are NOT_RUN.",
        "The archive verifies the success readback report and hash links but does not independently query the ignored raw SQLite database. The candidate verifies its declared 6,717-file closure and one pinned Native node_modules junction, not a complete installer dependency closure.",
        "The authorized five-value registry repair points to D:\\Zcode\\ZCode.exe; prior custom values are unknown and were not reconstructed. The suite's selected-key equality cannot establish pre-investigation history; historical Recent-document state/calls remain unverified.",
        "Two reviewer-owned precheck fixtures remain outside the review archive after safe cleanup was refused. No cleanup bypass was attempted.",
    ],
    "artifacts": artifacts,
    "immutable_inputs": immutable_inputs,
}

(REVIEW / "review-final.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"decision": report["decision"], "artifact_count": len(artifacts), "immutable_input_count": len(immutable_inputs), "report": str(REVIEW / "review-final.json")}, ensure_ascii=False))
