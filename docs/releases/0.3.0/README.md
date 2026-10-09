# Xiadie 0.3.0 冻结候选

此文保留 P03-U10 attempt `20261008-01` 的作者冻结快照：`ready_for_review`、`accepted=false`，冻结时 G03 等待独立审查。当前验收结论见 [P03 状态](../../../evidence/P03/status.json) 和后续 canonical acceptance。

Native source 固定为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。full 与 degradation 均以实际 summary 记录 3 个通过场景；执行输入、runner 输入及候选材料闭包保持不变，模型流量限于 mock loopback。proof archive index 绑定实际 summary、runner 和 candidate descriptor 的原始字节。两次离线失败分别揭示同进程 Host 重建和新任务启动另一 CLI 时的审计日志冲突；父进程固定日志物理身份后重新生成候选并实跑全套。原失败、路径映射变化与新增保护测试均保留，未放宽历史消息、离线请求或 ledger 断言。

以下仅映射 P03 范围；各需求在其他阶段的工作仍须单独验收。

| 条目 | 实现与实际证据 | 支持边界 |
| --- | --- | --- |
| G03-M1 不自然衰减 | accepted U08 三年旧笔记仍按当前 Git/raw hash 重验；U09 freshness 回归。 | byte-current 是字节引用有效性，不是语义真相。 |
| G03-M2 迁移可追 | accepted U03/U06 实际 Git/SQLite、Native 路径映射、导出/导入、迁移/回滚与旧源 hash；U09 回归。 | 迁移后 App 端到端 NOT_RUN。 |
| G03-M3 无双写权威 | registry 只存身份元数据；Native 原始笔记是内容源；实际 Read/拒读/取消恢复核对 fixture 字节和文件集。 | 未启用 Native writer；观测期间文件集不变不能证明所有瞬时或外部行为。 |
| R03 先查、再试、最小实现 | accepted U01 来源比较/U02 隔离试验；U03–U08 实现；U09 独立回归；本次候选实跑与冻结。 | 许可、素材和真实模型语义不由源码 hash 证明。 |
| R07 记忆与事实分工 | U03/U04/U05/U08 政策、Reader 与 freshness；U09 Native/Host 实际拒读。 | 经验仅作线索；业务 owner/progress 无证据时 unknown。 |
| R08 scope 与最小 handoff | accepted U07 最小包/字节上限/项目隔离、U08 核验回执；U09 实际 Native 回归。 | mock 接收者不等于真实 DSH 交付或语义遵循。 |
| R24 恢复与旧工程保护 | accepted U03/U06 不覆盖、rollback 与旧源保持；候选全套运行核对生产配置 hash/registry guard。 | 只读保护及 API 测试不等于 portable 安装器或物理故障恢复。 |

- 运行环境边界：实际 Desktop 使用 Electron 41.0.3；候选 CLI 运行于 Electron Node mode。构建及工具使用固定 Node 24.14.0、TypeScript 6.0.2。
- 存储与分发边界：Native 使用 node:sqlite；Xiadie 自有 CLI 使用独立的 better-sqlite3 13.0.3 MIT addon。候选借用 junction，不能视为可移植安装包。
- 隔离与未运行项：本轮只验证 mock loopback 模型流量；付费模型、DSH、已安装应用、人类视觉验收和 whole-OS sandbox 均为 NOT_RUN。
- M2 边界：已接受的 U03/U06 证据包含迁移 API 的实际验证，并由 U09 回归补充；迁移后 App 端到端验证为 NOT_RUN。
- 事实与业务状态边界：project/experience notes 只作线索，不等同事实。没有独立业务 TaskLedger 实体证据证明 owner 或 progress；本轮项目记忆组合未启用 Native writer，也未建立第二个事实数据库。
- 字节与语义边界：当前输入字节及 raw SHA-256 只能证明文件字节和运行前后状态一致，不能证明内容语义真实、获得许可，也不能证明真实模型遵循 facts priority、persona 或 memory policy。
- 来源限制：原始角色素材及原始 prompt 的来源、provenance 和许可均为 NOT_VERIFIED。
- 计划与许可边界：423 份 v1.1 计划文件只读核对。hash 标识精确字节，不代表许可或授权。
- 日志与权限边界：父进程以独占创建和固定物理身份授权同一隔离场景的 CLI 追加，并在启动前后核对回执与日志身份；仅凭既有文件存在仍拒绝。固定 Node 日志测试为 11 pass/1 symlink EPERM skip；既有 U03/U07 symlink 权限未测也保留。这是测试日志组合，不是任意既有 profile 的恢复声明。

`freeze.json` 记录输入分组及 raw hash、工具身份、许可副本、命令 hash 和已接受证据引用。只有 canonical P03 status 与之后独立写入的 acceptance record 才能将 U10 标为 accepted。
