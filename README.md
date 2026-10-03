# Xiadie V2

P01 的 U01–U11 已独立验收，G01 通过，冻结本机 **0.1.0 开发候选**。P02 已获授权并进入执行：U01 来源调查已接受，当前节点为 **P02-U02 隔离试验**。当前进度见 [P02 状态](evidence/P02/status.json)；[P01 状态](evidence/P01/status.json)与[0.1.0 冻结说明](docs/releases/0.1.0/README.md)保留为历史冻结记录。

项目根为 `E:/Xiadie/Xiadie`。权威计划是原始 v1.1 ZIP 内的 `planning/Xiadie_V2_v1.1/`，保留原文件并核验 SHA-256；执行状态独立记录。

P01 复用固定版本 ZCode 的原生 Desktop/UI、Runtime/Loop 和 Hook，增加版本化遐蝶人设、分层 ContextPacket、身份门禁及原生 turn/tool 证据投影。已验证普通发送、Read 成功与失败、取消后恢复、禁用扩展的原生路线，以及无 Key、无 DSH、受控离线降级。宿主侧 sidecar 证据尚未成为 renderer 内的证据面板。

默认模型路线是 DeepSeek 官方 `deepseek-flash`。U09 的真实模型小样本评测只将 Flash 列为本阶段合格候选；`deepseek-v4-pro` 已测但未通过人格基线，不能作为已合格选项。桌面集成验证使用本地模拟服务；它和 U09 的官方模型实测分别记录。用户审核的精简角色为当前 v3，所有历史版本保留；保留游戏背景的选择不构成原创身份或公开发行权证明。

桌面候选使用独立 profile 与系统分配的 loopback 端口，并禁用固定 9229。验证未停止或重配本机安装的 ZCode。冻结产物依赖本机固定源码和依赖目录，当前是开发组装物，安装器、可移植发行包及人工视觉验收尚未完成。

- [需求证据映射](docs/evals/P01/requirement-evidence.md)
- [真实模型能力矩阵](evidence/P01-U09/20261002-01/model-capabilities.json)
- [G01 接受记录](evidence/P01-U11/20261002-01/acceptance.json)
- [下一任务 P02-U01](planning/Xiadie_V2_v1.1/tasks/P02-U01.md)：调查 Runtime transcript/event 出口与 SQLite 迁移、备份组件，比较现成方案后再做隔离试验。
- P00 历史基线：`evidence/P00/status.json`；研究记录：`docs/research/`；单元证据：`evidence/<task-id>/<attempt-id>/`。

计划结构验证命令：`python planning/Xiadie_V2_v1.1/tools/validate_plan.py`。该命令只验证计划结构。
