# P03-U08 source adoption and author draft

Author status: `running`. Independent review, build, tests, Desktop and real-model checks: `NOT_RUN`. Baseline: `5831ba60285536aaa9b8ef40770510f380cb6edf`; worktree branch: `p03-u08`.

## Source decision

Reuse the accepted U03 `ProjectRegistry` mapping to resolve the reopened workspace to its project identity. The current registry file includes the later accepted U06 extension, so its current raw-byte hash is recorded separately from the U03 source history. Reuse the accepted U04 selected-topic reader and its explicit source states, keeping project-memory notes at `experience-lead` authority.

Carry forward U07's accepted provenance rule: bind a claim to the host-selected evidence path and raw source bytes, project id, base commit and sample time. A matching hash establishes byte identity; it does not verify the claim's meaning. The local U08 gap is comparing an older observation with a fresh reopen observation. Matching Git HEAD and selected evidence hashes remain current across elapsed time; changed inputs require recheck; missing, unsafe, unreadable, failed or incomplete observations remain unknown. Supersession requires a separately verified replacement. The source record lists seven current raw-file references and pins Native observations to the actual read-only checkout.

The fixed Native checkout is `.runtime/P01/desktop-source` at `29628c9acdb81b703bbd4080c207a0e7ce5e276e`, with a clean working tree and Apache-2.0 `LICENSE`. Z03 builds a persistent Memory system-context section. Z06 enumerates memory files with `mtimeMs` and uses a stable-handle read helper. These sources do not provide the U08 reopen freshness classification. No Native code was copied. Raw hashes and byte counts were calculated from `Path.read_bytes()`; the checked Z03 and Z06 files contain LF bytes (0 CRLF), and the hashes are not Git blob ids.

## Scope mapping

The card allows the freshness implementation in `packages/projects/freshness.ts`. The card's illustrative `tests/units/P03-U08.test.ts` target maps to the existing Node test layout at `packages/projects/test/freshness.test.mjs`; `tools/run-tests.mjs` maps selector `P03-U08` to that file and includes it in `unit/all`. Those implementation and test files are still author WIP; this source audit records no final implementation hashes. The primary author will bind the final source, test and selector bytes before setting `ready_for_review`.

This draft records source selection only. No U08 build or test was run, and no status, task card, acceptance record or accepted history was changed. See `source-adoption.json` for the exact acceptance references and raw-byte bindings.
