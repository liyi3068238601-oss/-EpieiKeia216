# P02-U10 integration result

Author status: **ready_for_review**. Baseline da364514f78d486564b26d3973a66b821a937503; U01-U09 are independently accepted. This result does not declare U10 accepted or G02 passed. Current acceptance is tracked separately in `evidence/P02/status.json`.

The actual Native integration uses accepted U03-U09 through a narrow durable host injected into the frozen P01 factory. Native session/turn/event identity, time, sequence and hook start come from real runtime envelopes; the coordinator assigns its own explicit run/task/attempt. Derived, fully masked current-message capture is correlated to the actual installed hook process. Saved requires completed actual SQLite commit and matching read-back receipt, capture and terminal. Native outcome and durability remain separate. Reopen recovers only committed attempts and blocks resume for unknown owned effects. Close stops admission, aborts its own operation, waits for completion/capture/writer, then closes Native and storage. No accepted package or upstream implementation was modified.

## Actual results

| Check | Result | Exact archive |
| --- | --- | --- |
| TypeScript source build | exit 0 | commands/01-build.json |
| Accepted U03-U09 unit regression | 82/82, no fail/skip, exit 0 | commands/03-accepted-unit-regression.json |
| Fixed-Node actual Native matrix | 8/8, no fail/skip, exit 0 | commands/tests-07-final-native-matrix.json |
| Native pre/post executable inputs | 132 inputs, identical digest 588e587c5d6580cdc1cbc4c43afcebedeeaa265899dbc0b33664151d2be3b964, includes static migration | commands/tests-06-final-inputs-before.json and tests-08-final-inputs-after.json |
| Fresh candidate-02 build | exit 0, 6,689 artifact bindings / 94 repository inputs | candidate-proof/commands/06-build-final.json and candidate-descriptor.json |
| Actual Electron UI full matrix | 6/6, every ledger check passed, exit 0 | candidate-proof/runs/full/summary.json |
| Actual Electron UI degradation | 3/3, every ledger check passed, exit 0 | candidate-proof/runs/degradation/summary.json |

Native scenarios cover actual Read success and error, actual local model HTTP failure, caller cancellation plus new turn, in-flight close, real SQLite BUSY and reopen without replay. The Read error is an actual Native tool failure; the synthetic model then truthfully reports failure while the Native turn lifecycle succeeds. The separate HTTP503 scenario establishes a Native failed terminal. BUSY does not change the functional Native outcome into a false durability success. Actual U08 backup and fresh-root restore match canonical content digests. Original temporary transcript files are removed by Native; retained masked capture and historical origin remain, while U09 current source validation is NOT_VERIFIED and private canaries are absent.

The Desktop matrix exercises success, Read success/failure, cancel/recovery, disabled-native and denied Pro; degradation exercises no-Key, no-DSH and controlled offline503. No-Key is zero requests and zero admitted facts. Actual UI plus fixed Node CLI is qualified: the durable host/SQLite run in the CLI protocol process, **not Electron main**. P01 sidecar remains UI correlation evidence. Both final suites verify production/execution unchanged, DSH not started, external model calls zero and dynamic inspector/loopback ports. No real credentials are used.

Candidate source commit is **7f947b3abc172aa2e8dc3614abec0679b0b8d24d**. Descriptor SHA-256 is **751d005573354d5f09aa676c2c306c744f1754432506915a08eb874a7e14cb45**; CLI SHA-256 **eb4f7c0d6f848a9ee36efec1936c28266f9c447c73214da74ee09bcc1dd103ea**. It is retained at `E:/Xiadie/Xiadie/.runtime/P02/experiments/u10/candidate-02`. Native8 ran at earlier clean source52a7f9427e6866263a159fb5a63ed20b28529bff; subsequent executable changes only add the P02 Settings test driver/runner. Native/package/migration sources are unchanged; final Desktop runs bind the new harness. The author evidence commit is later and is not misrepresented as the candidate build commit. Exact final path/file coverage is frozen in manifest.json.

## Failures retained and repair

The first Native fixture import assumed a provider dist entry that does not exist in the pinned source; it now loads the actual registry TS through existing tsx. The first diagnostic call incorrectly spread internal status fields into U09's strict request; the final call passes only exact scope/attempt/store/optional reports. An unbounded fixture repeated failed Read calls; the bounded synthetic model now stops after the actual failed read, and an additional HTTP503 test preserves genuine Native failure coverage. All failed command records remain.

candidate-01 full passed6/6, but two no-Key checks timed out waiting for a Settings back button after the actual UI returned to the workspace. Those failed suites remain in candidate-proof/runs/degradation-initial and degradation-retry. The P02-only driver repair requires actual Settings detached and workspace composer visible, retaining refusal/zero-request/zero-fact assertions and a returned-page text snapshot. It does not treat timeout alone as success. Frozen P01/upstream/product behavior is unchanged. A subsequent candidate build initially refused the uncommitted evidence archive; that refusal is also preserved. After committing the archive and harness, candidate-02 was rebuilt and **both complete suites** rerun successfully. No failed report was rewritten or deleted.

## Scope, limitations and rollback

Task scope maps to tests/integration/P02, docs/evals/P02, tools/run-tests.mjs selector and this evidence directory. Source decisions and per-requirement mapping are included. U01-U09 acceptance bindings and all423 authoritative plan manifest entries were rechecked with no mismatches; planning and historical P01 remain unchanged.

These are owned synthetic profiles/workspaces/effects and loopback mock model fixtures with actual Native/Electron/Node/SQLite, not paid model or production evidence. Native imports and build inputs are bound, not a complete runtime dependency closure. Character public distribution rights remain unasserted. Local development assembly is not installer/portable/public release. Human visual acceptance, physical power/disk failure, arbitrary external write/send/generation reconciliation, full message editing/concurrency and original-text/history recovery remain outside this qualification. Node SQLite retains its experimental warning. Current-message capture is not the whole conversation; diagnostic turnSeal remains unavailable. Bounded history scanning can return unavailable/needsReview.

Rollback only U10 commits/scopes through an explicit revert; retain accepted U01-U09, failed evidence, candidates and owned profiles. Existing production data was not migrated. Any real data recovery must use verified U08 backup/new-root restore; unknown effects must be reconciled before any manual retry. U11 remains gated by exact independent U10 acceptance; P03, push, tag and publication are not started.
