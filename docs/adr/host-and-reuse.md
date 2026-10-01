# 主宿主与复用路线 ADR

状态：ready_for_review。阶段 P00 / 产品基线 0.0.0；依据压缩包 v1.1，不更改原始计划。前置 U01–U09 已接受，本决定等待 U11 独立集成及 U12/G00 后才开放 P01。本文替代 U02 的暂定路线判断，不回写历史证据。

## 唯一默认路线

ZCode 是唯一主 Runtime，保留其原生 agent loop、配置、工具执行和插件入口。Xiadie Core 提供原创角色、受控记忆、每轮上下文及确定性政策；Core 不路由 DSH，也不建立第二个 Self Runtime。ZCode 工作层通过薄桥接，在确有需要时委派有界 WorkPackage 给独立 DSH SDK 实例。Herta 仅用于有限 Life / Dream 机制与已验证纯函数的参考，不引入其角色、全套 coding runtime 或网页素材。

桌面呈现与具体服务边界留到 P01 的入口调查及后续界面阶段。P00 已验证 headless 插件和 bootstrap，不把它称为桌面 UI、安装器或完整产品。不得把三个仓库直接拼接成一个运行时。

## 采用方式和实际证据

固定版本与工具链以 [sources.lock.json](../sources.lock.json) 为准：ZCode 29628c9acdb81b703bbd4080c207a0e7ce5e276e，DSH 639ed015397290b3745d163aafe02ffee4aa3f84，Herta 4623df120adf99340ce5f7e25ed829466975e3ae；本机 Windows x64 / Node 24.16.0。隔离 checkout 与只读 reference 分离，未改变生产配置。

| 范围 | 采用方式 | 已完成验证 | 使用限制 |
| --- | --- | --- | --- |
| 主 Loop、工具与配置 | 依赖固定 ZCode，公开插件薄适配 | U02 CLI 过滤构建、mock 成功/错误/新运行恢复及 1 次真实模型；U07 原生 bootstrap、官方插件上下文和额外 1 次真实普通请求 | 没有完成全桌面构建、打包或 persona 一致性验收 |
| 每轮 ContextPacket | 适配 SessionStart / UserPromptSubmit，保留来源与预算 | U07 新会话、compact 后首轮、恢复、Read 失败后下一轮和 Plan 工具拒绝均捕获实际请求及 Hook 日志 | 原生第一段 system 身份仍是 ZCode；包是 user 层 system-reminder。新会话和恢复首轮重复 2 份，Hook 有 24,000 字符限制；不能以提示词代替权限 |
| 主会话与子代理 Memory | 复用原生 helpers / executor，Xiadie 另管权威数据与身份 | U08 18 项断言；6 个真实 scope 根与 6 次实际写入；Git worktree、move、显式 ID、工具 deny 和 Plan 负例 | 仅 helpers/executor/FS，未证明完整 AgentRuntime、Memory 服务或自动检索；缺显式 ID 时路径变化会换根；agent 名清洗存在碰撞 |
| 独立工作包 | 依赖官方 DSH SDK / 三个真实 wire 请求，薄桥接隔离实例 | U09 native sdk-minimal + loopback Messages SSE，messageId 回执/idle/结果；慢响应、重复通知、污染帧、空 final、强杀、重启和磁盘完成检查点 | 没有 per-prompt cancel、resume、session-close 或审批回传；新 ID 新会话无旧历史；空 final 仍能 idle；高层 run 的最后 root assistant 是弱归属结果 |
| Windows 进程生命周期 | 最小宿主管理原型参考 Job Object，产品实现留 P07 | U09 独立复跑 A/B Job 只关闭 A 不影响 B、SDK 在已归属 Job 后启动、detached leaf 父退出后由外部 Job 清理 | 原型仅受信任 fixture / 本机 Windows。不是文件系统、密钥或恶意代码沙箱；强关不保证检查点刷盘 |
| Life / Dream | 借鉴机制，未来按任务选择少量 MIT 纯函数并登记移植 | U02 直接运行 Herta 四个纯函数，正常、坏时间戳、system 反例与新输入重算 | 不把其 lossy episode hash 当完整来源身份；90 天保留只可作为 Life 候选，绝不作用 Project。完整 DB/崩溃恢复未测 |

真实模型累计只有 2 次，7877 的 [基元]deepseek-flash，5067 total tokens；网关没有返回金额。U09 仅 loopback、假凭据且实际 tools=[]。这些实测不代表整个模型矩阵已获兼容结论。

## 最小自研差额及拒用依据

| 差额 | 已查候选与拒用理由 | 下一阶段必须证明的结果 |
| --- | --- | --- |
| ContextPacket 与角色来源/预算适配 | 原生 Hook 成功，优先复用；无限附加历史被 24k 限制否决。独立 Self Runtime 引入第二套路由且缺必要证据；整仓 patch 暂无理由 | P01 每轮来源/版本/预算可追踪，首轮重复有明确去重/预算规则；角色在声明支持的模型上实测。若 Hook 无法达到身份要求，先评估薄服务/最小下游 patch，再独立 ADR 比较 Self Runtime 成本 |
| 项目、会话、agent 稳定身份及执行权限适配 | 原生 path hash 不能保持移位身份；同显式 ID 会共享根；显示名清洗碰撞。只写 tools=[Read] 不够，因为 persistent-memory 自动加 Write/Edit；Plan 模式允许 memory Markdown 写入 | P03/P08 唯一稳定 ID、scope 和项目迁移规则；只读必须 explicit deny 或过滤注册表，实际 executor 负例无磁盘改动；缺失/不可读/冲突不得变成事实 |
| 权威 Memory / Life 提案提交 | 原生 Markdown roots 可作视图但未承载 Xiadie source_refs/base_version/privacy_epoch。Herta 使用不同类型及失真投影 hash，整体 fork 不满足权限与角色边界 | P03–P06 定义来源、版本、删除 epoch、proposal 校验及事务/恢复；确定性代码决定提交。Project 不衰减，未知提交状态先核查 |
| DSH WorkPackage / 结果 / 完成检查点薄桥接 | 官方 SDK 可用；共享 Web adapter 本地候选标 UNLICENSED 不复制；内部 subagent 包的 AbortSignal 只关闭整实例且不能补工具/身份/schema，不能冒称本次已测 | P07 每实例一项在途工作、独立 env/home、结果 schema 和唯一回执；原生协议无审批时回主端。completed 可读回；未知效果不自动重发。P00 检查点仅同宿主进程中的关闭后读盘，不证明 crash consistency |
| Windows 专属进程树关闭 | SDK 直接拥有子进程；本机 Node 对 attached children 另有 libuv global Job，不能归功于 SDK。detached helper 实测存活，单 PID kill 不覆盖完整树。Windows 官方 Job 提供可复用机制 | P07 在导入/产生工作前归属独立 Job，保留句柄、拒绝 breakaway；只关本实例且等待退出。产品重启/半写/副作用 reconcile 后续验收；不能将终止命名为成功取消 |
| 薄呈现与候选打包 | CLI/bootstrap 已可运行，优先服务层适配；直接移植 Electron 与 installer 未实测 | P01 入口、P10 UI，P14/P16 Windows 包、更新、卸载与签名按实际 payload 测试；P00 只冻结原创研究候选 |

来源与拒用证据分别为 U01 source-decision、zcode/dsh/herta 分项调查，U02 已接受复用 ADR，U07/U08/U09 result、原始 run 与独立 review。每项差额均从已有接口的实际限制得出，本文没有实施产品 adapter。

## 许可、旧工程和数据边界

[reuse.md](../legal/reuse.md) 与 [资源清单](../../assets/manifest.json) 是后续采用边界。ZCode 是 Apache-2.0；DSH 与 Herta 根源码 MIT，依赖/商业 SDK/嵌入资源须逐 payload 核验并保留 notices。Herta 角色 prompts、图片、网页、声音不复制；当前批准角色资源数量为 0。Live2D/语音和未来 Windows 包权限尚未完成，不能从源码许可推断角色授权。P00 的本地原创研究候选不携带第三方源码、依赖二进制、角色素材或密钥。

旧工程只读盘点、移动逐文件哈希、隔离目录与回滚记录已完成；未找到的旧 Library 原文和 E:\Xiadie\Xiadie-next 保留 Source unavailable / Unverified，不声称读过。原压缩包及 immutable planning 不变。R24 最终备份恢复能力留到后续，P00 仅证明旧工程保护与研究隔离。

## 失败退出与重新选型

以下任一条件是下一阶段停止当前路线并保存最小复现的触发点：

1. 原生 Hook 不能稳定给新会话、compact/恢复及每轮提供有来源和预算的上下文，或身份实测不达需求；比较最小公开服务适配/下游 patch，变更主运行时需新 ADR。
2. 执行端 deny 负例失败、scope 跨项目或 agent 串线、无法建立稳定身份、未知/不可读 Memory 被当事实；不靠提示词掩盖，先修 adapter 或更换接缝。
3. 固定 commit、源码/lock、Node ABI 或 loader 改变；旧证据失效，重跑受影响 PoC/回归后重新接受，不自动升级 latest。
4. DSH 回执与结果归属不明确、停止留下自有后代、恢复需要重发未知副作用，或要求原生 cancel/approval；保持 unknown，改桥接或再选型，不编造协议。
5. 实际发布 payload 的权利、依赖 notices 或角色资源许可未闭合；对应分发 gate blocked，本地源码研究结论不能替代产品发行批准。

P00 的有限路线选择可通过这些后续限制，不代表全部 28 项最终产品 Must 已完成。G00 仍需 U11 成功/失败/取消/恢复回归、7 项 P00 Must 证据与 U12 实际候选无 Key/无 DSH/离线降级。本文接受后仅推进 U11，G00 pass 才开放后续施工，远程 tag、上传或正式发布另需授权。

## 回滚与测试映射

本单元仅新增 ADR 与 U10 evidence；回滚用独立提交 revert，保留历史 runs 与未确定外部效果，不删除用户数据或重写 accepted units。计划目标 tests/units/P00-U10.test.ts 映射为 U10 独立文档审查：逐项检查唯一路线、Core 边界、每个自研项的候选/拒用证据、来源/许可/限制、触发条件，并绑定精确 SHA。没有为文档写实现镜像测试；下一单元运行真实集成。
