# P02-U01 Runtime / transcript / Hook 调查

**范围与基线（2026-10-03）**：只读调查 P02-U01；未运行测试、模型或服务。Xiadie 根目录 `HEAD=2d02355bcc6453d8e54e78fde17a86676e82c932`（`p02-stage`，检查时工作树干净）。固定来源：ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`、Herta `4623df120adf99340ce5f7e25ed829466975e3ae`、DSH `639ed015397290b3745d163aafe02ffee4aa3f84`；三份引用树均为干净固定 checkout。`.runtime/P01/desktop-source` 和 `.runtime/P00/zcode/source` 都与 ZCode 固定引用同一提交。输入文件 SHA-256 与字节数见同目录 `inputs.sha256.csv`。

## 结论与有限默认路线

运行时出口已有可复用的 ZCode 原生边界：由 `runtime.subscribeEvents({onSessionEvent})` 监听事件，用原生 `sendInput` 的 `started_turn.turnId` 绑定当前轮，再将 live events 与 `TurnResult.events` 合并投影。现有 `packages/adapters/zcode/src/host.ts` 和 `packages/application/turn-projection.ts` 已实现这条薄适配路径；没有证据需要另建 Loop、Hook event bus 或把 Herta/DSH runtime 接进来。

默认只把事件流和原生 `TurnResult` 当作本轮运行证据；以 `sessionId + turnId` 限定范围、`event.id` 去重、`sequenceNumber` 排序，并把 Hook 决定、工具结果和回合终态分开。不要把 Hook transcript 当完整历史或持久记忆：它是 Hook 调用期生成的临时单行 JSONL。P02-U04 还要求在 Hook 生命周期内摄取材料：候选需同时保存有界脱敏副本、原始来源定位/hash 和脱敏版本/hash。收据只保存最小 allowlist 字段；原始 transcript/工具输出/隐藏推理不默认持久化或导出。来源空/超限/读取失败必须明确记录，不能用路径或摘要冒充完整材料。该路线是源码接口层的建议，尚非产品采用或运行验证结论。

## ZCode 固定源码里的实际运行行为

- **Hook 配置与临时 transcript**：本项目插件只配置 `UserPromptSubmit` 的 `type: process`，调用 `node ${ZCODE_PLUGIN_ROOT}/hooks/context.mjs`，8 秒超时（`plugins/xiadie/hooks/hooks.json`）。固定源码 `apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts:14-67,142-159` 把 Hook 输入原字段与兼容 snake_case 字段一并写入 stdin，包含 `transcript_path` / `transcriptPath`；tool Hook 另给 `tool_use_id`。它在系统 temp 下 `mkdtemp("zcode-hook-")`，写 `transcript.jsonl`：`UserPromptSubmit` 只有一条 user prompt，`Stop` 只有一条 assistant response/preview，其他 Hook transcript 为空；不是滚动对话历史。
- **生命周期**：process callback 在 `configured-runner-callback.ts:70-114` 的 `finally` 调用 cleanup，递归删除临时目录；command callback 同样在其 `finally` 清理。静态缺口：`configured-runner-input.ts:25-27` 在 `mkdtemp` 后先 `writeFile`，cleanup 函数要等写完才返回；若写入抛错，没有覆盖创建目录的外层 `finally`。强杀/断电会不会遗留目录、实测删除时点、是否有清理器，现有集成测试未核验。Hook 执行选项把 stdout 持久化设为 `none`，并传 timeout、进程 trace（`configured-runner-callback.ts:88-110`）。
- **顺序**：普通用户轮中先创建并 append `turn_started`，再跑 `UserPromptSubmit` Hook，之后才继续模型/工具（`core/src/runtime/methods/turn.ts:296-371`）；HookRunner 对同步 Hook 发 started 后，结束为 completed/blocked/failed（`core/src/hooks/runner.ts:59-123,156-248`）。工具调用沿 `toolCallId` 发 scheduled/started/result 或 error（`core/src/runtime/methods/tools.ts:38-60,135-150,180-247`）。接近 Stop 时 Hook 可请求同一轮继续；只有最后收口才 append `turn_complete`（`core/src/runtime/methods/turn-stop.ts:171-235`）。因而不能假定一个 Stop 就是终态，也不能将异步 Hook 完成时间当作回合边界。
- **身份与关联**：event envelope 是 `{id,sessionId,turnId?,type,timestamp,traceId,sequenceNumber,payload}`（`contracts/src/events/session.events.ts:71-81`）。`TurnStarted.payload.messageId` 是用户 message 锚点（同文件 `436-447`，创建处 `turn.ts:296-335`）；Hook 基础输入携带 session/turn/trace，没有 `messageId`（`contracts/src/hooks/index.ts:67-76,121-125`）。Hook lifecycle 有 invocation/run ID，可含 `toolCallId`，但没有 user message ID（同文件 `350-375`）。工具 ID 使用模型 tool-call ID，并贯穿调用结果（`runtime/methods/tools.ts:38-60,180-247`）。`createSessionEvent` 默认序号 0；event store 在 session 维度补单调序号，再由 `appendEvent` 先 append、走 durable persistence、最后通知 sink（`session.events.ts:1137-1156`；`in-memory-session-event-store.ts:61-73`；`methods/events.ts:81-110`）。
- **终态及其差别**：正常、prompt Hook 阻断都可能得到 `turn_complete`；阻断场景的 turn payload `resultType` 是 `success`，Hook 自身仍是 `hook_run_blocked`（`turn.ts:361-402`）。主动取消用 `turn_complete(resultType:"cancelled")`，真实执行错误用 `turn_error`（`helpers/turn-errors.ts:139-205`；payload 定义 `session.events.ts:576-610`）。因此 lifecycle success 不代表 Hook 放行，也不代表所有必需工具成功。
- **保留/重启边界**：bootstrap 默认用 `createInMemorySessionEventStore()`（`bootstrap/src/app/create-app.ts:730`）。固定策略 `turn-window` 将已结束轮标 sealed；下一个 `turn_started` 到来后淘汰此前 sealed 轮的瞬态事件，另由 60 秒低频 tick 按 120 秒 grace 周期淘汰（`contracts/src/events/session-event-retention.ts:22,50-95`；`in-memory-session-event-store.ts:76-120`）。`sequenceNumber` 计数器不会因淘汰回退。event append 有单独 durable session persistence 路径，但不能据此推断所有 transient/stream/progress 原文都可冷恢复；恢复后哪些事件仍在需用实际产品路径验证。

## 与现有 Xiadie 适配及测试的差额

`host.ts:73-100,128-138` 暴露 `TurnResult`、事件订阅、idle `sendInput` admission 和 Xiadie receipt；gate 在 Hook 输出中校验 session/turn、一次性 nonce、packet/transcript hash，再允许同轮模型调用（`host.ts:350-390,427-453,512-552,584-670`）。Hook envelope 没有 messageId，现有 gate 绑定到 turnId；receipt 中有 transcript 长度/hash，但并未保存 transcript 正文。`turn-projection.ts:96-143,145-237,240-353,355-395` 负责 pre-subscribe 后绑定 turn、只保留本 session/turn、ID/序号去重排序、工具收据、Hook block 与 lifecycle 分投影及 reply fallback。相同事件在 live stream / TurnResult 中重复时按 ID 合并；歧义冲突和无凭据按 unknown/unverified 处理。

已读而未运行的本地覆盖：`host.test.mjs:14-149` 覆盖 idle 锁、缺失收据、profile/storage 隔离；`contract.test.mjs:12-57` 覆盖 process Hook 合约、过大 stdin 和别名冲突；`native.integration.test.mjs:31-219` 覆盖实际 marketplace 安装/发现、子进程 Hook、原生 Read、loopback mock model、取消/恢复/compact、新鲜 receipt 及 Hook 故障 gate；`turn-projection.test.mjs:17-241` 覆盖去重/冲突、工具成功/失败、Hook block、取消及 collector；`native-projection.integration.test.mjs:20-129` 覆盖原生 Loop 的成功/失败/部分工具和取消。这些是测试代码覆盖面，不代表本次执行结果。

来源路径注意：两条 native integration 测试的默认 `sourceRoot` 都指 `.runtime/P00/zcode/source`（native Hook 测试见 `native.integration.test.mjs:14`，native projection 见 `native-projection.integration.test.mjs:11`）；历史 P01-U06 命令证据也设置 `P01_U06_ZCODE_SOURCE` 到 P00（`evidence/P01-U06/20261002-01/commands/native-integration-01.json`、`native-positive-01.json`）。P00 与 P01 desktop-source 的 Git 提交同为 `29628c9...`，因此是同一源码快照的既有证据，但没有本次从 P01 路径加载的实跑证明。Native tests 使用本地 loopback model mock，不是外部模型实测；本次没有运行它们，也未观察 Hook temp 文件运行后的磁盘状态。

## 对照候选

- **Herta（MIT；角色 prompt/媒体资产排除项仍受 LICENSE 限制）**：`references/herta-4623df12/packages/knowledge/src/dream/manifest.ts:61-190` 是梦境 JSON ledger；严格读取区分缺失/损坏并在损坏时保留原件、阻止 pass，宽松读取则缺失/损坏都回空；写入走原子替换并请求 fsync。相关 `manifest.test.ts:50-168`、`run-dream-pass.test.ts:2665-2736` 覆盖读写、迁移和损坏保护。它不是 SQLite 备份或 runtime event source。`references/herta-4623df12/packages/herta/src/narrative/actor-prompt.ts:19-43,173-220,355+` 提供类型化单次输入和确定性 serializer，过滤过期思考块；`actor-prompt.test.ts:503-839` 检查长记录前缀稳定。可借其 serializer/不变量测试方法；不能拿它证明 Hook、工具执行或终态，也不移植受排除角色文本。
- **DSH（MIT，固定提交）**：实际 `references/dsh-639ed015/packages/core/session/src/types.ts:281+` 定义按 session `seq` 排序、数字 turn 标识的 append-only event map；`references/dsh-639ed015/packages/sdk/protocol/src/types.ts:65+`、`sdk/server/src/server.ts:95+`、`sdk/client/src/api.ts:180+` 与 `sdk/client/src/types.ts:70+` 构成 event notify/订阅、prompt submit、入队回执和 idle 后 `RunResult`。idle 区间可能跨 turn，仍需按 `data.turn` 切分。`hooks/hook-protocol/src/types.ts:9+`、`events.ts:71+`、`runner.ts:67+` 将 hook invoked/result 作为 `handlerId` 配对的日志事件；Codex bridge 在 `hooks/hooks-codex/src/index.ts:205+` 映射 prompt/tool/stop 扩展点。hook/result 不能证明工具成功；看 tool/result 和 turn/end。DSH 的词汇、turn 类型与 Xiadie projection 不兼容，不直接复用投影器或替换当前 ZCode host；只借鉴 append-only 序号 envelope、hook/工具/终态凭证分离。测试证据静态路径：`hook-protocol/tests/events.spec.ts:10-105`、`hooks-codex/tests/bridge.spec.ts:73-217`、`sdk/client/tests/sdk-client.spec.ts:65-222,676-700`，本次未执行。

## P02-U02 Runtime 验证矩阵（建议；本次全部 NOT_RUN）

| 场景 | 隔离步骤/观测 | 通过条件 |
|---|---|---|
| 来源路径与端到端正常轮 | 显式将 fixture 指向 `.runtime/P01/desktop-source`；loopback mock、临时 profile/workspace；订阅后 `sendInput`，捕获 Hook 文件、event envelope、TurnResult | 原生 admission turnId 与 receipt turnId 一致；Hook 期间 transcript 可读且为规定单行；最终回复/终态和 tool IDs 对齐；无非 loopback 请求 |
| transcript 生命周期 | 记录临时目录；分别跑 Hook 成功、block、非零退出、超时/取消；另在隔离文件系统故障注入 write/进程中断 | callback finally 完成后目录不存在；明确测出写入失败及强杀窗口是否遗留，记录清理责任；不可将理论 finally 当实测 |
| 排序、重复、乱序 | 合并 live sink 与 TurnResult；重复 event ID、sequence=0、正序/乱序、同 ID 不同 payload、跨 session/turn 注入 | 按 ID/seq稳定去重排序；冲突 fail closed；拒绝非当前 session/turn；未确认事件保持 unknown |
| Hook/工具/回合分离 | 覆盖 Hook success/block/failure，tool success/failure/partial/missing，turn success/cancel/error/missing terminal | Hook blocked 即使 turn `success` 也仍 blocked；必需工具缺失/失败不报 verified；cancel 与 error 分型稳定 |
| 恢复/断电窗口 | 在 terminal 后但下一个 turn 前读取，再开始下一 turn；分别在通知、临时文件、持久化边界强制进程退出并重启隔离 fixture | 实测区分 memory turn-window transient、durable session entries 和临时文件；不把 seq 水位或 idle 回执冒充完成/恢复凭证；恢复结果可重复记录 |
| 未知外部效果 | 子进程执行期间 timeout/abort/硬杀；扫描隔离 TMP/profile、检查残留进程/写入和下一轮状态 | 记录 process 是否终止、清理是否发生、失败是否阻止模型调用、下轮能否重新 admission；先 mock，真实外部模型/API 不在本任务授权范围 |

矩阵依据 P02-U02 卡片的“临时文件失效、乱序、重复、断电窗口和未知外部效果”及“先 mock 再获授权的真实路径”；本报告没有启动上述路径。固定 ZCode 来源许可证为 Apache-2.0（另核 NOTICE/第三方边界后再移植）；Herta/DSH 根许可证为 MIT，Herta LICENSE 明列角色素材排除。
