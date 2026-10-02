# P01-U06 ZCode plugin thin integration

Status: `ready_for_review` (author submission; not accepted).

## Scope and reuse decision

The adapter keeps ZCode's pinned native app, Hook runner, model adapter, tools, project rules, and single native Loop. It adds the `xiadie` `0.1.0` local marketplace plugin, an approved-character and ContextPacket preflight, a bounded Hook receipt protocol, and a model-delegate gate that blocks before provider work when the current turn has no valid receipt or full canonical injection. Native marketplace installation, enable/disable, ordinary idle `sendInput`, `submitPrompt`, resume, and scoped compact preflight are exercised through the native bootstrap.

The read-only upstream source is `E:\Xiadie\Xiadie\.runtime\P00\zcode\source`, commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`, Apache-2.0. Its Git worktree was clean and compiled `dist` was present at verification. The integration loads that compiled runtime with the pinned TS loader because its bootstrap distribution still imports shared TypeScript source. The upstream tree and `references/zcode-29628c9` were not modified. This follows the accepted reuse route in `docs/adr/P01-reuse.md`; no second Loop or shell command path was introduced.

## Changed-path mapping

- `plugins/xiadie/`: native plugin and marketplace manifests plus installed Hook entrypoint.
- `packages/adapters/zcode/`: host/facade, protocol tests, native fixture tests, and child-process fault fixture.
- `tools/run-tests.mjs`, `tsconfig.json`: U06 test-selector and TypeScript source registration.
- `evidence/P01-U06/20261002-01/`: command records, raw logs, result, implementation diff, and file manifest.

No frozen planning, accepted evidence, production configuration, global ZCode configuration, source reference, Desktop distribution, or U07 path was changed.

## Verification

Recorded commands use the pinned Node `24.14.0`, pnpm `10.33.2`, and TypeScript `6.0.2`; `commands/*.json` records argv, cwd, environment, and input paths, while paired `logs/*.execution.json` records UTC start/end, exit code, and input/output hashes. Raw stdout and stderr are retained alongside those records. The frozen dependency install used `--ignore-scripts` in this worktree, without a node_modules junction to another checkout.

| Command record | Result |
| --- | --- |
| `native-integration-05` | 15 passed, 0 failed, 0 skipped. Real native marketplace install/discovery and installed Hook process; loopback OpenAI-compatible mock; native Read under the original project AGENTS rule; idle `sendInput` and `TurnResult`; cancel lifecycle; compact completion and fresh next-turn receipt; close/recreate with same session ID and persisted resume; disabled mode; timeout, nonzero, bad JSON, schema, missing receipt, truncation, missing Hook, unknown Hook path, and invalid persona block before model work. |
| `standard-check-01` | `pnpm check` exit 0; TypeScript check passed. Boundary scan reports `BOUNDARY_SCAN_NOT_RUN: packages/core is absent; no product Core imports were checked.` |
| `standard-unit-regression-02` | 26 passed, 0 failed, 0 skipped across U03–U06. |
| `standard-contract-regression-02` | 5 passed, 0 failed, 0 skipped across U03–U06. |
| `standard-integration-regression-02` | 40 passed, 0 failed, 0 skipped across U03–U06; listener delta was empty. |
| `build-13` | Build exit 0. |

Native provider requests used synthetic fixtures against a mock bound to `127.0.0.1:0`; there were no real model API calls or credential reads. Native fixture profiles isolate user config, storage, plugin storage, data, HOME, and TEMP. Memory extraction and dynamic workflows are disabled and `isProjectMemoryEnabled()` is asserted false for the supported profile.

Earlier failed attempts remain in `logs/` with their paired command records; no failed raw logs were overwritten. In particular, the early TS-source resolution and test-argument-binding failures are preserved, followed by successful corrected runs.

## Limits

This is a private-bootstrap adapter against the fixed ZCode commit, not a claim of compatibility with a stable public SDK. With the extension enabled, this host supports one idle public input at a time, `submitPrompt`, resume, and scoped native compaction. Concurrent queued/steered inputs and native subagent/background paths that skip `UserPromptSubmit` are unsupported; model calls without a current receipt are denied by the final gate. GUI/CLI assembly is unverified. Disabled mode delegates directly to native behavior. No Desktop/DSH process, distribution package, production profile, or U07 work was run.

U05 remains independently accepted (`evidence/P01-U05/20261001-01/acceptance.json`); this U06 submission awaits independent review. `manifest.json` lists every author-changed repository file in this attempt except the manifest itself, with byte count, SHA-256, and Git blob ID.
