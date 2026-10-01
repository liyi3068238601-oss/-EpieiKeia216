# P00 阶段集成评估

依据固定计划 v1.1；U11 作者执行基线为 `1ea91865318b020629535ba572c88440731797f4`。作者 fresh replay 的六条命令均 exit 0，根审查另行复跑并核验输入、源码、输出绑定。总状态仍待独立接受；U12 与 G00 未完成，不开放 P01。

| Must | P00 证据 | 阶段边界与未完成项 |
| --- | --- | --- |
| R02 主宿主与 Core/DSH 边界 | U07 原生 ZCode mock loop；U09 固定 DSH SDK loopback under Job | 证明 headless seams 与有界交接测试，不证明桌面、正式人格体验或发行运行时。 |
| R03 先查现成、再试、后最小实现 | U01/U02 已接受调查和复用证据；U11 重跑锁定入口；最终候选冒烟留 U12 | requirements.json 将 R03 列为 P00 Must，任务映射为 U01/U02/U12，但 U11 卡片漏列。保留该差异；U12 仍是 G00 前置。 |
| R08 子代理 scope 与最小 handoff | U08 18 项 executor/Memory assertions、两个 Git worktree 与显式拒绝；U09 A/B 独立 Job、detached leaf 对照 | 仅为固定源码 helper、合成 SDK 和受信任 fixture，不等于产品 AgentRuntime 或完整跨进程权限方案。 |
| R17 执行端权限、密钥与插件信任 | U07 mock 的 Read failure、Plan Write denial、该副本不读取全局凭据路径；U08 显式 Write/Edit deny；DSH tools=[]、替换 child env、假凭据 | U07 合成 `personal.json` 含 `p00-fixture-key` 字段；`globals_snapshot()` 返回空列表，所以这里不是全局配置枚举或前后哈希审计。测试证明本地负例和隔离参数，不构成 OS、文件系统、网络或恶意插件沙箱。 |
| R24 备份恢复与旧工程保护 | U03/U04 已接受的旧工程保护及迁移/来源记录；U09 completed checkpoint 读回且 unknown 保持 unknown | completed 只在同一 spike close 后读回；无 crash-consistency 或最终备份恢复证明。 |
| R25 代码与角色资源许可清单 | U06/U10 已接受许可边界、approvedAssets=0；U11 仅执行作者 harness 和锁定参考 | 未复制角色素材或上游代码到产品；实际发行 payload、逐依赖 notices 与角色权利仍未完成。 |
| R27 版本与独立执行单元完整 | U01–U10 acceptance 全部精确绑定；三来源 pin/clean；U11 作者和根复跑分别绑定 | U11 等待独立接受，U12 尚未运行。P00/G00 未通过，28 项最终产品 Must 均不据此标记完成。 |

作者集成命令为 `python tests/integration/P00/run.py --root E:\Xiadie\Xiadie --output-dir E:\Xiadie\Xiadie\evidence\P00-U11\20261001-01\replay-02`，cwd `E:\Xiadie\Xiadie`。其 U07 副本只允许 mock，真实网关/凭据分支已删，Hook host 数据写入本次 evidence 的独立 runtime-data。U09 的“关闭”是整个 SDK runtime/所属 Job 的关闭，不是 per-prompt cancel；同 ID 重开仍被拒绝，新 ID 不继承旧历史。Herta 用固定纯函数和新输入重算，不是 DB 恢复。

首次 runner 预检因任务卡末尾标点解析失败、在任何 probe 前 exit 1；修正和回执保留在 `evidence/P00-U11/20261001-01/replay-01/`。最终作者运行与根复跑全部零付费调用，测试流量仅 loopback，外层安装器/Windows package 测试为 `NOT_RUN`。U07 新会话/恢复首轮重复注入的已接受低风险 follow-up 仍待后续产品预算/去重规则处理。`root-review.json` 和 `verification.json` 绑定精确报告 SHA。
