# P02-U03 implementation evidence

**Status:** `ready_for_review` (author; not accepted)
**Baseline:** `f20b2efbbfc1dcb5e6f52e5916419cff27578cf2`
**Mapping:** the task card's target `packages/contracts/events.ts` maps to the existing `packages/contracts/src/events.ts`.

## Contract

`events.ts` exports strict runtime-event types, normalization, canonical fact serialization, and a pure attempt projection. Generic source scope fields are explicit and nullable; projection requires non-empty session, turn, run, task, and attempt IDs. Identity is `(source, eventId)`. Canonical facts include `occurredAt` and exclude `observedAt` and `sourceSequence`; sorted canonical JSON is returned for the writer to hash without adding a Node or database dependency.

Native sequence `0` normalizes to `null`; negative, fractional, unsafe, and non-number values are rejected. `NormalizedEvent` has no `commitSequence`; the separate writer envelope accepts only positive safe integers. A writer sequence reused for another identity or different canonical facts is rejected. Same-identity/same-facts redelivery deduplicates and records resequencing; same identity with different facts preserves the first and audits a conflict with source, event ID, scope, and attempt reference.

`projectAttempt` binds all current-turn IDs and applies events in writer commit order. The first committed terminal (`success`, `failure`, `cancel`, or `interrupted`) wins regardless of source sequence or event time. Old attempts and events after that terminal are audit-only. Drafts remain separate; only a string `response` on the first successful terminal becomes the authoritative reply. Operation intent/receipt event kinds require a stable non-null `operationId`; standalone `OperationIntent` and `OperationReceipt` also require one. An unknown effect receipt does not authorize replay, and the effect receipt is a separate type from the writer's accepted-event envelope.

Normalization rejects extra fields, accessors, and forged event-level commit sequence, then deep-clones and freezes JSON payloads. A type fixture verifies the separation of writer sequence and the non-null operation ID contract.

## Verification

Pinned toolchain: Node `v24.14.0`, SHA-256 `63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088`; TypeScript `6.0.2`. The actual TypeScript compiler entry chain and its bytes, the modified contracts/tests/selector, and emitted contracts `dist` JavaScript were bound before and after final tests in `inputs-final-pre-02.json` and `inputs-final-post-02.json`. `input-comparison-02.json` reports 19 files unchanged and toolchain unchanged.

Final commands, all from the author worktree:

- `node.exe node_modules/typescript/bin/tsc --project tsconfig.json` — exit 0 (`commands/build-final-02.json`).
- `node.exe tools/run-tests.mjs unit P02-U03` — exit 0, 9/9 tests (`commands/unit-final-02.json`).
- `node.exe tools/run-tests.mjs contract P02-U03` — exit 0, 1/1 contract compile test; this includes the new event type fixture (`commands/contract-final-02.json`).

Initial failed compiler runs are retained as `commands/build-01.json` and `commands/build-02.json`; the reported `JsonValue` indexing diagnostics were fixed before the final successful build. No P01 native/runtime tests, persistence, external effects, or model/service runs are claimed by this contracts-only unit.

## 来源、风险与回滚

来源采用：遵循 `docs/adr/P02-reuse.md` 与已接受 U02（`evidence/P02-U02/20261003-01/acceptance.json`）的 source+event ID、首次提交终态和迟到审计原则；仅借鉴固定 DSH `639ed015397290b3745d163aafe02ffee4aa3f84` 的 append-only 事件及 Hook、工具、终态凭证分离语义（见 `docs/research/P02/runtime-reuse.md`），没有复制代码或实现 DSH 协议。风险：本单元只有 TypeScript 合同和内存投影，不实现 SQLite commit/receipt、崩溃恢复或重放；后续写入器必须提供 writer 序号并在集成层验证事务与恢复。回滚：若独立验收拒绝，revert 本单元提交；本次测试输出、失败记录及合成证据随提交保留，不涉及数据迁移。

The early `inputs-before.json` snapshot has a phase label that overstates its timing: it was captured after the first exploratory test run. The authoritative final pre/post binding is the `*-02` pair above; earlier evidence is left intact.
