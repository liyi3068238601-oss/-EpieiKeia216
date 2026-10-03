# P01 需求证据映射

权威范围来自冻结的 [P01 阶段计划](../../../planning/Xiadie_V2_v1.1/01_项目计划书.md#p01--010最小骨架与遐蝶角色)和 [需求定义](../../requirements.md)。P01 对应 R01、R02、R03、R05、R06、R13；本阶段证据不等于这些 1.0.0 Must 已全部完成。

U01–U11 均已 accepted，G01 已 pass，0.1.0 本地开发候选已冻结。精确 author、review、acceptance 和集成提交见 [状态索引](../../../evidence/P01/status.json)；版本范围和哈希见 [冻结记录](../../releases/0.1.0/README.md)、[freeze.json](../../releases/0.1.0/freeze.json)。早期结果中的 ready_for_review/pending/running 为历史快照，以当前接受索引为准。P02 尚未开始。

| Must | 已接受的 P01 证据 | 保留边界 |
| --- | --- | --- |
| **R01 固定原创身份与表达连续性** | [U04](../../../evidence/P01-U04/20261001-01/result.md) 的版本化 persona/manifest 和只读加载器；[U05](../../../evidence/P01-U05/20261001-01/result.md) 的 ContextPacket；[U06](../../../evidence/P01-U06/20261002-01/result.md) 原生 Loop 身份门禁；[U09](../../../evidence/P01-U09/20261002-01/result.md) 两个官方模型 ID、5 场景实测；[U10](../../../evidence/P01-U10/20261002-01/result.md) 与 [U11](../../../evidence/P01-U11/20261002-01/result.md) Desktop 集成。 | 用户审核 v3 精简角色且保留所有版本；保留游戏背景是明确的范围偏差，不能声称角色原创或公开发行权。Flash 仅在已测 v3/5 场景中合格；Pro 的承诺主体反转问题未解决。U09 人工评测仍 not_reviewed。 |
| **R02 ZCode 主工作与 Core/DSH 边界** | [U02](../../../evidence/P01-U02/20261001-01/result.md) 复用试验；U06 原生 app/Hook/单一 Loop；[U07](../../../evidence/P01-U07/20261002-01/result.md) sendInput/turn/tool 回执投影；U10/U11 实际 Desktop 的启用、禁用及无 DSH 路线。 | P01 未集成 DSH、未建立最终 Core；check 的 BOUNDARY_SCAN_NOT_RUN 保留。已验路径不能替最终 Core/DSH 全边界作证。网络保护为进程级仪器化，非 OS sandbox。 |
| **R03 先查现成、再试、后最小实现** | [U01 来源调查](../../research/P01/native-reuse.md)、[复用 ADR](../../adr/P01-reuse.md)，以及 [接受索引](../../../evidence/P01/status.json) 内 U01–U11 的调查、隔离试验、失败、修正与独立审查链。 | 只覆盖 P01；其他阶段需要各自的研究、实验和验收。 |
| **R05 多会话、消息操作与流式恢复** | U07 的 admission ACK/turnId/completion 与成功/失败/partial/cancelled 投影；[U08](../../../evidence/P01-U08/20261002-01/result.md) 的隔离原生历史；U10/U11 六项 full 流程，包括普通发送、读工具成败和取消后新轮恢复。U11 离线前后原生历史 marker 保持可读。 | 完整编辑/重发/并发/重启矩阵未验。原生预置历史不等于 P02 应用持久层；U07 投影不持久化。sidecar 不是 renderer 的证据面板。 |
| **R06 模型配置、能力矩阵和降级** | U09 [模型矩阵](../../../evidence/P01-U09/20261002-01/model-capabilities.json)；U10 的 Pro 不可选且零请求；U11 无 Key 的空配置/禁用发送/零请求、无 DSH 的回复、503 离线失败和 Settings/历史可用。 | 两个 ID 不证明两个后端独立，也不证明两模型均合格。真实官方评测与 Desktop loopback 分开。无 Key 不证明完整的凭据状态 UI；offline 是受控上游 503，不是系统断网。原生重试策略未被改为零，零重试只用于受控故障测试。 |
| **R13 单轮来源分层与 token 预算** | U05 的来源分区、角色版本、canonical 序列化和 UTF-8 字节上限；U06 的 Hook/model delegate 核验；U07 原生事件关联；U09 14 个官方请求的 canonical packet hash 匹配。 | 字节上限不是 tokenizer 实测预算。超限拒绝整包；最终要求的确定性裁剪、保留当前请求和原生 system/project 规则总预算仍属后续工作。 |

## G01 验收

| Gate 条件 | 实际证据 |
| --- | --- |
| 身份资产可验证 | U04–U06 的获批版本、manifest/hash、只读加载和模型前门禁；冻结索引绑定代码、prompt/schema、资源和锁文件。 |
| 主交互可运行 | 同一 candidate-06 的 U11 final-01 full 6/6，普通发送、Read 成功/失败、取消恢复、禁用路线、Pro 拒绝。 |
| 失败不报成功 | 原生 Read 失败回执和诚实 UI 回复；U11 final-02 offline 的真实 Desktop 错误及本地 relay 503。 |
| 禁用扩展不破坏原生 Runtime | disabled_native 的原生回复和辅助标题成功；no_dsh 场景不依赖 DSH。 |

[U11 独立审查](../../../evidence/P01-U11/20261002-01/review-final.json) 和 [G01 接受记录](../../../evidence/P01-U11/20261002-01/acceptance.json) 绑定精确作者提交。U11 final-01 首次降级导出因重复历史快照文件名 EEXIST 失败；只修正测试快照标签后，final-02 degradation 3/3、exit 0。旧失败完整保留；产品和 full 六条流程不变，其复用依据见 U11 coordinator/snapshot-fix.json。

最终接受证据包括 U10 check exit 0、79 unit 通过，U11 full 6/6 与 degradation 3/3。稳定源码测试按明确差异绑定复用，未宣称全部测试在最后一个文档提交上重跑。P01 官方调用总数仍为 18（U02 4、U09 14），本次 gate 没有新增付费模型请求。

## 交接边界

冻结的是本机依赖固定源码/目录的开发 assembly，非安装器或可移植发行包；人工视觉验收 NOT_RUN。P02 应用持久化未开始，后续先执行 P02-U01 的 Runtime transcript/event 和 SQLite 迁移/备份方案调查，再做 P02-U02 故障试验。本轮没有启动下一阶段或进行公开发布。
