# P03-U05 result

Author status: `ready_for_review`; independent acceptance is pending. Baseline: `f77adb3205c5c7a928f1624f5b6e85ad4876f53f`. Attempt: `20261008-01`.

The policy distinguishes current implementation, tested contract and accepted design decisions. Project memory remains an `experience-lead` with revision-bound provenance. P03 stage/unit status uses the stage ledger and its exact review/acceptance artifacts; business-task owner/progress require verified TaskLedger evidence and are `unknown` when absent. AGENTS.md remains limited to stable project rules.

Validation records are bound by path, exit code and SHA-256:

- `.runtime/P03/coord/stage-dependencies-f77adb3205c5.json`: frozen-lockfile install with scripts disabled exited 0; the recorded SQLite smoke check exited 0 on SQLite 3.53.4. Its dependency profile was not copied into evidence.
- `evidence/P03-U05/20261008-01/build-command.json` (`93d8a83cad259cf12a080ac1a3b33a11f1d8ef7a52751dcb96721d0c7c95ce74`): fixed Node 24.14 TypeScript build, cwd `E:\Xiadie\Xiadie\.runtime\P03\worktrees\u05`, exit 0.
- `evidence/P03-U05/20261008-01/unit-02-command.json` (`47ce91bc18f7b04c4d4b13ffeb3687ae89bbee2c95f66ffca73f14321254097b`): `node.exe tools/run-tests.mjs unit P03-U05`, same cwd, exit 0; 1 test passed, 0 failed.

The test used the actual current ProjectRegistry and U04 reader APIs with an isolated synthetic Git workspace and memory topic. It bound the current source/test hashes, accepted U02/U04 receipts, task-card hashes and stage-ledger hash; a forged frontmatter `authority: verified-fact` remained untrusted, the reader emitted `experience-lead` with the raw topic hash, and the built ContextPacket kept the note in `content` rather than `instruction` or `evidence`. This validates deterministic source and data boundaries. It does not test model judgment or real Native core `Read` behavior.

Source decisions and adopted artifact hashes are in `source-adoption.json`. Rollback is reverting the isolated U05 commit; no production runtime data, user settings, historical plan or upstream checkout was changed.

Freeze preflight initially rejected a trailing blank line and CRLF/LF disk-index mismatch. The coordinator mistakenly committed the staged paths before a manifest existed. `freeze-preflight-failure.json` records this; a follow-up commit normalizes the two Markdown files and binds the complete final changed-path set. Main was untouched and acceptance remained pending.
