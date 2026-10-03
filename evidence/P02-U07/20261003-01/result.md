# P02-U07 author result

Author status: ready_for_review. Baseline: 6f445086853126227396029cf973c2fd33f90229, branch p02-u07. U06 is independently accepted at this baseline. The exact author revision and manifest are returned after freeze; this document does not claim independent acceptance.

## Result and scope

Added inspectOperation, executeOperationOnce, recordVerifiedReceipt and recoverAttempt using the actual accepted U03 contracts and U05 SQLite EventStore. Operation identity and immutable descriptor survive changes of turn/run/attempt. Only a newly committed intent with an ACK can dispatch an effect. Intent COMMIT followed by lost ACK cannot dispatch; a dispatched effect lacking a committed known receipt is unknown and never automatically replayed. A receipt whose ACK is lost can be reconciled only by rereading actual committed history. Known failure also does not authorize an automatic retry. Changed owner/descriptor, conflicting deliveries and opposing verified outcomes require review while preserving the first facts and receipt.

Recovery does not create a past run for an absent attempt. For an evidenced open attempt it appends one deterministic derived interrupted fact and rereads writer order. The interrupted fact's occurredAt explicitly refers to the first committed attempt event, while observedAt records discovery. It does not claim to identify a crash instant. Success/cancel ordering and late old-attempt or post-terminal receipts preserve the first turn terminal. Operation effects remain separately inspectable after cancellation.

Changed paths: packages/application/recovery/, tools/run-tests.mjs (unit mapping and all-unit inventory), evidence/P02-U07/20261003-01/. No new database schema, dependencies, production configuration, real external send or paid model call. The source/reuse decision is in source-decision.md.

## Actual verification

All final commands use cwd E:\Xiadie\Xiadie\.runtime\P02\worktrees\u07 and the existing fixed Node 24.14.0. The actual argv, cwd, times, exit codes and streams are in commands/; command-index.json binds byte-identical archived copies to their originals.

| Check | Record | Actual outcome |
|---|---|---|
| Final TypeScript build | 04-final-build.json | exit 0 |
| Before-run bindings | 05-bind-pre.json, inputs-final-pre.json | 117 actual source/test/tool/compiled inputs; digest b33f5b52393427fb1738720333686f64eeceae0177704b0f90dfec3d46fae781 |
| Unit selector | 06-final-unit.json | exit 0, 12/12 passed, 0 skipped |
| After-run bindings | 07-bind-post.json, inputs-final-post.json | identical 117 inputs/digest, unchanged true; explicit migration source included |

The tests use real owned SQLite databases and actual fsynced file effects. The actual COMMIT is executed before the injected ACK exception for both intent and receipt cases. The actual owned child writes and fsyncs its effect and marker, stops before returning a receipt, and is hard-killed by its parent; reopening finds unknown and retry invokes no callback, with the effect file unchanged at one entry. Other groups cover concurrent/repeated single dispatch; owner/descriptor conflict; same source/event identity changed to another operation/owner including the old first-receipt query; known success/failure close/reopen; unknown-to-verified reconciliation and opposing receipts; no-intent no-history-write; both success/cancel orders and late receipts; concurrent interruption with one first fact and no identity conflict; actual pagination beyond 256 rows and deliberately nonadvancing pages refusing recovery/absence.

Initial unwrapped tests were 9/11: a JSON null-prototype result failed a prototype-sensitive assertion, and a truly existing foreign-owner operation was incorrectly expected to be absent. The test assertions/fixture were corrected, retaining valid conflict checks and genuine no-history assertions. Their actual failure output is archived as historical-01-recovery-initial-failure.json; timestamps were not captured and are null, and the combined stream is explicitly identified rather than reconstructed as separate stdout/stderr. Corrected 11/11 preceded the recorded 12/12 run in 03-recovery-review-tests.json. Final binding and selector verification above are fully wrapped. The historical fixtures were owned temporary data and were cleaned by the test helper; their code and failure output remain available for reproduction.

Pre-freeze independent logic feedback identified the candidate-operation filtering gap and concurrent interruption timestamp identity conflict. Both were fixed before the final build/test; the exact current tests include these regressions. Formal independent review remains pending.

## Limits and rollback

The inspector must completely scan observations to find conflict candidates that changed operation ID or owner, since U05 has no identity-specific observation query. Each scan is capped at 32 x 256 rows. A larger global observation history returns unavailable/needsReview, never a false absence or known success. Reads are a synchronous single-writer call-time view, not a global multi-process snapshot guarantee.

These are coordinator-internal trusted adapter APIs. They cannot attest arbitrary external effects or supply authorization; the caller must use a stable operation ID and verified reconciliation evidence. The process kill is not physical power loss or disk exhaustion. NOT_RUN: actual Native/Desktop integration, production databases/data, paid models, external sending/generation, physical storage failures, installed ZCode, installer/portable package behavior, full runtime dependency closure. Node SQLite retains its experimental warning.

Rollback only the independently frozen U07 commit if rejected, keeping accepted U01-U06 and historical P01 unchanged. No migration is introduced. Unknown external effects must be verified before any manual retry; do not delete receipts or blind-replay. Failed evidence is retained. U08 remains blocked by independent U07 acceptance, and P03 has not started.
