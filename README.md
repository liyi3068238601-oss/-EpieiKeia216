# Xiadie V2

P01/G01 已独立验收并冻结为历史 **0.1.0 开发候选**。P02 当前正在补齐原计划的成熟 SQLite 绑定要求，G02 等待重新验收，产品元数据仍为 **0.2.0**。本次成熟绑定试验已经独立验收，后续将替换事件存储和备份绑定，再重新执行集成与冻结验证。当前进度以 [P02 状态](evidence/P02/status.json)为准；[0.2.0 说明](docs/releases/0.2.0/README.md)和[此前 G02 接受记录](evidence/P02-U11/20261003-01/acceptance.json)保留为历史快照。[P01 状态](evidence/P01/status.json)与[0.1.0 冻结说明](docs/releases/0.1.0/README.md)保持不变。

项目根为 `E:/Xiadie/Xiadie`。权威计划是原始 v1.1 ZIP 内的 `planning/Xiadie_V2_v1.1/`，保留原文件并核验 SHA-256；执行状态独立记录。

P01 复用固定版本 ZCode 的原生 Desktop/UI、Runtime/Loop 和 Hook，增加版本化遐蝶人设、分层 ContextPacket、身份门禁及原生 turn/tool 证据投影。已验证普通发送、Read 成功与失败、取消后恢复、禁用扩展的原生路线，以及无 Key、无 DSH、受控离线降级。宿主侧 sidecar 证据尚未成为 renderer 内的证据面板。

P02 将实际 Native 事件和全遮蔽的当前消息材料提交至固定 Node CLI 中的 SQLite 账本，使用真实回执区分已提交、失败、未知与不可用。重开只恢复已提交事实，未知效果阻止自动重放；一致性备份在新根恢复后复核内容。诊断导出脱敏且核对来源/回执，原始临时来源的当前验证保留 NOT_VERIFIED。它不恢复原文或完整对话，也不代表任意外部业务效果已验证。阶段证据见[需求映射](docs/evals/P02/requirement-evidence.md)。

默认模型路线是 DeepSeek 官方 `deepseek-flash`。U09 的真实模型小样本评测只将 Flash 列为本阶段合格候选；`deepseek-v4-pro` 已测但未通过人格基线，不能作为已合格选项。桌面集成验证使用本地模拟服务；它和 U09 的官方模型实测分别记录。用户审核的精简角色为当前 v3，所有历史版本保留；保留游戏背景的选择不构成原创身份或公开发行权证明。

桌面候选使用独立 profile 与系统分配的 loopback 端口，并禁用固定 9229。验证未停止或重配本机安装的 ZCode。冻结产物依赖本机固定源码和依赖目录，当前是开发组装物，安装器、可移植发行包及人工视觉验收尚未完成。

- [需求证据映射](docs/evals/P01/requirement-evidence.md)
- [真实模型能力矩阵](evidence/P01-U09/20261002-01/model-capabilities.json)
- [G01 接受记录](evidence/P01-U11/20261002-01/acceptance.json)
- [下一阶段 P03-U01](planning/Xiadie_V2_v1.1/tasks/P03-U01.md)：本轮已获用户授权完成 P03 并普通推送远端备份；先完成 P02 重新验收，再调查原生 MEMORY 路径、索引、迁移和子代理 scope，比较 ADR/交接模板。P03/G03 完成后停止，不自动进入 P04。
- P00 历史基线：`evidence/P00/status.json`；研究记录：`docs/research/`；单元证据：`evidence/<task-id>/<attempt-id>/`。

计划结构验证命令：`python planning/Xiadie_V2_v1.1/tools/validate_plan.py`。该命令只验证计划结构。

当前桌面验证入口为 `pnpm run test:e2e -- --candidate <绝对候选目录> --suite full --output <新的绝对证据目录>`；降级使用 `--suite degradation`。候选由 `tests/integration/P02/build-candidate.mjs` 在干净已提交仓库中构建，固定工具链和路径见冻结索引。未进行安装器、可移植交付或人工视觉验收。
