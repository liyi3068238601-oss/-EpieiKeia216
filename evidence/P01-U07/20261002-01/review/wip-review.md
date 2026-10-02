# 历史 WIP 记录：已由 report.json 最终审查替代；sequence-zero 去重问题已在 author commit e3e3c5e2d22f29986d9ba5c7f6d0bb037d8f3bf9 修复并通过独立反例。

# P01-U07 WIP 源码审查

- 状态：review_in_progress；不是通过结论。
- 审查目标：作者工作树 `.runtime/P01/worktrees/u07` 当前 WIP；HEAD/baseline `b02ea866e578899eebbdf7a6685665589d7c5a12`。尚无 ready author commit。
- 范围：只读检查 `packages/application/turn-projection.ts`、对应单测/映射与 pinned ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 源码；未运行测试，未改产品/根状态/既有证据。

## 阻塞缺陷

**[高] `TurnResult.events` 中 sequenceNumber 为 0 的原始事件会被整体错误去重。** `eventKey()` 当前优先使用 `(sessionId, sequenceNumber)`。Pinned source 的 `createSessionEvent()` 默认 `sequenceNumber: 0`；`appendEvent()` 将带 event-store sequence 的 spread 传给 live sinks，但不修改原 event 对象；turn 方法另将原对象放进 `events` 并作为 `TurnResult.events` 返回。因此，合并 live subscription 与 TurnResult 时，多个 TurnResult 事件会竞争同一个 `sequence:<session>:0` key；终态事件可能把该条目标为 ambiguous，其他工具终态则被丢弃。仅传 `TurnResult.events` 时同样无法可靠投影工具收据，部分 live feed 时也可能丢失补充收据。

建议：事件有非空 `id` 时优先按 id 去重；仅无 id 时退回 session/sequence。增加独立反例：相同 event id 在 live feed 中有分配后的正序号、在 TurnResult.events 中为 0；再单独覆盖多个不同 ID 的 TurnResult-only sequence-0 事件。

证据位置：`references/zcode-29628c9/apps/zcode-cli/packages/contracts/src/events/session.events.ts` 的 `createSessionEvent`；`references/zcode-29628c9/apps/zcode-cli/packages/core/src/runtime/methods/events.ts` 的 `appendEvent`；`references/zcode-29628c9/apps/zcode-cli/packages/core/src/runtime/methods/turn.ts` 的事件入数组和返回路径。

## 当前 WIP 已见情况

- terminal-only `tool_call_result(success=true)` 当前会从初始 `unknown` 正确转为 `succeeded`，对应“首次结果无法 verified”问题看起来已修复。
- 相同 sequence 的 success/failure 冲突当前会设置 ambiguous 并将对应收据降为 unknown，对应 first-wins 问题看起来已修复。
- 开放字符串 `ErrorPayload.type` 当前不原样输出，而固定为 `tool_error`；这是安全的通用分类。最终审查仍需确认作者没有改回透传。
- 当前改动另包含 `tools/run-tests.mjs` 与 `tsconfig.json` 的 U07 映射/编译纳入，需在 ready 版确认与任务卡允许范围及报告一致。

接收 ready author commit 后，在其精确独立 worktree 完成离线验证、独立反例、manifest/hash/Git blob 核验，再给 pass 或 changes_required。

