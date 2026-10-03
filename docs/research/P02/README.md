# P02 事件与恢复调查

日期：2026-10-03。前置 P01-U11/G01 已接受；基线 `2d02355bcc6453d8e54e78fde17a86676e82c932`。本单元只调查，作者状态为 `ready_for_review`；采用路线须经 U02 隔离试验和独立接受后才能用于产品实现。

## 当前已有能力

P01 已接入固定 ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的原生 Loop、Hook 和事件订阅。`packages/application/turn-projection.ts` 是单轮内存投影，支持 turn/tool 去重与冲突提示；`createTurnEventCollector` 关闭会清空内存，未构成持久化事件事实库。它按来源序号选择末端事件的策略不能直接代替 P02 的互斥终态规则。

固定源码 `core/src/hooks/configured-runner-input.ts` 生成临时 JSONL，UserPromptSubmit 只有当前用户消息、Stop 只有当前回复，其余 Hook 为空。它不是完整会话历史。`configured-runner-callback.ts` 在 `finally` 中删除文件；只保存 `transcript_path` 会失效。P02 必须在回调期间完成有界读取、哈希和脱敏，保存原始来源定位与派生快照的关系。

固定源码 `contracts/src/events/in-memory-session-event-store.ts` 按会话分配递增序号；它是进程内 store。`session-event-retention.ts` 会淘汰 streaming/progress 等瞬态事件。订阅得到事件或排队成功不等于已经持久化，重启后的完整原始 delta 也不能从内存重建。

`core/src/runtime/methods/events.ts` 先 append、再做原生 durable persistence、最后通知 sink；durable persistence 对不同事件类型分别处理，并不意味着全部流式细节永存。`notifyEventSinks` 会捕获并记录 sink 失败，原生 turn 继续，因此 Xiadie 的存储失败必须通过自己的提交回执/诊断显式呈现，不能因为原生 turn 成功而报告“保存成功”。取消是 `turn_complete.resultType=cancelled`，不能只凭事件名 turn_complete 判定成功。

固定 ZCode SQLite session store 使用 `node:sqlite`，不是 better-sqlite3。原生 migration runner 已有 WAL、锁等待、checksum 账本和事务回滚设计；P02 对未来 schema 拒写、升级前备份和新事实表仍需明确补充及试验。不能将原生会话数据表整体复制成另一套 Runtime。

以上路径以固定来源 `apps/zcode-cli/packages/` 为前缀；本地 source index 记录实际文件字节和 SHA-256。研究只读源码、测试、许可与安装配置；这里没有把源码观察写成产品运行通过。

## 候选比较

| 路线 | 可复用部分 | 缺口和代价 | U01 候选结论 |
| --- | --- | --- | --- |
| A：原生出口 + 薄摄取 + 独立规范化事实库 | 固定 Runtime/Hook、原生日志定位、现有身份宿主、Node SQLite API | 有界捕获/写队列、唯一事件键、事务、运行终态和效果未知、备份与诊断；内部接缝须锁定版本 | 优先交给 U02；不复制原生调度器，不改生产数据库 |
| B：直接依赖原生会话 store/回放作全部证据 | 原生消息和本地会话记录 | Hook 片段短期存在，部分事件仅内存驻留；缺独立事件冲突规则、operation_id 回执和应用事实约束 | 不足以单独满足 G02；保留原生日志为来源权威 |
| C：引入另一套 DSH/Herta Runtime 或完整事件框架 | 既有协议、manifest、source+id 身份和 pending recovery 设计 | 重复客户端/调度/数据权限；Herta 角色资产许可排除；与已接受 P01 接缝不同 | 只借设计与测试，拒绝作为主回复/全量 Runtime 替换 |

SQLite 的绑定、迁移与备份候选细节见同目录 SQLite 调查；Runtime、Herta、DSH 精确接口及测试范围见 Runtime 调查。待 U02 判断：复用已有 `node:sqlite` + SQLite 原生事务/online backup，或在实证不匹配后选择其他绑定。U01 不批准新增生产依赖。

CloudEvents v1.0.2 的 [source 与 id 身份规则](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)可作为去重设计参考：来源加 ID 标识事实，同一身份重投递与不同载荷冲突分开处理。这里只借设计，没有声明 CloudEvents wire 合规或引入 SDK。

## U02 的可复查试验边界

1. 固定原生 Hook 实现：回调内读到材料、退出后路径失效；测试空片段、超限、半行/坏 JSONL、不可读。原始输入只用合成内容。
2. 固定原生 event store 与来源样例：来源序号是会话级；注入乱序、重投递、同 ID 异载荷，验证拟用事实键与互斥终态，不把取消后的迟到 success 改成成功。
3. 固定 Node 24.14.0 SQLite API：同事务写来源/事件/派生引用，用唯一约束检验重复与冲突。分别在 commit 前和 commit 后、确认前强制结束自有子进程，重开并核查实际记录。
4. 自有合成外部动作：记录 operation_id；检查回执存在与丢失时的恢复判断。没有确认的效果必须 unknown/needs_review，恢复不自动再调用写工具、模型或发送。
5. 活跃 WAL 的 online backup：新目录恢复后查 integrity、schema 和事实，证明单拷主文件不足；测试锁占用、SQLITE_FULL 可控限制、迁移异常/中断和未来 schema 拒写。

这些是待运行矩阵，不能当作通过结果。U02 必须把 mock、真实原生函数/SQLite 路径、完整 Desktop、真实模型和物理断电分开标记；真实模型与生产 transcript 导出不在当前 P02 授权内。

## 搜索、权限、风险与回滚

检索词、日期、URL、固定提交、文件范围、依赖和命令结果附在本单元 research records。当前 [Hooks 文档](https://zcode.z.ai/en/docs/hooks)为可变页面；实验使用固定源码语义，文档存在 `transcript_path` 不证明其完整性或持久性。

不执行安装、不创建业务 DB、不启动 DSH/Dream、不访问真实用户聊天、也不读取或输出凭据。借用 Node 内置 SQLite 仍需记录版本实验性与同步阻塞风险；无界写队列、隐藏推理/密钥默认落盘、备份覆写现有目标均不接受。

回滚仅 revert 本单元独立研究提交。固定来源、P01 接受链、用户配置和历史素材原位保留。未接受 U01/U02 前不动产品模块。
