# P02-U08 author result

Author status: ready_for_review. Baseline 6198ddcf963c7ee594b983f3b1c1fe33f692fb15, branch p02-u08. U07 is independently accepted. This is an author result; independent exact-commit acceptance remains pending.

Implemented SQLite online backup and fresh-root restore, reusing the unchanged static schema v1 and U05 reader. Empty v0 is backed up and verified before a single transactional initialization to v1. Existing WAL v1 is snapshot-only. Future versions and nonempty v0 user objects are refused before writable maintenance. BEGIN IMMEDIATE prevents competing writes while complete fact/observation/origin/receipt/capture/material count and canonical digest checks compare source and snapshot. Integrity, foreign keys, exact supported DDL, writer sequence and material projections are also checked. Publication uses a same-volume no-clobber link; existing backups and restore roots are preserved.

The backup promise settles before its source connection closes. A cooperative progress deadline stops backup before migration, without closing a still-running handle. Lost COMMIT acknowledgements are resolved only by full readback: verified v1 succeeds, verified empty v0 retains the known failure, unavailable verification is UNRESOLVED_TRANSACTION. Close failure cannot report success. Failed owned stages are retained; successful stage cleanup checks physical containment. The caller must pause producers, drain/reconcile and close its event writer first. The active-WAL fixture intentionally leaves an idle writer connection open solely to demonstrate inclusion of uncheckpointed committed WAL state.

Scope: packages/storage/backup/, tsconfig.json source mapping, tools/run-tests.mjs unit selector/inventory and this evidence directory. migrations/001-event-store.ts is an unchanged input. No dependency, schema v2, arbitrary migration callback, production data, paid model, installed ZCode or global configuration change.

## Actual verification

Actual argv/cwd/times/exit codes and outputs are archived in commands/ with byte-identical source records bound by command-index.json (13 records). All final commands use the existing fixed Node v24.14.0 and TypeScript 6.0.2.

- 07-build-commit-outcome-readback.json: final source build, exit 0.
- 08-bind-pre.json and inputs-final-pre.json: 122 inputs, explicit static migration source included; digest 3fdfbd02b2343f10428900836e93ba2c6fc8dd7ea6c90e638e601e7e2e878648.
- 09-final-unit.json: actual selector P02-U08, exit 0, 15/15 tests passed, none skipped.
- 10-bind-post.json and inputs-final-post.json: same 122 inputs/digest, unchanged true.

Actual fixtures cover empty v0 initialization; active-WAL facts, observations, receipts and masked capture hashes with main-file-only negative control; complete fresh-root restore; existing backup/root preservation; future and nonempty v0 unchanged main/WAL bytes; a real competing BEGIN IMMEDIATE yielding bounded BUSY; a padded empty database with real backup progress and a controlled monotonic clock yielding deadline rejection; actual SQLite FULL from a test-only page cap; owned fsynced-marker child termination immediately before/after actual COMMIT; and actual COMMIT followed by a thrown ACK with both verified and unavailable readback. ACK fixtures assert migration DDL/COMMIT once and reopen the actual committed v1 source plus verified v0 backup, without replay.

Failures retained: initial build lacked the sha256 helper (exit 2), corrected before tests. The first test run was 12/15: its DDL counter included the separate in-memory schema validation, and the tiny backup completed without a progress callback. The test counter now measures source migration before ACK; the deadline fixture now has more than 500 pages while retaining no user objects. A subsequent test load failed due to a duplicate local declaration, then the corrected tests passed 15/15 in tests-03-test-final.json and in the fully bound final selector run. No standard was lowered or failure output discarded. Owned synthetic test directories are cleaned after handle/child settlement and physical containment checks; source, workers and all failed outputs remain reproducible. A root command-construction error occurred before the final binding wrapper ran; corrected commands above supply the actual evidence.

## Limits and rollback

Progress deadlines are cooperative between SQLite steps, not absolute filesystem-stall bounds. Read-only SQLite may use WAL/SHM machinery. Process termination and controlled page-limit FULL are not physical power loss or disk exhaustion. APIs assume a trusted maintenance coordinator and paused producers; no adversarial filesystem/multiprocess snapshot guarantee is claimed. Snapshot byte hashes and canonical content hashes are distinct. NOT_RUN: physical storage failure, production data, paid models, Native/Desktop composition (U10), installed ZCode, portable installer and full runtime dependency closure. SQLite's experimental warning is retained.

Rollback only this isolated unit commit after review; keep accepted U01-U07 and frozen P01. Preserve original stores, published backups and failure stages. Restore into a new root and inspect uncertain outcomes before any manual retry. U09 remains blocked until independent acceptance; P03 has not started.
