# P03 memory reuse decision

**ID / date / status:** P03-ADR-001 · 2026-10-08 · author decision, `ready_for_review`; not independently accepted

**Affected work:** P03-U03–U08

**Supersedes:** none

## Problem and constraints

Xiadie creates a new `ContextPacket` during each serialized Host admission, but the frozen P01 factory has no selected-project memory provider. Native initializes and caches its own memory index; enabling that feature does not demonstrate a fresh selected topic on later turns. The design must bind the selected project, current source bytes and hash to the current Host ticket, allow Native `Read` of only that selected topic, preserve Native identity and existing system/project rules, surface missing/corrupt/permission/race failures, and leave P01 unchanged. All U02 data is synthetic and all servers bind to dynamically allocated loopback ports.

## Source and experiment evidence

The fixed Native checkout is `29628c9acdb81b703bbd4080c207a0e7ce5e276e`; its Git HEAD and clean status were checked before runtime imports. `topology-service/native-dist-compile-result.json` binds a fresh, isolated TypeScript 5.9.3 compile of nine Native CLI packages: all 1,163 generated JavaScript files match the checkout's existing `dist` byte-for-byte. `native-dist-source-bindings-02.json` binds 1,180 tracked config/package/TypeScript inputs to their Git blobs and verifies the sole ignored generated `libs.generated.ts` from its tracked generator plus the 57 installed TypeScript library files. The compile and binding operations exited 0; the pinned checkout and existing `dist` were not modified. The final Native runtime file and Xiadie build hashes are recorded in `native-runtime/run-08-runtime-result.json`.

The pinned Native `MemoryService` route was built and executed as a standalone comparison. The final service/topology run passed 14 assertions: same-named A/B repositories, linked worktrees, same-volume move, cross-volume copy and `git worktree repair`, legacy path-key versus explicit UUID projection, access control, containment, junctions and size limits. The observed route preserves safe path resolution and stable-handle checks, but returns replacement-tolerant UTF-8 text without original bytes or a raw-byte hash, and does not validate topic frontmatter. A string hash cannot stand in for the source-file hash. See `evidence/P03-U02/20261008-01/topology-service/result.md` and its command, source, bundle, ACL and fixture records.

The parser contract probe passed eight assertions against the pinned Marked 16.4.2 Lexer and yaml 2.9.0 `parseDocument`/alias APIs, including Markdown comment/reference-link distinction and surfaced YAML errors. Neither package currently resolves from Xiadie. U04 should add exact direct dependencies and license records, rather than import from the reference checkout. See `topology-service/parser-result.json` and `parser-run-01-command.json`.

The final Native run used the bounded synchronous Host provider and strict raw-byte reader described below. It recorded 20 actual loopback provider requests, 10 real Native `Read` calls, 12 provider samples, and 10 successful Hook executions. Each complete identity-plus-memory Hook packet was 5,478–5,574 UTF-8 bytes, within the existing 12,000-byte packet upper bound. The complete provider request grows as Native conversation history accumulates; the measured packet size is not a total prompt/token estimate. In the changed-topic turn, the current nonce-bound Hook packet carried the V2 content hash and the subsequent Native request included the actual `Read` result. Earlier history may still contain V1; this experiment does not claim transcript deletion.

Failure and recovery evidence includes:

- A stale three-year synthetic experience lead conflicts with current synthetic source. The old note remains a lead; a separate actual Native `Read` returns current source and the selected topic.
- A source mutation after admission causes a `P03_MEMORY_SOURCE_CHANGED` Read error correlated to that turn ID and its admitted source hash. Repairing the fixture allows a fresh turn to read the new bytes.
- Invalid UTF-8 blocks before a Native provider request. Repair is followed by successful sampling and Read.
- A real Windows ACL deny produces `EPERM` before a provider request. The deny is removed in `finally`; the file hash is unchanged and a later turn succeeds. Raw SID and ACL output are not written; only a SID hash and output hashes are retained.
- An outside-allowlist Read is rejected. Cancellation aborts the held loopback response once and the next turn completes.
- A provider-issued unregistered `Write` is rejected by Native with `TOOL_NOT_FOUND`, correlated to the mock call ID; the synthetic source and memory hashes are unchanged. This proves tool registry/executor rejection only; a low-level filesystem write sandbox was `NOT_RUN`.

Native A/B model-request isolation, a real model, installed ZCode application, DSH and credentials are `NOT_RUN`/`NOT_READ`. The topology/service sub-experiment covers A/B and relocation without claiming those Native request guarantees. Full command/cwd/exit/stderr records and hashes are collected in the unit manifest.

## Decision

Adopt a synchronous, bounded, per-admitted-turn data provider at the existing Host preflight seam, and use one strict raw-byte reader for both the trusted packet sample and the Native `Read` bridge. The provider returns exactly the `state`, `evidence` and `content` data partitions; it does not provide instructions. The Host’s existing nonce, identity gate, serialized admission, ticket and packet budget remain authoritative. The Hook receives only the validated packet data through a trusted per-turn environment value and rebuilds the same packet under the existing nonce/session/transcript receipt checks.

The reader permits only the explicitly selected `selected.md` below the resolved project memory root, reads at most 2 KiB from a stable file handle, rejects symlinks/non-regular files/path changes, computes SHA-256 over original bytes and uses fatal UTF-8 decoding. Native `Read` must match the current admission snapshot and re-check the source hash; a changed source is a visible error, never an empty successful result. This is the smallest measured implementation gap. The synchronous route fits the current serialized Host preflight and avoids an async state machine whose cancellation and lock lifecycle the task does not need. The Native `MemoryService` remains useful for its project-root/topology and stable-path behavior, but is not selected as the source of raw-byte authority for this Read contract.

The PoC's `globalThis` snapshot key is explicitly single-Host. It is not safe to reuse across multiple app instances. Production work must replace it with per-Host state (or another proven ticket-local binding); this U02 limitation is not an approved production design. The snapshot itself is not claimed to contain the Native nonce. The Hook packet/receipt and actual request evidence establish nonce association; reader traces report only `admissionSnapshotBound`/source-hash binding.

Native's built-in project-memory loader is disabled only in this isolated runtime so it cannot mask or duplicate the tested selected-topic route. The experiment preserves Native system/identity/project context and the Read tool contract. No production source or frozen P01 files were changed.

## Alternatives and scope remap

- **Native `MemoryService` as the selected-topic provider and Read authority:** rejected for this contract because its returned text loses raw-byte identity and invalid UTF-8 is replaced. Retain its safe project-root/topology knowledge; do not reread its result separately and label that hash a source hash.
- **Async provider or persistent disk snapshot:** rejected as unnecessary for the measured bounded synchronous read. U02 uses no snapshot file lifecycle, background worker or async ticket cancellation protocol.
- **Native startup/context cache as freshness mechanism:** rejected because the cache is initialized once and reused. Every turn must sample the selected topic through the Host seam.
- **U03:** implement app-owned UUID registration and explicit Native legacy-key aliases/ownership. Do not equate a new UUID projection with absent legacy knowledge; distinguish same-name repositories, linked worktrees, copy/fork and physical relocation. U02 only measured the Native key behavior in owned fixtures.
- **U04:** implement the narrowly remapped Host provider and trusted Hook data handoff in `packages/adapters/zcode/src/host.ts` and `plugins/xiadie/hooks/context.mjs`, preserve all existing receipt checks, and add exact Marked/yaml dependencies with lock/license records. Use strict UTF-8, Marked Lexer tokens, bounded YAML aliases and surfaced parse errors; do not scan archives recursively.
- **U05:** define the four explicit memory states and source authority policy. Current code/tests/accepted ADR are facts; experience notes remain leads until verified. Missing, denied, malformed and changed inputs must remain distinguishable and recover on a later admitted turn.
- **U06:** verify complete explicit export/relocation with a full supported-file manifest, hashes, conflicts and rollback. Selected-topic packet bytes are not a complete project-memory export. Keep one active canonical root and treat workspace movement separately from data-root movement.
- **U07:** prove handoff and persistence boundaries separately. This U02 unregistered-Write result does not authorize notes-only writes, broad sandbox claims, Edit/Bash/MCP or persistent-memory mutation.
- **U08:** verify reopen and later-turn freshness against accepted mappings and current source. Preserve old Native history; do not claim the tested mock behavior proves real-model judgments.

These remaps are recommendations for the dependent units, not implementation authorization within U02. No global configuration, production memory, real credentials or upstream source was changed.

## Cost, compatibility, validation and rollback

The provider is an additional synchronous read of a single bounded selected topic at each admitted turn. Packet JSON is covered by the existing byte budget; no package was added in U02. U04's two parser dependencies are exact-version candidates with licenses already inspected. The remaining implementation risk is per-Host snapshot ownership: this PoC uses one global slot and must be replaced before multi-Host production use. Formal review must rerun the final script bytes using the evidence-output override and independently verify the source/build binding records.

Commands, failed attempts, output hashes and freeze manifest are in `evidence/P03-U02/20261008-01/`. Rollback is reverting the U02 commit; every Native profile, Git repository, ACL target and memory file used was synthetic and isolated under `.runtime/P03/experiments/`. Independent review and acceptance remain pending.

**Author:** ready for independent review.
**Independent approval:** pending.
