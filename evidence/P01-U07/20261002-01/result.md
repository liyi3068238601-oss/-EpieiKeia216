# P01-U07 结果

状态：`ready_for_review`。工作分支 `p01-u07`，基线 `b02ea866e578899eebbdf7a6685665589d7c5a12`。

## 实现

新增 `packages/application/turn-projection.ts`，提供纯 `projectTurn()` 映射和每次原生输入使用的短期 `createTurnEventCollector(sessionId)`。装配方先订阅 `onSessionEvent`，将 `sendInput` 的 `started_turn.turnId` 绑定到 collector，等 completion 后用 `project(turnResult, requiredToolCallIds)` 得到最终投影，再退订并关闭 collector。collector 在 ACK 前暂存当前 session 事件，绑定后仅保留目标 turn；TurnResult 与 live feed 按 event ID 合并，保留 live feed 已分配的正序号，兼容原始 TurnResult 的 `sequenceNumber: 0`。同 ID 的 session、turn、类型或 payload 冲突会保持歧义并 fail closed；无 ID 时只用正 sequence 回退。

投影保留原生角色回复：只接受匹配 turn 的 `TurnResult.response`，再退到 `turn_complete.response`，最后退到最终流文本；不把 `model_complete` 的内部内容当回复，也不追加工具 payload。`turn_complete` 只映射生命周期；业务证据仅在调用方声明的全部 `requiredToolCallIds` 都有本回合成功终结 receipt 时为 `verified`。失败、缺失、部分、Hook block、取消和无工具对话分别独立表达；文本里的成功声明不会改变 receipt。错误只输出固定分类 `tool_error`，不暴露原始错误类型、message 或 stack。

后续 U08/U10 可在 session 事件订阅建立后调用 `sendInput`，用 admission ACK 的 turn ID 绑定 collector，并在 `completion` 返回后投影 TurnResult；调用方负责提供需要验证的 tool-call ID。该接口不持久化、不重放事件，不运行第二个模型，也不拥有 UI 或工具执行。

## 验证

固定参考源码为两个只读 checkout：`references/zcode-29628c9` 和 `.runtime/P00/zcode/source`，二者 HEAD 均为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。当前验证使用第二个 checkout 的编译产物，并在本地动态 loopback 端口连接合成 OpenAI 协议 fixture；原生 app、Loop、Read 工具实际运行，但没有使用真实模型、凭据或外部网络。integration 输出只包含经过筛选的事件类型、序号、toolCallId/name、success、error存在标记和 resultType。

最后一轮命令均在 `E:\Xiadie\Xiadie\.runtime\P01\worktrees\u07` 执行，node 为 `.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe`，PATH 前置固定 bin 与该 node 目录；Corepack 固定 pnpm 10.33.2。每条命令的精确 argv、cwd、退出码及 stdout/stderr 路径和 SHA-256 均保存在对应 `commands/*.json` 与 `logs/*.execution.json`：

- `build-06`：`corepack.js pnpm@10.33.2 run build`，exit 0。
- `check-05`：`corepack.js pnpm@10.33.2 run check`，exit 0；typecheck 通过。boundary checker 明确报告 `BOUNDARY_SCAN_NOT_RUN: packages/core is absent; no product Core imports were checked.`
- `unit-05`：`node E:\Xiadie\Xiadie\.runtime\P01\worktrees\u07\tools\run-tests.mjs unit P01-U07`，8/8 通过，覆盖重复事件、TurnResult seq=0 与 live 正序号同 ID 合并、同 ID payload/turn 冲突、Hook block、工具失败/缺失、部分与取消、角色回复和错误 canary。
- `integration-05`：`node E:\Xiadie\Xiadie\.runtime\P01\worktrees\u07\tools\run-tests.mjs integration P01-U07`，1/1 通过。成功、失败、partial 与取消样本都经原生 `sendInput` admission ACK 绑定 turn ID，并等待其 completion；真实 pinned native Loop 的样本包含工具成功（receipt success）、工具错误（terminal error）、双工具 partial（一个成功、一个失败）、`turn_complete.resultType=cancelled`。筛选后的原始 native 样本在 `logs/integration-05.stdout.log`。

最后 build/check/unit/integration 均通过。修复期间还保留了一次真实编译失败：`build-03` 因 OrderedEvent 未注解导致 TS2339；日志和执行记录完整保存在 `logs/build-03.*`，修复后后续 build 均通过。

## 变更与限制

改动仅限 turn 投影、其 unit/native integration 测试、测试映射、TypeScript include 与本证据目录。node_modules 为当前 worktree 的本地目录（非 junction）；固定参考源码未改动。未运行 GUI/DSH 端到端；`packages/core` 缺失，因此边界扫描没有覆盖产品 Core 导入。回滚可通过 revert 本任务提交完成。`manifest.json` 列出除自身外所有改动文件的字节数、SHA-256 和 Git blob ID。
