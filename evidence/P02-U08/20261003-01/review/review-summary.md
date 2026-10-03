# U08 exact-commit review

Decision: pass for author commit `066125b86ad01ed811ed88c1da4fb3d91aa884e3` over baseline `6198ddcf963c7ee594b983f3b1c1fe33f692fb15`.

The frozen author worktree is clean. Independent author verification matched all 25 manifest entries to 26 changed paths and raw Git blobs. The registered change scope is respected; `migrations/001-event-store.ts` is an unchanged input. The U07 prerequisite is accepted. All 13 archived author command records match their source files and hashes, including the initial build failure (exit 2) and two failed test attempts (exit 1); final build and test records exit 0.

With fixed Node v24.14.0 / TypeScript 6.0.2, independent build exited 0 and `unit P02-U08` passed 15/15 with no skips. Independent pre/post bindings match the author’s 122 inputs and digest `3fdfbd02b2343f10428900836e93ba2c6fc8dd7ea6c90e638e601e7e2e878648`, including the static migration source, with no drift.

Two owned-fixture counterexamples passed. A real close of the maintenance RW coordinator followed by an injected lost close acknowledgement rejects with `UNRESOLVED_TRANSACTION/migrate`; the source is valid v1 and the published backup is valid v0. A real capture’s backed-up material BLOB was changed while its snapshot hash remained stale; restore rejects with `CORRUPT_DATABASE/restore-source` before creating the destination.

The implementation uses SQLite’s online backup API, verifies complete table projections and content digests before no-clobber publication/restoration, rejects future schema and non-empty v0, and preserves unresolved commit/close stages. Full Native/Desktop integration (U10), production data, installed ZCode, actual power loss, physical filesystem exhaustion, paid models, installer/portable packaging and the complete native dependency closure are NOT_RUN. The controlled SQLite `FULL` test is a page-limit failure, not physical disk exhaustion.
