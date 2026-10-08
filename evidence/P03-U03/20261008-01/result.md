# P03-U03 result

Author status: `ready_for_review`; independent review and coordinator acceptance pending.
Baseline: `1326a8b036d4695271d194f3bcb1611382433303`. Attempt: `20261008-01`.

The new project registry assigns persisted UUIDs and records Native runtime aliases, path-key aliases, canonical memory pointers and linked-worktree parents. It reuses the accepted SQLite wrapper in a separate mapping database. No memory text is stored in the registry and no Native memory directory or knowledge file is created. Existing legacy memory requires explicit adoption; its canonical pointer and all file hashes remain unchanged. A competing canonical pointer fails the transaction.

Actual Git common/private directory identity and registered worktree backlinks determine grouping. Same-name repositories, forks with identical HEAD/remote and standalone directory copies receive different UUIDs. A known physical directory at a new path requires explicit relocation and keeps its original mapping. The tested E-to-C standalone copy gets a new identity; the tested linked-worktree copy plus real `git worktree repair` retains its original private Git identity and requires explicit relocation. U06 supplies the confirmed migration/export operation; this unit does not silently adopt a moved copy based on repository contents.

The formal `tools/run-tests.mjs unit P03-U03` invocation passed 14 behavior tests, with 0 failures and 1 skipped symbolic-directory-link subtest because Windows refused creation. Both junction rejection assertions passed. Tests also cover SQLite reopen, actual Native 80-character runtime alias collisions, injected canonical-key collision rollback, replaced paths, copied unregistered linked worktrees, unknown database preservation, legacy file hashes and pointer-only absent memory. Synthetic E-drive fixtures and uniquely owned C-drive copy fixtures remain on disk.

TypeScript 6.0.2 build passed using fixed Node 24.14.0. The boundary command exited 0 but reported `BOUNDARY_SCAN_NOT_RUN`: `packages/core` is absent, so no product Core import graph was checked. This is not a boundary-check pass. Exact argv, cwd, exit codes and output are in `build-03-command.json`, `boundary-command.json` and `unit-command.json`; earlier successful builds are retained. `source-adoption.json` binds the actual pinned Native helper source/dist, accepted U02 provenance and SQLite wrapper. The official Git worktree reference was refreshed on 2026-10-08. No Native key algorithm was copied.

Scope remap: the card's new registry source plus `packages/projects/test/registry.test.mjs`, a compiler include, and the existing test selector. No dependency changes, event-ledger schema changes, baseline-plan edits, global Git settings, installed ZCode profile, credentials or user memory changes.

Native helpers and real Git/SQLite execute in these tests; Native app sessions, model behavior, Desktop and DSH are `NOT_RUN`. This is U03 mapping validation, not P03/G03 acceptance. Cross-machine ownership transfer remains explicit U06 work. Rollback is reverting this unit's isolated commit; no production data was migrated and synthetic fixtures are preserved.
