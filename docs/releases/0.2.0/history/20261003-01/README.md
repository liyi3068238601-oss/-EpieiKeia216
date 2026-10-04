# Xiadie 0.2.0 本机开发候选冻结

作者快照：ready_for_review，accepted:false，G02 待独立判定。当前权威结果见 [P02 状态](../../../evidence/P02/status.json) 和 [G02 接受记录](../../../evidence/P02-U11/20261003-01/acceptance.json)（接受后由协调者生成）；本页与 freeze.json 保留作者提交时的快照。

沿用 ZCode 原生 UI/Runtime 与 P01 已接受的精简 v3 遐蝶人设，保留历史版本；默认官方 DeepSeek Flash 路线不变。新增已提交事件、来源追踪、幂等写入、未知效果恢复约束、一致性备份/新根恢复和脱敏诊断。SQLite 位于固定 Node CLI 协议进程，非 Electron main；P01 sidecar 仍是 UI 关联证据，没有新增 renderer 证据面板。

实际候选构建提交 `e3d15af210ee6df3871bc6c10b99a093817db819`，上游 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。descriptor SHA-256 `e1b7b4fed3a910b709c89d2d9f5f861027b0394eb5236a3eeeac69b67e642d47`，绑定 6689 个产物、94 个项目输入；CLI SHA-256 `3ae3a5dc8514fb0e2a9c4527706f58284afced0499419654ebf677d2098446e4`。后续作者证据提交不是构建提交。[freeze.json](freeze.json) 保存完整分组哈希和证据索引，原候选保留于 `E:\Xiadie\Xiadie\.runtime\P02\experiments\u11\candidate-01`。

实际 0.2.0 候选重新构建并重跑：桌面主流程 **6/6**，无 Key/无 DSH/离线降级 **3/3**，每个账本状态验真均通过；生产配置及执行输入前后不变，固定 9229 禁用，动态 loopback 端口，无 DSH、无本轮付费调用。底层已接受 U10 的 82 项单元回归、作者/独立 Native8/8 和独立9场景账本状态复核作为阶段证据，分别记录，不把 mock 当付费模型。未准入或禁用场景按契约验证零事实/无账本，不声称存在已提交历史。P01 官方模型小样本评测是历史证据。

| 条目 | 实际依据 | 范围 |
| --- | --- | --- |
| G02 来源可追 | U03/U04/U05/U09、U10 实际 Native hook 与来源/回执；本次候选 hashes | 临时原文仅历史 hash/locator；currentValidation=NOT_VERIFIED |
| G02 已提交事实可恢复 | U07 重开恢复、U08 新根恢复、U10/U11 实际账本备份恢复 | 不恢复原文、主回复或整段对话；无事实时不编造历史 |
| G02 失败重试不伪造历史 | U05 重复/冲突/unknown ACK，U07 owned effect 一次与 child-kill，U10 BUSY/no replay | 未知效果需核查；非任意外部写入/发送/生成保证 |
| R03/R04/R05/R24 | [阶段需求映射](../../evals/P02/requirement-evidence.md)、十项先决接受、423项计划 hash 与实际 UI/SQLite reports | 仅 P02 阶段范围，非全项目 Must 关闭 |

目前是依赖本机固定源码/依赖目录的开发 assembly。安装器、可移植交付、真实 Desktop 付费路由、人工视觉验收、完整多会话编辑/并发、物理断电/磁盘故障及完整依赖闭包未验证。当前消息全遮蔽摄取不等于完整 transcript；诊断 turnSeal unavailable，历史扫描受上限约束。工作证据是固定 owned-artifact-integrity 机械核验，不代表任意业务结果。网络 guard 是进程 instrumentation，非 OS sandbox。角色游戏背景保留不构成原创 IP 或公共分发许可证明；上游 Apache-2.0 与第三方 notices 保留。Node SQLite 保留 experimental 警告。

[作者结果](../../../evidence/P02-U11/20261003-01/result.md) 与 [回滚](../../../evidence/P02-U11/20261003-01/rollback.md) 保存精确命令、cwd、exit、风险与保留路径。本轮不执行公开发布。下一节点为 [P03-U01](../../../planning/Xiadie_V2_v1.1/tasks/P03-U01.md)：原生 MEMORY 路径/索引/迁移/子代理 scope 和 ADR/交接模板调查；停在 G02，不自动启动该节点。
