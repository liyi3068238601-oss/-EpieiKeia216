# P00-U12｜0.0.0 本地研究候选

作者状态：`ready_for_review`。基线提交 `95ac4933ea30049e689c9d4d7d63c2b66ecd62be`。本单元只在 `docs/releases/0.0.0/` 与本 attempt 下新增候选及证据；没有更新执行状态、已接受产物、固定来源或全局配置，没有新增付费模型调用。

最终 `docs/releases/0.0.0/candidate.zip` 的 SHA-256 为 `1260c77c1f2740783e4c8725da99d021f05d9c4d9ee089d9740c2466fa5a76c9`，ZIP 无损、恰含 `candidate.py`、`README.md`、`manifest.json` 三项。根代理从该最终 ZIP 独立新解包并运行四场景，全部 exit 0 / `passed_with_limits`、付费调用 0；[最终独立执行记录](root-review-final/execution.json) 与 [独立复核](root-review.json) 均绑定此 SHA。候选包只含本项目原创的研究启动器和说明/绑定清单；不含第三方源码、运行时二进制、角色素材、用户配置内容或真实凭据。该 ZIP 是依赖固定本地项目和源码的 P00 研究套件，不是可移植产品、Windows 安装器或 P01 框架。

执行器 [package-run.py](package-run.py) 固定外部载体为 U11 已接受提交，验证三条源码 pin、被选路径和工具版本后生成 ZIP、解压到 `unpacked/`，再运行作者首轮四场景。首轮执行记录绑定修正 README 前的 ZIP `db815cea18fda6478a4e5bbcbaabfda91863d0dfd3477b5e8c132f26e43c7a5f`，仅作历史记录；最终 ZIP 的验收以根代理的独立新解包为准。测试用 `external-project/` 是该已接受提交的 scratch clone；ZCode、DSH、Herta 目录以 Windows junction 作为路径别名接入当前固定副本。根代理在最终复核中再次确认三条源码 pin 执行后仍 clean；junction 不是 ACL 只读保护或安全沙箱。最终场景命令、cwd、退出码、summary 和 nested artifact SHA 见 `root-review-final/execution.json` 与各场景目录。

| 场景 | 候选退出与结果 | 证据和限制 |
| --- | --- | --- |
| `smoke` | exit 0，`passed_with_limits` | 根代理对最终 ZIP 新解包；6 条集成命令均 exit 0、19 条断言通过、付费调用 0。[最终摘要](root-review-final/smoke/summary.json)，SHA-256 `5c1ededb89dd3bb72a9ab3708a9def07a74091c14444f19a59e1b23fb6d36eaf`。 |
| `no-key` | exit 0，`passed_with_limits` | [最终 U07 mock-only loopback 摘要](root-review-final/no-key/summary.json)，SHA-256 `406380c7c438fc15531acf95e434235e09cf2f3f105b746ca285c74b8f55ae87`；本地 mock 可用且未读取全局凭据文件，真实模型路径 `NOT_RUN_NO_KEY`。合成 `personal.json` 含 `p00-fixture-key` 假字段；这不是真实凭据。 |
| `no-dsh` | exit 0，`passed_with_limits` | [最终缺失 DSH entry 与 ZCode mock 摘要](root-review-final/no-dsh/summary.json)，SHA-256 `95343ed7204048510f6046265e862d268bb93d50331c44569faa35e7b90d10cd`：隔离 entry 实测 `exists=false`、`launch_attempted=false`；未预检 DSH 源树，随后 ZCode mock 成功。 |
| `offline` | exit 0，`passed_with_limits` | [最终 mock、故障与状态回读摘要](root-review-final/offline/summary.json)，SHA-256 `9a706c700606fdc4af40a669dff312acc07e31970e2dbc9220f9265e3b4b7c4d`：直连测试 loopback `127.0.0.1:61737`，2.016 秒后 `TimeoutError`。状态回读一致：`upstream_state=unavailable`、`provider_result=null`、`local_result=mock diagnostic only`。这是本机研究诊断，不代表配置的真实 provider；不是 OS 断网或 provider fallback 测试。 |

静态来源与版本绑定见 [manifest.json](../../../docs/releases/0.0.0/manifest.json)：项目基线、U01–U11 acceptance、来源锁、源入口/测试/prompt-hook/protocol 文件、工具运行时路径与二进制 SHA 均固定。实际 U07 packet、prompt 请求、fixture 配置和 hook 输出按场景绑定其原始文件 SHA；合成 `personal.json` 中的假字段与真实密钥严格区分。`assets/manifest.json` 的 SHA 为 `fe4cc9764663e707325a71a16866bd678993fde334f4b2a6744be4daac82342a`，`approvedAssets=[]`。P00 没有 persona schema、Life schema 或 Live2D/角色资源运行产物；计划文档是设计输入，不算实现。

| P00 Must | 本阶段证据 | 仍未证明 |
| --- | --- | --- |
| R02 主宿主与 Core/DSH 边界 | U07 mock 与 smoke 中的 U09 固定 SDK 回归 | 桌面体验、正式人格一致性和产品 Runtime。 |
| R03 先查现成、再试、后最小实现 | U01/U02 复用调查及 U11/U12 对固定候选的执行 | 尚未构成 P01 产品实现。U11 卡片漏列 R03；immutable 需求映射为 U01/U02/U12。 |
| R08 子代理 scope 与最小 handoff | U08 executor/Memory 断言，U09 A/B Job 与 detached 对照，U11/U12 重跑 | 完整 AgentRuntime、自动检索或任意恶意进程沙箱。 |
| R17 执行端权限、密钥与插件信任 | U07 Plan Write 负例、no-key/no-DSH、U08 deny 与 U09 Job 证据 | 全局配置审计、OS 文件/网络沙箱、未来设置 UI 或 provider 授权。 |
| R24 备份恢复与旧工程保护 | U03/U04 已接受的保护/迁移记录，U11/U12 bounded completed/unknown 观察 | 最终备份恢复、崩溃一致性及任意数据迁移恢复。 |
| R25 代码与角色资源许可清单 | U06/U10 已接受许可清单；ZIP 仅原创候选文件，批准角色资产数为 0 | 正式 payload SBOM/notices、产品分类和角色权利。 |
| R27 版本与独立执行单元完整 | U01–U11 已接受，U12 候选源、包、四场景实际哈希与退出码齐全 | U12 仍待独立接受；Windows 产品包未运行。 |

P00 共 12 个执行单元状态：U01–U11 为已接受（其 acceptance 文件 SHA 在 manifest 中逐项固定）；U12 为 `ready_for_review`，没有伪造 acceptance。根代理独立复核 [root-review.json](root-review.json) SHA-256 `c5a38e4c9578958a97294ff4e9cf50b788b8abebd3d51d89a37deaa8a27ed60c`，结论 `passed_with_limits`、无 blocker，并建议完成最终 metadata 后接受；本文件与 verification 已绑定最终 ZIP 和复核材料。P01 当前不开放，28 项最终产品 Must 不据此标为完成。正式安装器/Windows package、产品 UI、真实模型、完整 provider 离线策略均为 `NOT_RUN`。

回滚仅撤销本单元新增的 release 与 evidence；scratch clone 和本次运行原始材料留在 attempt 供审查。未触碰用户工程、production 配置、凭据或固定 source tree。独立复核入口为 `python evidence/P00-U12/20261001-01/package-run.py`（cwd `E:\Xiadie\Xiadie`）；它会拒绝覆盖已有 ZIP、解包目录或 case 结果。独立 reviewer 可直接从 ZIP 新鲜解包并传入固定 project root 重跑。
