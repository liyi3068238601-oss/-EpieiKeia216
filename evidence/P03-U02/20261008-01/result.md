# P03-U02 result — isolated reuse decision

**Status:** author `ready_for_review`; not independently accepted

**Baseline:** `c691a5b7a975ac4420f880c8233c7b0bb7893958`

**Date:** 2026-10-08

**Attempt:** `20261008-01`

## Decision

Recommend a synchronous, bounded per-turn Host data provider with one strict raw-byte reader shared by the trusted context packet and actual Native `Read`. Reject Native `MemoryService` as the raw-byte authority because the actual service returns replacement-tolerant UTF-8 text without source bytes/hash and does not validate topic frontmatter. Reuse its path/root/topology behavior where appropriate. The full reasoning and minimal remap for U03–U08 are in [`docs/adr/P03-reuse.md`](../../../docs/adr/P03-reuse.md).

No production source, frozen P01 file, dependency, global setting, real Native profile, user memory, credential or upstream file was changed. The experiment used owned synthetic roots and local loopback only.

## Evidence

`topology-service/result.md` records the separate actual MemoryService comparison, 14 passing service/topology assertions, real ACL denial/recovery, same-name A/B repositories, linked worktrees, move/copy/repair and Native legacy-key/UUID differences. It documents replacement UTF-8 and frontmatter behavior as observed contract gaps. `topology-service/parser-result.json` records eight passing parser API assertions for Marked 16.4.2 and yaml 2.9.0, both currently unresolved by the Xiadie dependency graph.

The final Native result is [`native-runtime/run-08-runtime-result.json`](native-runtime/run-08-runtime-result.json), produced by the pinned Node 24.14.0 from the fixed Native checkout at `29628c9acdb81b703bbd4080c207a0e7ce5e276e`. The checkout HEAD and clean state were checked. Runtime/build inputs and host variant are hash-bound in that result and [`native-runtime/run-08-host-variant-manifest.json`](native-runtime/run-08-host-variant-manifest.json). The source-to-runtime binding is also verified in `topology-service/native-dist-compile-result.json` and `topology-service/native-dist-source-bindings-02.json`: a fresh isolated TypeScript 5.9.3 build of nine CLI packages produced 1,163 JavaScript files byte-identical to the actual Native checkout `dist`; 1,180 tracked inputs match Git blobs, and the one ignored `libs.generated.ts` input was regenerated from its tracked generator and 57 TypeScript library files. The compile and binding commands ran from the dedicated source-probe worktree and exited 0. Their command-record hashes are `7dcd20e9080cd18240fe5ebfbd462bb05d24b02f6a829ffb63024e22953f73ec` (compile), `df11b9749201c7c8126d09ad476841eac206493f954a993058a9ff6053f90c30` (first binding pass), and `eb3f67694be84ec151f2286ab42e75fbb6255c90c67cb54554eb1444ab8d5c8e` (final binding pass). The checkout and existing `dist` remained unchanged.

Run-08, from the final script bytes, observed 20 real Native provider requests, 10 Native `Read` calls, 12 provider samples and 10 clean Hook executions on one synthetic project/session. Complete identity-plus-memory packets were 5,478–5,574 UTF-8 bytes, below the existing 12,000-byte limit. On the second turn, the current Hook nonce mapped to the updated V2 SHA-256 and the follow-up Native provider request contained the current `Read` result. Earlier transcript history still contains the V1 marker; no transcript eviction is claimed. The 12,000-byte limit is a UTF-8 byte bound for the packet, not an estimate of the whole provider prompt or model tokens.

Normal failure and recovery cases passed:

| Case | Observed result |
|---|---|
| Three-year-old experience note versus current synthetic source | Native `Read` returned the old selected note and current source on request; the note stayed a lead, not a verified fact. |
| Topic changes between turns | Current packet carried the new content/hash; subsequent request included the actual Native Read result. |
| Source mutation after Host admission | Native Read returned `P03_MEMORY_SOURCE_CHANGED`, with matching current `turnId` and admitted snapshot hash; next turn succeeded after repair. |
| Invalid UTF-8 | Admission blocked before provider request with `P03_MEMORY_INVALID_UTF8`; no empty-success packet; repaired next turn succeeded. |
| Windows ACL deny | Actual `EPERM` blocked admission before provider request; ACL restore succeeded, memory SHA-256 stayed constant, next turn succeeded. Raw SID and ACL output are withheld; hashes are recorded. |
| Read outside the exact selected file/workspace | Adapter returned an explicit permission-denied result without returning the outside marker. |
| Cancellation | The held loopback response was aborted once; a subsequent fresh turn succeeded. |
| Unregistered `Write` | Native returned `TOOL_NOT_FOUND` / `Tool not found: Write`, correlated to call `p03-read-19`; the request exposed only `Read`; source and memory hashes were unchanged. |

The Write probe verifies Native registration/executor rejection only. Low-level filesystem write sandboxing is `NOT_RUN`. Native A/B provider-request isolation, real model, installed ZCode, DSH and credentials are `NOT_RUN`/`NOT_READ`. A/B and relocation are covered only by the independent service/topology fixture; no Native cross-project request pass is claimed.

## Runs and failures

All Native command records use cwd `E:\Xiadie\Xiadie\.runtime\P03\worktrees\u02`, fixed Node 24.14.0, and record argv, exit code, stdout/stderr. The SHA-256 values below bind each command record; the final unit manifest also covers all evidence files.

| Run | Exit | Command-record SHA-256 | Result |
|---|---:|---|---|
| run-01 | 1 | `d8b8bfffec321b5a345cf97f5d4af0c0bb292aeb54f863baf18f9da3be20b842` | Native TypeScript `.js` specifier could not resolve source `.ts`; failure retained. |
| run-02 | 1 | `1052ae7ba2119cc445dd632d9aaca471c34dd6dccee353052996a0f6da46584c` | Same loader failure; adopted the already-used P02 `tsx.register()` route. |
| run-03 | 1 | `e73954dcb05afb56281e5ec48ebabe3de89aad42c8f2cbcd8602091ac31ec75d` | Write-event assertion expected a tool name on Native error payload; corrected to correlate by emitted `toolCallId`. |
| run-04 | 1 | `d1d8331988bc3c733d906bc888447991f9dc35a0d693718faef5240304b0f78a` | Error text matcher omitted actual `Tool not found: Write`; exact observed error retained and matcher corrected. |
| run-05 | 0 | `cc37f4185dcd3722f99c676cd2a1f8ffea70dd09b6f90d73ba995be27899f55f` | Main Native route passed before ACL and final provenance-output changes. |
| run-06 | 1 | `3ae74a91537d0b351de85e042cf5f10143810741185a6f9f55fa68306a5cf1c8` | Hash collection treated the generated esbuild stdin entry as a disk file; corrected to bind the helper-materialized `host-variant-source.js`. |
| run-07 | 0 | `e6f0fbe3a53737b33fca895a21e9161f2de625522745ba6b17daa4ab102e8b2a` | Runtime and ACL denial/restoration/recovery passed; followed by a formatting-only script cleanup. |
| run-08 | 0 | `66b7c78c931b026dad3e20523257dc2c6118a9c82c8e41060409d426294701af` | Final worker bytes passed the full Native runtime and ACL denial/restoration/recovery. |

The exact build invocation and output are in `native-runtime/run-08-tsc-build-command.json` (SHA-256 `5a084c503f7ce3ae7397e5e5d03acafe2de8e2d5a46c4d40719370644626e81f`). Native run outputs are kept as immutable attempts; no failed directory was reused. The command supports an optional third CLI argument for a fresh, real-path-checked evidence directory below the repository `.runtime/P03`, outside this author worktree. Independent review should use that override and a new run id so its run cannot dirty this author evidence tree.

## Scope and limits

The spike proves a viable selected-topic route on one real Native runtime instance with a synthetic local provider. It does not prove production multi-Host snapshot ownership, Native A/B request isolation, real-model judgments, filesystem write sandboxing, or Windows packaged/Desktop integration. The reader currently uses one `globalThis` slot and is explicitly a single-host spike. The packet nonce is independently bound by the Hook receipt; the FS reader records admission-snapshot/source-hash binding, not nonce binding. Native built-in memory was disabled only for the test app to isolate the selected-topic route; no claim is made that a new UUID root inherits old Native memory.

Backout is `git revert` of the U02 author commit. All ACL modifications are removed in `finally`; the experiment verified subsequent reads. All fixture data lives under `.runtime/P03/experiments/20261008-01/native-runtime/` and topology experiment roots.

## Reproducibility

Run the command captured in `native-runtime/run-08-command.json` with its fixed executable and working directory. For an independent run, provide a new run id and third argument such as a fresh leaf directory under `E:\Xiadie\Xiadie\.runtime\P03\experiments\review-u02\`; the leaf must not already exist. The script clears inherited environment variables before importing Native/tsx modules, creates an isolated profile/data root, and binds the provider to `127.0.0.1` on an OS-allocated port.
