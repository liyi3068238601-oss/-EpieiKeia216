# P01 需求证据映射

本文按冻结的 [P01 阶段计划](../../../planning/Xiadie_V2_v1.1/01_项目计划书.md#p01--010最小骨架与遐蝶角色)、[需求定义](../../requirements.md)及 [U10 任务卡](../../../planning/Xiadie_V2_v1.1/tasks/P01-U10.md) 与 [U11 任务卡](../../../planning/Xiadie_V2_v1.1/tasks/P01-U11.md)映射当前证据。需求范围保持原样：P01 对应 R01、R02、R03、R05、R06、R13；它们仍是 1.0.0 Must，P01 的阶段证据不等于全项目 Must 已完成。

当前状态和接受索引以 [`evidence/P01/status.json`](../../../evidence/P01/status.json) 为准：U01–U09 均 accepted，U10 running，U11 not_started，下一阶段尚未启动。索引列出每单元精确 acceptance/review 路径、摘要哈希和接受提交；表中链接对应单元结果。早期 result.md 中的 `ready_for_review` 是作者提交时快照，不覆盖当前接受索引。计划定义 G01 为“身份资产可验证，主交互可运行，失败不报成功，禁用扩展不破坏原生 Runtime”。G01 仍 pending；下表是接受单元支持范围和缺口，不是 G01 判定。

| Must | 已接受的 P01 证据 | 证据边界与待验证项 |
| --- | --- | --- |
| **R01 固定原创身份与表达连续性** | U01 记录角色来源及保留背景的决定；U04 接受版本化 persona 资产、manifest 和只读加载器；U05 只从获批角色生成 `ContextPacket`；U06 在实际 ZCode Loop 中执行身份/packet 前置门禁；U09 以实际 ZCode、固定资产哈希和两条官方模型 ID 完成 5 场景评测。见 [U01](../../../evidence/P01-U01/20261001-01/result.md)、[U04](../../../evidence/P01-U04/20261001-01/result.md)、[U05](../../../evidence/P01-U05/20261001-01/result.md)、[U06](../../../evidence/P01-U06/20261002-01/result.md)、[U09](../../../evidence/P01-U09/20261002-01/result.md)。 | Flash 是当前唯一合格候选；V4 Pro 已测但 disagreement 中反转了承诺主体，不能称为人格合格。U09 `human_review.status` 为 `not_reviewed`，runner 结果不替代人工角色审阅。保留的游戏背景不构成“角色原创”或公开发行权证明。U10 的 Desktop 集成仍待接受。 |
| **R02 ZCode 主工作与 Core/DSH 边界** | U02 比较并验证复用原生 ZCode 的路线；U06 使用固定版本原生 app、Hook、工具和单一 Loop，并验证扩展禁用；U07 把原生 `sendInput`/TurnResult 与工具终态回执投影关联；U09 验证普通回复、Read 成功及失败均来自实际 ZCode 路径。见 [U02](../../../evidence/P01-U02/20261001-01/result.md)、[U06](../../../evidence/P01-U06/20261002-01/result.md)、[U07](../../../evidence/P01-U07/20261002-01/result.md)、[U09](../../../evidence/P01-U09/20261002-01/result.md)。 | P01 未集成 DSH；U03 也明确尚无产品 Core 可供边界扫描。因此当前证据支持“测试路径复用 ZCode 主 Loop”，不能证明最终 Core/DSH 边界和所有普通请求的产品路由。U10 还需完成独立集成回归。 |
| **R03 先查现成、再试、后最小实现** | U01 调查成熟路线与来源；U02 保存隔离成功、失败、恢复及采纳理由；U03–U09 各自的 `result.md`、接受记录和独立审查保留实现取舍、失败修正与运行证据。全阶段索引见 [P01 状态/接受记录](../../../evidence/P01/status.json)，具体来源决定见 [U01 调查](../../../docs/research/P01/native-reuse.md) 与 [复用 ADR](../../../docs/adr/P01-reuse.md)。 | R03 适用于 P00–P16。这里只能证明 P01 已完成部分有调查和证据链，不能替其他阶段作证；U10/U11 自身的集成与 gate 审查仍未完成。 |
| **R05 多会话、消息操作与流式恢复** | U07 针对原生 admission ACK、`turnId`、completion 和成功/失败/partial/cancelled 回执建立投影并通过 native integration；U08 在隔离 profile 中两次启动实际 Desktop，验证 Settings 与预置的 ZCode 原生历史可读。见 [U07](../../../evidence/P01-U07/20261002-01/result.md)、[U08](../../../evidence/P01-U08/20261002-01/result.md)。 | 尚无 P01 证据覆盖 UI 中完整的查看、编辑、重发、停止、并发隔离及重启恢复矩阵。U08 验证的是隔离 profile 中的原生历史读取，不是 P02 应用持久层；U07 投影本身不持久化。U10 的真实发送与失败 UI 集成待接受。 |
| **R06 模型配置、能力矩阵和降级** | U02 对 `deepseek-flash`、`deepseek-v4-pro` 两个官方 model ID 做过原生路线验证；U09 保存两个 ID 的实测场景、工具回执和模型能力矩阵。见 [U02](../../../evidence/P01-U02/20261001-01/result.md)、[U09](../../../evidence/P01-U09/20261002-01/result.md) 及 [model-capabilities.json](../../../evidence/P01-U09/20261002-01/model-capabilities.json)。 | “两条路线都测过”不等于两模型都合格，也不证明后端独立性。当前只允许把 Flash 列为 P01 合格候选；Pro 的 persona qualification 未通过。U10 的实际模型选择/拒绝路径仍在集成验证，不能据此宣称最终可配置矩阵已完成。 |
| **R13 单轮来源分层与 token 预算** | U05 定义并验证来源分区、角色版本、序列化和 UTF-8 字节上限；U06 在实际 Hook/model delegate 路径核验 canonical packet；U07 保留 turn 级原生事件关联；U09 的 14 个真实模型请求均与对应 canonical packet hash 相符。见 [U05](../../../evidence/P01-U05/20261001-01/result.md)、[U06](../../../evidence/P01-U06/20261002-01/result.md)、[U07](../../../evidence/P01-U07/20261002-01/result.md)、[U09](../../../evidence/P01-U09/20261002-01/result.md)。 | U05 上限是 packet JSON 的 UTF-8 字节上限，不是 tokenizer 实测 token 预算；超限拒绝整包，不验证最终需求所述的确定性裁剪和保留当前请求。原生 system/project 规则也不在该 packet 预算中。R13 的完整 Must 留待后续阶段。 |

## 当前产品边界

- 用户在 Desktop 中看到的是 ZCode 原生回复。U07 的 turn/tool receipt 投影供宿主侧核验；U10 另有 sidecar 证据输出，不构成 renderer 中的回复证据面板，也没有增加另一层呈现 UI。
- U09 对两个模型都做了评测，但只把 Flash 定为合格候选；Pro 保留为已测、未合格。U09 人工审阅仍为 `not_reviewed`。
- U08/U10 的组装物是隔离本机验证用的 Desktop assembly/candidate，不是安装器、可移植发行包或已发布软件；安装、升级、卸载与发行资产验证未完成。
- P02 尚未开始，尚无 P02 应用级持久化。U08 的已验历史是隔离 profile 内 ZCode 原生预置记录；它不证明 Xiadie 事实存储、跨会话恢复或长期证据保存。

## Gate 状态

`status.json` 当前记录 U10 为 `running`、U11 为 `not_started`，且 `next_stage_started=false`。U10 candidate/UI 仍在真实集成与修复中；U11 负责根据最终精确产物和独立审查作 gate 决定。本文不更改状态，也不把构建、部分 UI 运行或已接受的前置单元写成 G01 pass。
