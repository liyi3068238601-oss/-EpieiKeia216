# P00-U05 结果：范围和旧决策替代表

状态：ready_for_review
Attempt：20261001-01
基线 HEAD：df0215e9ee0d14206a128448bfd3117653b200ae

已完成 U05 允许的两份作者稿：[requirements.md](../../../docs/requirements.md) 与 [scope.md](../../../docs/adr/scope.md)。需求文档保留了 requirements.json 的全部 28 条原始记录和每项 id、stages、tasks 数组；每项仍标为 Must / not_started，并另列面向最终 1.0.0 的可核验验收标准。ADR 说明 1.0.0 是执行映射推导，区分产品版本与文档版本。

范围决策将旧 Python/FastAPI 与 Mastra 主框架方案替换为 v1.1 定义的 ZCode 主运行时、Core 角色/记忆/上下文与政策边界、ZCode 工作层实际执行权限、DSH 有界委派。保留旧设计可复用的数据边界、来源追溯和恢复原则，不把旧技术选型列为强制依赖。固定 Live2D 桌面入口与语音继续属于最终 Must，按 P10/P12 后置实现和实测；早期替身不能证明最终能力或许可。手机端、多人云租户等计划书明确排除项未扩进 1.0.0。

两份旧 Library 文档正文当前不可用，本文只依据当前 v1.1 计划材料处理其引用的旧技术方向，并明确标成 Unverified；没有声称已复读原文。未对原工程、源码、模型或外部服务执行操作。

## 依据与逐项定位

- 计划书说明文档 1.1 不等于产品 1.1、当前需求均未开始：01_项目计划书.md 第 4、6 行；最终范围与旧技术选型处理：第 12、14 行。
- Core 不路由 DSH、ZCode 是唯一主运行时：01_项目计划书.md 第 20–21、76、78 行。桌面 Live2D 和语音仍在范围并后置：第 234、236、526–549、582–604 行。P15/P16 版本映射：第 239–240 行；正式交付须所有 Must 验收并获授权：第 708 行。
- 需求映射矩阵说明阶段/任务映射不代表验收通过、RC 逐项反查：04_需求追踪矩阵.md 第 3、7、9 行；R02 全阶段及任务数组示例：第 23、25–27 行。requirements.json 原始记录覆盖第 1–1180 行。
- U05 允许改动路径、逐项 Must 标准和 ready_for_review 交接：tasks/P00-U05.md 第 11、25、33 行。
- 旧需求说明书和 Mastra foundation design 的引用、限制与复用原则：03_代码参考与复用清单.md 第 761–785 行；正文不可用的明确状态：docs/research/P00/source-decision.md 第 16 行。

## 文档核验

在 E:\Xiadie\Xiadie 以 PowerShell 读取 requirements.json 并验证作者稿：28 行表格 ID 均匹配原始标题；附录 28 条 JSON 记录与原始记录规范化后完全相等，含完整 stage/task 数组；28 项均为 priority=must、status=not_started；R02/R13/R22 关键标准和 Core/工作层职责存在；UTF-8 无 BOM、仅 LF、无行末空白。命令退出码 0。

本轮未运行产品代码或自动化产品测试，未调用模型、安装软件或验证发行包、Windows 应用、Live2D/语音及资源许可；均为 NOT_RUN。此作者稿不代表任何 Must 已实现或被接受。P15/P16 的真实产品、发行包、资源许可及发布授权门槛仍须按计划完成。

## 绑定

本结果绑定的两份文档工作树字节 SHA-256：

- docs/requirements.md：f3d94b4225e343f0af0708c081e241d2bc5f8995f28952f1e1f99a001d79a9cd
- docs/adr/scope.md：5c482e8ded4ec436bd0106238a4e845b83e8f48b4302652a5aeb95077c99ef52

逐输入、输出哈希与文档核验摘要见同目录 verification.json。整体 U05 等待独立审查；本作者不自行标记 accepted。
