# U02 Runtime / Hook isolation PoC

## 结论

固定 ZCode 来源 `E:\Xiadie\Xiadie\.runtime\P01\desktop-source`，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。PoC 直接调用该来源编译产物中的 `createCompatibleHookStdin` 与 `createConfiguredHookCallback`，并直接实例化 `InMemorySessionEventStore`；Hook 子程序是本 WT 的合成 Node child，执行端口 `run()` 是 PoC 隔离适配器，不是生产执行器。未启动模型、服务或网络。

## 实际观察

- `configured-runner-input.js:6-51,107-123` 为输入生成 `zcode-hook-*` 临时目录与 `transcript.jsonl`。`UserPromptSubmit` transcript 仅有一条当前 user prompt；`PostToolUse` transcript 为零字节。输入同步含 `sessionId/session_id`、`hookEventName/hook_event_name`，tool alias 含 `tool_use_id`。PoC 在 child 存活时读取该文件、校验单行/当前消息、只保存 `[REDACTED]`、UTF-8 字节数和 SHA-256；成功、exit 2 与 exit 7 后，native callback 都在返回/拒绝前执行 `finally -> cleanup()`，路径已不存在。
- `configured-runner-callback.js:40-76,79-111,139-177` 的 process Hook 调用注入的 execution port，向 trace 传 `traceId/sessionId/turnId` 和 `hookEventName/hookIndex/matcherIndex`。成功 exit 0 解析 Hook JSON；exit 2 对此输入生成 `continue:false` block；exit 7 拒绝并抛 `TOOL_EXECUTION_FAILED`。PoC 真正 `spawn()` 了自己的 Node child（`shell:false`，每例单独 PID），但执行端口的超时/输出截断策略仅是 spike 实现；未验证真实产品 runner、超时/取消或进程树终止。
- `createCompatibleHookStdin()` 在 `mkdtemp()` 后、返回 cleanup 前执行 `writeFile()`。专属 child 对该 child 进程内的 `fs.promises.writeFile` 做定点故障注入，实测 `writeFile(transcript.jsonl)` 拒绝且 cleanup 未返回、留下 `zcode-hook-*`；探针记录目录后只删除自己本轮新建的残留。它不能证明 OS 崩溃或 ACL 故障行为。
- 512 KiB 边界候选在 spike 中按 regular-file、大小上限、读前后 size/mtime、完整换行和 JSON parse 检查；oversize（524,289 bytes）、半行和不存在文件（`ENOENT`）均为 `saved:false`，没有写脱敏快照。ACL denied、并发写变体及文件替换竞态未运行；这个候选不是产品实现。
- `in-memory-session-event-store.js:9-45,64-85` 保留 append 顺序、对缺省/非正序号分配 session 级 seq，并以 `max()` 推进计数器；输入的正 sequence 原样采用。重复 event `id` 不去重（同 ID 两条得 seq 1、2）；输入 seq `20,5,0` 后读回 append 顺序 `[20,5,21]`，不重排。turn-window 仅在后继 `TurnStarted` 到达时淘汰已 sealed turn 的 transient 类型，terminal `TurnComplete` 保留；新 store 为空只说明实例内存，不是重启/恢复验证。`session-event-retention.js:7-21,24-76` 列出 transient 类型与 `TurnComplete/TurnError` sealing 规则。

## 运行记录与限制

在作者 WT `E:\Xiadie\Xiadie\.runtime\P02\worktrees\u02` 运行指定 Node `v24.14.0`。主命令为 `node --import file:///E:/Xiadie/Xiadie/.runtime/P01/desktop-source/node_modules/tsx/dist/loader.mjs spikes/P02/runtime-poc.mjs`，exit 0；逐进程 TEMP/TMP 指向实验 profile。加入该来源自带 tsx 4.21.0 loader，是因为固定编译入口的 workspace TS 依赖使用 `.js` specifier，但 checkout 对应文件只有 `.ts`。实际 Hook 子进程也以相同 loader 参数启动。loader 缓存仍在实验隔离 profile 的 `tsx-liyi` 临时子目录，不能与 ZCode transcript 混淆。

机器可读结果：实验目录中的 `command.json`、`summary.json`、`child-runs.json`、`input-sha256.json`、`source-index.json`、`artifacts-sha256.json`、`stdout.txt`、`stderr.txt`、`exit-code.txt`。最终矩阵：Hook exit `[0,2,7]`；重复 ID seq `[1,2]`；乱序序号 `[20,5,21]`；writeFile 清理缺口已注入复现。compiled native source、Node、tsx loader/package 的 bytes/SHA-256 均有索引。PoC 未运行真实模型、DSH、服务、ACL denial、timeout/cancel、崩溃恢复。

## 有限默认路线建议

可复用 ZCode 的 Hook JSON 输入构造、Hook output/exit-code 归一化、session event append/retention 接口；临时 transcript 仅包含当前消息/Stop 响应，不能作为完整历史。运行时持久状态应由上层另建、显式做 stable identity 去重及 canonical sequence/terminal 规范化，不能把内存 store 的 `id` 或 seq 当跨会话身份；保留限长、快照脱敏、读失败不保存并在全部路径 cleanup 的候选规则。write 之前的 `mkdtemp` 需要调用侧补偿清理，或后续独立改源并测试；本 PoC 只标定缺口，没有提出生产修改。
