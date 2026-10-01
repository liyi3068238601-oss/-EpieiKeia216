# P00-U01 候选路线与调查边界

日期：2026-10-01。此处是调查决定，运行兼容性仍由 U02、U07–U09 验证。

| 领域 | 比较的合理路线 | 调查候选决定 | 必须实测的差额 |
|---|---|---|---|
| 主会话上下文 | 官方 CLI Hooks；桌面服务薄呈现适配；独立 Self Runtime | 优先固定 ZCode CLI 的 SessionStart/UserPromptSubmit，保留薄呈现适配作为后备 | 上下文位置、恢复/compact、工具失败时能否采证。Hook additionalContext 有 24,000 字符截断，不能承担无限历史或权限授权 |
| 记忆 | 主会话 Memory 服务；子代理 persistent-memory；完全自研储存 | 复用各自现有入口，Life 与 Project 的产品资料隔离由薄适配提供 | 子代理 memory 自动增加 Write/Edit；user/project/local 的真实路径矩阵；执行端拒绝只读越权 |
| 工作执行 | 独立 DSH SDK 进程；嵌入整套 DSH 插件树；自研 Loop | 优先现有 stdio SDK，每个执行实例使用独立数据根和专属进程 | messageId 仅入队回执；idle 不是业务成功；协议无 cancel/session-close/审批回传，停止与恢复由宿主进程边界验证 |
| Dream/知识整理 | Herta 纯函数/测试借鉴；整体 fork；从零实现 | 借鉴切段、选择、退火、原子写和测试思想；不整体带入角色/runtime | 类型、存储、Xiadie 的 source_refs/base_version/privacy_epoch/job_id 校验必须适配；Herta 90 天策略不能直接用于 Project |

固定来源分别为 ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`、DSH `639ed015397290b3745d163aafe02ffee4aa3f84`、Herta `4623df120adf99340ce5f7e25ed829466975e3ae`。全部分项报告及 SHA-256 清单到场后，才将 U01 整体提交独立审查。没有升级到 latest；安装目录不冒充固定源码构建。

官方 README、代码及关联测试只是调查证据，尚未运行的测试或 runtime 一律不记通过。U01 只改调查文档、调查脚本和任务证据；没有产品代码、全局安装或生产配置修改。模型只做了 GET /models 元数据查询，生成请求仍为零。

U01/U02 所引的两份 Library 旧文档在当前环境未取回，状态为 Unverified / Source unavailable。保留压缩包 v1.1 中明确的需求；不会声称已复读原始文档，U05 要登记这一限制。原包、规划和上游参考树保持原样。

回滚：若调查产物已提交，revert 对应本地提交；提交前仅撤本次新增文件，保留失败证据；不触及生产数据。迁移记录单独保留，不能用迁移前路径启动后续试验。
