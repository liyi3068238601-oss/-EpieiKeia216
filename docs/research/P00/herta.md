# P00-U01｜Herta Dream / Life 机制调查

状态：ready_for_review（作者提交，未标 accepted）。本记录只覆盖 Herta 固定提交的相关实现、测试、许可证和工具链，以及与当前 Xiadie v1.1 契约的对照；不改变计划、任务状态或上游参考树。

## 结论

Herta 可提供可验证的有限叙述记忆流水线：按会话划 Episode、确定性预筛、稳定去重、受控候选生成/评审、有限 live shelf、强化与归档、语义页折叠及失败重试。它不是 Xiadie 的 Life store，也不是 Project Memory。最合适的后续候选是借其边界与失败处理设计，在 Xiadie 自己的类型、事件来源、存储权威和提示词之上加薄适配；只有 U02 隔离测试通过后，才决定是否移植少量纯函数。这里没有批准产品实现，也没有完成 PoC。

Xiadie 计划明确区分 Life 与 Project：Life 可强化和归档；Project 按可验证工程事实维护且不随时间衰减，Markdown 只是受控 Life store 的导出视图（01_项目计划书.md:24-25, 86-96, 123-131）。因此 Herta 的 retention/cap 只能作为 Life 的候选，不得作用到 Project Memory。计划还把 Herta 标为有限叙述记忆与 Dream 机制的来源，明确不整体搬入其 coding runtime 或角色语料（01_项目计划书.md:51-53；03_代码参考与复用清单.md:311-323, 357-387）。

## 固定基线与阅读范围

Xiadie 根基线为 4680700bbaf7f3cd6abf4ed38809ab878d859568。只读副本为 E:/Xiadie/Xiadie/references/herta-4623df12，HEAD 精确等于 4623df120adf99340ce5f7e25ed829466975e3ae，tree 为 2077f7e79459ff24996ffab2fb67a8dcb52adc88；核验时参考工作树干净。Herta 上游 URL 是 https://github.com/PersonaCLI/Herta，源码永久链接均固定该 commit；逐文件 SHA-256、行数和具体阅读级别见配套 herta-sources.json。

完整读取了 Dream 默认配置、episode 分段/选择、强度计算、manifest、来源原话门、回声检测和语义化实现；也沿主流程阅读了 run-dream-pass、digest、再巩固、触发器、CLI 入口、核心类型、prompt asset 选择器和模型接口。辅助门控、互斥、promotion、格式校验与 reconcile/readiness 等模块按调用边界阅读。Dream 提示构建模块只索引函数/调用关系，未复制或转录 prompt 文本。

关联测试完整阅读：config、segment-session、select-episodes、retention、manifest、semanticize、user-line-gate、echo、dream-trigger、reconsolidation-junction。segment-session-growth-fuzz、run-dream-pass、distill-prompt 测试读取测试主题/场景索引及相关断言片段；digest、reconcile、readiness、prompt-exclusions、novelty、promote、lock、feian-format 测试读取相关测试映射/主题。测试文件均只读，**本次没有运行任何测试**。没有安装依赖或运行 README 安装步骤；没有执行模型调用，也没有联网调查上游。

新的 Xiadie 根中本轮可见的是计划、任务、证据和研究文档；没有找到 Life/Dream 产品运行时代码。本判断仅针对当前项目根，不推断机器其它位置。

## 机制与 Xiadie 的主要差异

| 机制 | Herta 固定提交实际做法 | 对 Xiadie 的影响 |
|---|---|---|
| 分段与稳定身份 | segment-session.ts:47-69, 105-245。依据时间间隔、marker、时长上限和无时间戳 fallback 切段；尾段需超过静默窗才 settled。episodeHash 是对按顺序投影出的 [kind, tag, text] 做 SHA-256，刻意不含时间戳和 system role。V2 cutover 保留旧分段规则以维持旧 ledger hash。 | 可借边界优先级、settled tail 与版本化 cutover 的测试方法。不要直接把 Herta episodeHash 当 Xiadie source_ref、event ID 或证据完整性标识；不同 schema/字段次序/Unicode 序列化会改变哈希，且该投影舍弃部分来源元数据。先由 Xiadie 定义 canonical event/source identity。 |
| Episode 预筛 | select-episodes.ts:8-33 要求 settled、至少两个 Herta 发言/思考块且至少含一个发言；长度门槛统计非 system 内容，允许非 coding 经历。 | 可借确定性降成本和“非 coding 事件不被遗漏”的反例测试；角色块数、200 字符门槛必须改成 Xiadie 的消息类型与用例证据。 |
| 强度与容量 | retention.ts:26-47 采用 voice × (1 + chargeWeight × emotionalCharge) × 指数半衰期 × 对数 reactivation 增益；manifest.ts:249-325 结合强度、标签干扰与 seed 优先级选择淘汰。 | Herta voice 分数只是文风质量信号，不能变成 Xiadie 事实可信度或权限判断。重复引用最多是显著性/使用信号；Xiadie 计划明确自我复述不证明事实（01_项目计划书.md:131, 149；prompts/05_reconsolidation.md:2）。 |
| 原话来源门 | user-line-gate.ts:30-100 从特定 Herta 角色格式抽取引用，并对用户消息做归一化的连续子串匹配；短片段忽略。 | 只能借“模型生成后再回源校验”设计。Xiadie 候选携带 source_refs、attribution、sensitive、requires_user_confirmation 等；要逐条验证引用关联原文，不能依赖 Herta 特有说话人 fence，也不能把子串相等当语义正确（prompts/01_worthiness.md:2-8）。 |
| 自回声 | echo.ts:16-123 检查 Herta 自己的发言/思考是否重用 live record 文本，并防止同 episode/session 自触发。 | Xiadie 明确重复模型说法不提高事实真实性；最多保留为关闭或诊断信号，不作为新证据，也不能抬高来源置信度（03_代码参考与复用清单.md:533-547）。 |
| 再巩固 | reconsolidation-junction.ts:35-438 用精确 live ID 找旧记录，先保守判断是否新理解，再验证合并保留旧实质并包含新 facet，双顺序比较后才替换；失败回退到单纯强化/归档。 | 借鉴“精确 ID + fail closed + 保留旧内容”的结构；Xiadie 使用自身动作枚举 no_change/reinforce_salience_only/supersede_interpretation/correct_fact/needs_user_review。CoreAnchor 变更需要用户审查，不能搬用 Herta 的档案替换策略（prompts/05_reconsolidation.md:1-8）。 |
| 语义页 | semanticize.ts:96-215 区分缺页/不可读、验证文本并先备份；282-359 整页重写并可做一次修复；371-443 审核明确矛盾后改写。页面名、标题、语言、语法和 prompt 均绑定 Trailblazer。 | 只借“不可读不得视为空页、先备份、失败保留旧页、一次修复限制”的故障语义。Xiadie 提案先给代码审查，须校验 base_version/privacy_epoch/job_id 和来源；不得直接写入 Markdown 或把整页模型重写作为权威提交（01_项目计划书.md:87-96, 147-153；prompts/06_semantic-note.md:2-8, prompts/07_notes-audit.md:2-8）。 |
| 持久化与恢复 | manifest.ts:14-42, 61-83, 86-173 保存每条 episode outcome、created records、完成水位、pendingFold、分段版本；strict read 区分缺失、损坏、不可读，损坏备份并停止；原子替换。 | 借鉴逐 episode ledger、失败条目可重试、严格损坏处理、atomic commit、pending work 的恢复设计。目标是 Xiadie 单一受控 Life store；Herta JSON manifest/静态前缀文件不能成为第二个事实源。单一全局水位不足以处理部分成功或并发失效，需目标 ledger 为每条来源保存状态。 |
| 自动触发 | dream-trigger.ts:1-81 按 enabled、运行中、空闲、用户忙碌、退避、冷却、材料量的顺序短路；session-host.ts:99-136 才在 enabled 时挂 5 分钟轮询。 | 当前 Xiadie 阶段先做手动 P05，再做机会式 P06 与退出恢复；不能因为 Herta 有后台触发就提前启用自动调用（01_项目计划书.md:382-388, 412-429）。Herta 配置实际 enabled:false；附近注释保留历史“left on by default”叙述，当前值以代码为准。 |
| 调用入口 | CLI herta-knowledge.ts:139-159 提供 herta knowledge dream，支持 dry-run 与预算估算上限；1263-1421 先筛材料/估价，dry-run 在解析客户端前退出，live 路径才解析 DeepSeek 并运行 pass。README.md:139-160 说明真实会话文本会发送给 DeepSeek。 | 可借 dry-run 和调用前预算门；模型配置、prompt、usage 及隐私政策要走 Xiadie 的 adapter。Herta 默认 deepseek-v4-pro / generation max / gates high 不会覆盖当前 Xiadie 授权配置；本次没有发出模型请求。 |

## 默认配置对照

配置完整定义在 config.ts:3-67，下面全部是 Herta 的实现取值，不是 Xiadie 冻结数值、用户承诺或已验证最优值。Xiadie 03 清单明确把它列作对照组，并特别标注 90 天、27 条、600 字符并非 Xiadie 已证最优（03_代码参考与复用清单.md:311-323）。

- 自动运行门：enabled=false；用户离开 30 分钟；完整 pass 冷却 7 天；重试退避 1 小时；至少 5 个新 session，或单 session 至少 25 个 Herta turns。
- 分段/筛选：20 分钟 gap；每 episode 最多 60 blocks、45 分钟；至少 2 个 Herta blocks；至少 200 chars。
- 晋级门：voice 至少 0.8；若 critique 提供有效分数，faithfulness 至少 0.7。
- live 容量：seed 与 dream 总计最多 27；保护 seed 上限 2；优先淘汰的合成 seed band 上限 6。
- 遗忘/强化：半衰期 90 天；reactivation 系数 0.5；强度下限 0.12；最小强化间隔 24 小时；echo 连续匹配阈值 12 字符；情绪权重 0.5；3 次间隔强化后可折叠到语义页。
- 输出与预算：最多 refine 重试 2 次；Trailblazer 页上限 600 chars；每轮语义页 audit 最多看 8 条 live 记录；auto pass 最多处理 24 episodes。模型默认 deepseek-v4-pro，生成 effort=max，判断 effort=high。

90 天不是自动在第 90 天删除；Herta 是强度排序/容量竞争、归档和折叠组合。Xiadie 计划解释它仅是对照，不将半衰期用于 Project，并要求 Project 多年未开工需核对新鲜度而不是遗忘（01_项目计划书.md:129-131）。特别不能把 600 chars（字符数）当 token budget，也不能把 24 episodes/pass 当 API 费用上限或 Xiadie job budget。Xiadie 计划中的 WorkPackage budget 是 max_descendants/max_depth 等执行授权字段，不同于 Herta LLM pass cap（schemas/work-package.schema.json:3-16, 49-82）。

## 纯函数移植与借设计重写

直接移植纯函数（port_pure_code）与在目标契约下重写/薄适配（borrow_design/thin_adapter）各有边界：

- 可候选直接移植或逐式重写后 parity-test：retention.ts:26-47 的强度公式（注入当前时刻、有限值与边界）、select-episodes 的确定性筛选框架、segment-session 的边界规则。MIT 对源码代码允许复用，但后续若实际复制必须保留版权/许可及本地修改记录。
- 不可原样接入：segment-session.ts:1-3 依赖 TerminalRecordBlock，episodeHash 使用 JS JSON.stringify 的字段投影；manifest.ts 依赖 Herta 类型和 @herta/core 原子写；主 pass 依赖 Herta prompt asset bundle、DeepSeekClient、workspace transcript 组织与 FEIAN 格式。user-line-gate 与 echo 依赖角色格式和角色输出，semanticize 绑定 Herta 笔记页；直接 import 会把存储与角色协议带进 Xiadie。
- 当前推荐候选是借边界设计、在 Xiadie 类型上重写最小实现，必要时只移植经过单测对照的纯函数。最终采用类型应留给 P00-U02 隔离试验与独立审查决定，不在本报告中宣布接受。

后续最小适配至少要有四组本地契约：

1. **事件与证据类型**：有序原始 event/source 引用、session/run/turn/sequence、发言方/来源类别、时间、settled/完成状态、可见性/敏感级别与 privacy_epoch。用户原话、系统核实、助手解释分开保存；摘要只能指向原始来源。可空、失败/取消、删除传播都要表达。
2. **Episode 草稿类型**：边界原因、起止 event refs、原始 source_refs、去重键和稳定版本。哈希需由 Xiadie 规定 canonicalization、编码、版本与 privacy epoch；不要采用 Herta 的有损 hash 当引文。
3. **提案/事务类型**：模型仅输出 Xiadie 的结构化 proposal；携带 base_memory_id/base_version/privacy_epoch/job_id、候选动作、claim/source refs、归属、敏感标记及待用户确认标记。写前重验版本和 epoch，过期或删除后产物一律拒绝；模型不能直接持有数据库写权。
4. **存储与 ledger**：由单一 Life store/受控提交服务维护事件账本、每项状态和重试、归档、版本、水位、pending semantic fold/audit、幂等事务与锁/fencing；Markdown 只从 store 导出。Project Memory 必须另有不衰减的权威更新路径。可参考 Herta manifest 的原子替换与损坏 fail-closed，但 schema、ID namespace、状态枚举不能共用。

### 不能混用的字段/编号

- Herta 的 episodeHash/sourceEpisodeHash/sourceEpisodes/sessionId/runId/generatedAt/lastRunAt/segmentationV2Since/voice/faithfulness/gistFolded 属于 Herta Episode ledger 与 DreamCreatedRecord；不等同于 Xiadie source_refs、source_hash、base_memory_id、base_version、privacy_epoch、job_id、RuntimeEvent 的 run/attempt/sequence 或 Life memory ID。
- Herta 结果 state=live/archived 与 outcome=promoted/archived/skipped/reinforced/reconsolidated，不等同于 Xiadie 的 proposal action 或 user-review 状态。Herta critique voice 不能映射为事实可信度。
- Xiadie WorkPackage 的 task_id/attempt_id/project_id/lease_generation 只标识受限工作任务。不得把 task_id 当记忆 job_id、attempt_id 当 Herta runId，也不能把 WorkPackage schema 当 DreamProposal schema（work-package.schema.json:3-16, 19-82；01_项目计划书.md:96-98）。
- 版本号有三层：Xiadie 产品路线 0.0.0→1.0.0、文档 1.1、Herta 源码固定 commit/tag；文档 1.1 不是产品 1.1，也不是 Herta 格式或 manifest version。

## 测试与许可/依赖限制

最相关的上游测试路径及其读法记录见 herta-sources.json。完整读过的核心测试分别覆盖配置默认值、分段边界/重启哈希、settled 选择、强度曲线、manifest 迁移与损坏读、语义页保旧与一轮修复、原话归一化/短片段、回声自触发保护、busy/idle/cooldown/backoff 和 reconsolidation 精确 ID。增长 fuzz 测试强调确定性、append-prefix 稳定及分区边界；其中也固定了逆序时间戳可能造成 under-segmentation，且 hash 不含 marker role 的已知约束。集成测试覆盖失败重试、ledger flush、预算/yield、锁、折叠与 corruption，但本轮只读了相关情景索引/片段。以上均是测试代码可供未来借鉴，不是这些测试当前已通过的证据。

LICENSE:1-34 明确 MIT 只授予项目源码，不授予第三方 IP；排除 packages/herta/prompts/**、packages/herta/prompts-en/**、GUI artwork、website assets 和 voice。若未来复制代码，需保留 LICENSE 的 copyright/permission notice 并登记变更；任何 persona prompt、游戏对白、图像和声音均不在代码许可授予范围。源码读取过程中没有把角色语料写入本项目产物。

README 与包元数据显示这是 pnpm 9.15、Node 20.19+ 或 22.12+ 工作区，mise 固定 Node 22；knowledge 包依赖工作区 @herta/core/@herta/herta、better-sqlite3、linkedom、zod。node_modules 不存在。本轮没有安装依赖；README 的 install/build/test 命令均未运行。安装文件名检索只命中 GUI setup-tests.ts、install-mode.ts 与其测试，不是 Dream 安装流程；未执行任何安装脚本。

## 范围与限制

本报告固定于一个 Herta 提交的静态代码阅读；没有从网络刷新代码、没有运行 Herta/Xiadie 测试、没有在目标类型上实现 adapter、没有调用任何模型。新模型选择与费用授权不会改变 Herta 参考实现的默认值，也不构成本轮真实请求。本轮只交研究报告与来源证据，供独立审查后决定是否进入 U02。