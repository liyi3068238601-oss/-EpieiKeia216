# P00-U09 DSH SDK lifecycle spike

**Status:** `ready_for_review` (`passed_with_limit`)

**Scope:** isolated SDK source-fallback runtime and protocol fixtures; no product runtime, production profile, or paid model call.

## Result

At pinned DSH commit `639ed015397290b3745d163aafe02ffee4aa3f84`, the real SDK client initialized the `sdk-minimal` runtime (`deepseek-harness-sdk-runtime` `0.0.1`), sent prompts to a local Anthropic-compatible `POST /v1/messages` mock, matched returned `messageId` values to `agent/inbox/spliced` receipts, observed `session.status=idle`, and captured the expected assistant text. The request carried only a synthetic credential, used a replacement child environment and isolated `DSH_HOME`, and advertised `tools: []`. The six SSE events were delayed by 35 ms each; first prompt to idle measured 270 ms in the final run.

`initialize` returned server information, not a session ID; the session was created by `prompt`. A duplicate receipt remained visible twice in `RunResult.events` while the flow still reached idle and returned the expected text. The empty-final fixture reached idle but returned `finalResponse: ""`; receipt and idle alone therefore do not establish a usable business result. An unterminated stdout banner made initialize time out after 600 ms. Closing a fake runtime that ignored EOF and SIGTERM terminated and awaited its directly owned process in about 210 ms; this is whole-runtime shutdown, not per-prompt cancellation.

Same `DSH_HOME` plus the same session ID was rejected on reopen with `session "…" already exists`, before another provider request. The SDK protocol exposes initialize, session/prompt, and shutdown; it has no native cancel, resume, session-close, or approval-response method. A new session after restart worked, but carried no earlier conversation. It is not reported as a resume.

The spike also exercised a small host-owned checkpoint. After SDK close, it reread a completed checkpoint from disk, verified its input/output hashes plus receipt and idle fields, and returned the stored answer without another provider request. A separately written `unknown` checkpoint remained `unknown` and caused no provider retry. This only demonstrates completed-result readback in the spike; it is neither crash-consistency testing nor native DSH recovery. Unknown in-flight work still requires a future host reconciliation/idempotency design.

On Windows, the SDK close test reaped the direct runtime process. A synthetic detached helper remained alive until the spike terminated the exact recorded PID. This is a bounded detached-child observation, not a claim that all child processes escape cleanup. In Node v24.16.0/libuv, detached children skip the normal association at lines 988–1001, while non-detached children are associated with libuv's global Job at lines 1016–1035. The earlier attached-child attempt ended with its runtime and is retained in `runs/author-08/` as diagnostic evidence. See the pinned [detached-child branch](https://github.com/nodejs/node/blob/v24.16.0/deps/uv/src/win/process.c#L988-L1001) and [Job assignment path](https://github.com/nodejs/node/blob/v24.16.0/deps/uv/src/win/process.c#L1016-L1035). The SDK's own launcher/disposer source remains the authority for what the SDK directly controls.

The coordinator separately ran the exact earlier core probe snapshot under an owned Windows Job: `runs/job-sdk-1790834591315205400/job/summary.json` reports exit 0, assignment before driver import, membership growing during SDK startup and returning to the gate before Job close, with zero model calls. The separate generic A/B containment result is recorded in `job-review.json`; neither artifact makes Job Object containment a native SDK cancel or recovery feature.

The coordinator then independently reran the final frozen `probe.ts` and launcher at the exact SHA values in `runs/root-review-final/execution.json`. That run exited 0 in 8.688 seconds; its `probe.json` confirms the actual SDK loopback flow, five passing fault/close cases, completed and unknown checkpoint checks without a retry, two local requests with empty tool lists, and zero paid calls. The 14 pinned source hashes matched, and both spike source hashes were identical before and after the run.

A detached-child contrast was also independently reviewed: `job-detached-review.json` (review SHA-256 `5115fb026fc7dfca3e2f346c2ca708c83ba717ecde5cead1162318182bde0cf2`) binds a coordinator run and independent rerun where the detached synthetic leaf remained alive after its parent exited, then became signaled when the external private Job closed. This validates the tested external containment fixture on this host; it does not extend native DSH shutdown semantics.

## Run and provenance

- Fixed source: `.runtime/P00/dsh/source`, HEAD `639ed015397290b3745d163aafe02ffee4aa3f84`.
- Runtime: Windows x64, Node `v24.16.0`, `tsx 4.22.4`, existing pinned dependencies. No install, full build, global configuration change, or production DSH access was performed for this attempt.
- Working directory: `E:\Xiadie\Xiadie`.
- Successful command used a fresh output directory:

```powershell
$env:TSX_TSCONFIG_PATH = 'E:\Xiadie\Xiadie\.runtime\P00\dsh\source\packages\sdk\client\tsconfig.json'
node --import 'file:///E:/Xiadie/Xiadie/.runtime/P00/dsh/source/node_modules/tsx/dist/esm/index.mjs' 'E:\Xiadie\Xiadie\spikes\dsh-sdk\probe.ts' --root 'E:\Xiadie\Xiadie' --output-dir 'E:\Xiadie\Xiadie\evidence\P00-U09\20261001-01\runs\author-12'
$probeExit = $LASTEXITCODE
Remove-Item Env:\TSX_TSCONFIG_PATH -ErrorAction SilentlyContinue
exit $probeExit
```

- Actual exit code: `0`; final probe status: `passed_with_limit`; paid model calls: `0`; two requests went only to the local loopback mock.
- Detailed run: `runs/author-12/probe.json`; raw process exit: `runs/author-12/exit-code.txt`; both completed and unknown checkpoint JSON files are in that run directory.
- Relevant pinned source files and SHA-256 values, spike source hashes, command/cwd/exit, Node/libuv reference, and root-owned Job evidence bindings are recorded in `verification.json`.
- Reproduction steps and the spike boundary are documented in [`spikes/dsh-sdk/README.md`](../../../spikes/dsh-sdk/README.md).
- Test mapping: the target `tests/units/P00-U09.test.ts` is represented by the currently executed `probe.ts` branches and captured bindings in `verification.json`, plus the coordinator's exact frozen-probe-under-Job and detached-child Job runs. This is a task-to-evidence mapping; no product test file or product test framework was run (`productTests: NOT_RUN`).

## Source behavior and limits

The SPIKE uses the fixed SDK client, `sdk-minimal` bundle, pinned fake-runtime protocol fixture, and pinned DeepSeek Messages SSE fixture. It does not copy upstream implementation into product code. Source lines supporting initialization, prompt receipt/idle, RPC type surface, shutdown, and the Windows libuv distinction are listed by path in `verification.json`.

No per-prompt cancel, approval round-trip, native session resume, full process-tree guarantee, process crash recovery, or product-runtime behavior was tested or claimed. `messageId` receipt is evidence of accepted input, `idle` is a runtime state, and assistant text must still be checked against the application's expected result. The final output directory excludes no fixture evidence; the evidence `.gitignore` excludes generated synthetic profiles, child environments, caches, and workspaces from source control without deleting them.

## Rollback

This unit is isolated to `spikes/dsh-sdk/` and `evidence/P00-U09/20261001-01/`. If the spike is rejected, revert only these author's source files; retain the raw run outputs and synthetic profiles as audit evidence. No generated directory was recursively deleted.
