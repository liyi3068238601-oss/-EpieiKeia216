# P02-U05 author result

Status: `ready_for_review`. The implementation is in author commit `33d2c121db735f89bf639dd36c54724f0ed4a4f4`, based on `18a35406efaccce964ea53327d7af6d636c115f1` in branch `p02-u05`. This follow-up only completes the evidence archive; product code and tests are unchanged.

## Scope and source choice

The changed implementation scope is `packages/storage/events/`, `migrations/001-event-store.ts`, `tsconfig.json`, and `tools/run-tests.mjs`; task evidence is in `evidence/P02-U05/20261003-01/`. The store uses the already-fixed Node v24.14.0 `node:sqlite` toolchain and U03/U04 contracts. No dependency was installed or added. The store is a single-owner synchronous SQLite writer behind a bounded FIFO, with WAL, foreign keys, `synchronous=FULL`, and a 180 ms busy bound.

Events are identified by `(source,eventId)`. Canonical facts exclude observation time and source sequence; the first fact, origin, and receipt remain immutable. Exact observation retries reuse the first sequence, new observations get a writer-owned sequence, and a conflicting candidate is audit-only. Optional full-mask transcript material, generic origin, observation, fact, receipt, and writer sequence are written in the same transaction. Capture input is checked against U04: exactly one redacted message, with `UserPromptSubmit` requiring `user` and `Stop` requiring `assistant`. Historical source locators do not have to remain readable.

An executed COMMIT whose acknowledgement is lost returns `unknown` so callers reconcile with the receipt, for both first writes and exact-observation retries. A failed rollback that leaves `DatabaseSync.isTransaction` true quarantines the writer; accepted followers settle as unknown without starting another transaction. `close()` drains accepted work, attempts rollback, still attempts connection close if transaction-state inspection fails, and propagates connection-close errors. A read-only schema preflight rejects future versions before WAL or DDL; non-empty v0 databases are refused. U08 migration backup/recovery remains outside this task.

## Verification and commands

All 42 run JSON records present at archive time are under `commands/`, including failed attempts and the recorded removal of superseded binding files. Each JSON retains its original captured fields; command records include argv, cwd, exit code, stdout/stderr, and wrapper record path where those fields were captured. `command-index.json` supplies archive-relative paths, byte lengths, and SHA-256 values. The original run records remain in `E:\Xiadie\Xiadie\.runtime\P02\runs\u05\`.

| Check | Archived record | Result |
|---|---|---|
| Final TypeScript build with fixed Node v24.14.0 | `commands/26-build-final-contract-guard.json` | exit 0 |
| Pre-test source/runtime binding, including migration DDL | `commands/28-bind-ready-pre.json` | 108 files; digest `34c5146d0fa68e4440cc31b38626a2a603afd8709b2b559775d2b589457eab39` |
| Final U05 suite | `commands/29-u05-tests-final-contract-guard.json` | exit 0; 11 passed, 0 failed |
| Post-test binding compared with pre-test binding | `commands/30-bind-ready-post.json` | same digest; `unchanged: true` |
| Staged whitespace/error check | `commands/35-cached-diff-check.json` | exit 0 |
| Staged diff inventory against the task baseline | `diff.json`; invocation `commands/42-diff-unit-refresh.json` | exit 0; cached stat, numstat, names, and check captured |

The final suite exercises fact/origin/capture/receipt atomicity and writer sequence rollback; exact retries, resequencing, and first-fact conflict preservation; readback hash/mirror validation and pagination; invalid raw/capture bounds and the U04 message-count/role rules with recomputed snapshot hashes; queue-full, drain, and close; lost acknowledgements for new and duplicate observations with receipt reconciliation; rollback-failure isolation and close recovery; propagation of a connection-close error; actual SQLite BUSY; controlled `max_page_count` SQLITE_FULL; read-only, future-schema, and non-empty-v0 refusals; and owned-child termination before COMMIT, after a first COMMIT, and after a duplicate COMMIT.

For the capture rollback case, a test-only COMMIT fault occurs after the fact, observation, origin, material, receipt, and sequence changes have been issued inside SQLite. The append reports a known failure after rollback; direct inspection confirms all five row sets remain empty, the receipt is absent, and `last_commit_sequence` remains zero. For an unacknowledged successful COMMIT, the result is unknown and the receipt query finds the committed sequence. For unresolved rollback, the successor does not execute and accepted jobs settle before `drain()`/`close()` complete.

The fixed working directory for build and tests is `E:\Xiadie\Xiadie\.runtime\P02\worktrees\u05`. The runtime is `E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe`. The final build argv is that executable followed by `node_modules/typescript/bin/tsc --project tsconfig.json`; the test argv is the same executable followed by `tools/run-tests.mjs unit P02-U05`. Binding and diff argv are preserved in their respective archived JSON records. The final pre/post binding pair is `inputs-final-02-pre.json` and `inputs-final-02-post.json`; the earlier `inputs-final-pre.json` and `inputs-final-post.json` were removed by recorded command `commands/31-remove-superseded-bindings.json` and are not authoritative.

Historical failed command outputs remain archived, including the first test assertions that were corrected, the controlled page-cap cleanup issue, a malformed inventory command, a binding attempt aimed at an existing output path, and the initial freeze invocation with the wrong baseline argument. They are retained for chronology; the final authoritative results are the checks in the table above. `diff.json` records the cached diff snapshot immediately before its own creation and before archiving its wrapper output; the final manifest binds the exact completed evidence tree. The final author implementation commit is `33d2c121db735f89bf639dd36c54724f0ed4a4f4`.

## Boundaries

Physical disk exhaustion and physical power loss were not tested. SQLITE_FULL used a controlled SQLite page cap. Process-kill checks terminated only test-owned children. U08 online backup/migration/recovery, U10 pairing with a native hook ID, Host integration, production databases, network services, and model calls were not exercised. No new dependencies were installed.

## Rollback and recovery

If U05 must be withdrawn after integration, revert the U05 author commits as a unit (including implementation commit `33d2c121db735f89bf639dd36c54724f0ed4a4f4` and evidence commit `218e7792ce152075725d9b4b10695679bd6cc9a2`) back to prerequisite commit `18a35406efaccce964ea53327d7af6d636c115f1`; retain commit history, archived evidence, and owned experiment databases. U05 has not migrated any production database and refuses future-schema and non-empty v0 stores rather than auto-initializing or downgrading unknown existing data. For a committed or `unknown` append, query its durable receipt before retrying; never blindly replay an external side effect. Any recovery of real persisted data must follow the accepted U08 backup/restore procedure.
