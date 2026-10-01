# P01 原生接入调查与候选比较

日期：2026-10-01。本单元只调查，不把源码能力、P00 实测或本文候选决定当作 P01 产品验收。前置 P00-U12 与 G00 已接受；固定版本和逐文件 SHA 见本单元 `verification.json`。

## 来源与检索

- ZCode：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`，Apache-2.0。[固定 README](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/README.md)。P00 允许本地依赖、隔离构建及薄宿主试验，不更改参考树或生产配置。
- 官方插件文档：查询时 `main` 为 `c94279c9a449235fd5991f7903a6c7e4fdc3ab7e`，使用[固定开发文档](https://github.com/zai-org/zcode-plugins/blob/c94279c9a449235fd5991f7903a6c7e4fdc3ab7e/docs/PLUGIN_DEVELOPMENT_CN.md)及 [Hooks 文档](https://zcode.z.ai/en/docs/hooks)。该文档版本不是固定 ZCode 源码版本，差异须分别记载。
- Herta：`4623df120adf99340ce5f7e25ed829466975e3ae`。[许可](https://github.com/PersonaCLI/Herta/blob/4623df120adf99340ce5f7e25ed829466975e3ae/LICENSE)允许 MIT 代码，但排除角色资产。只参考稳定前缀、动态记录的结构和测试设计，不移植其角色文本、例句、图像、声音。
- 用户提供的 Neo-MoFox 人格：只读人格字段，源 SHA、用户选择和所有版本见 `persona-source.json`、`persona-decision.md`、`persona-versions.json`。原始人格仅保存在私有档案。冻结计划的原创身份措辞与本次用户选择的差异已登记。

检索路径：固定树中用 `rg` 查 `userConfig/sensitive`、`skipApiKey/onSkipped`、`configureZCodePlugin`、`createPersonalProvider`、`createModel/ProviderRegistry`、`subscribeEvents/readSessionEvents`、`hook_context/transcriptPath`；查看 Git 跟踪的测试与安装/build 脚本。对官方当前文档核对 manifest、Hook、安装流程和敏感配置语义。调查员读取完整 Hook 装配/输入/回调、Provider 仓库/工厂、设置控件、登录表单、事件合并器及 Herta 的静态前缀/actor 代码与测试；大型 Root、事件合约和 bootstrap 类型按相关完整方法/接口读取。主控另核对原生订阅入口、Hook 注入、登录 Skip、Provider factory、相邻迁移测试及 P00 实测宿主。

## 原生接口和实际差额

| 目标 | 固定源码观察 | 限制与 P01 实验 |
| --- | --- | --- |
| 身份注入 | `adapters/src/plugins/hook-sources.ts:8-101` 解析标准 Hook 文件并限制根路径；`core/src/runtime/methods/hooks.ts:15,109-139` 将上下文作为 reminder 注入 | 上限 24000 字符；不是最高系统身份层。P00 已发现第一系统消息仍为 ZCode、新建/恢复会重复注入；P01 必须验证真实角色行为，不能用 README 保证。 |
| 临时会话上下文 | `core/src/hooks/configured-runner-input.ts:25-29,62-67` 创建并清理 transcript | Hook 期间立即读有界内容并派生摘要；不能只保存路径。原始 transcript 不进入公开证据。 |
| 事件证据 | `core/src/runtime/agent-runtime.ts:494` 导出 `subscribeEvents`；P00 薄宿主实际使用 `app.runtime.subscribeEvents`；桌面服务另有 `readSessionEvents` | Hook 只包含七类生命周期，不能得到内部模型对象。薄宿主已有原生订阅，可先尝试白名单投影，无证据表明必需 fork。原生 ModelRequest 与工具参数含敏感内容，不能完整转发。 |
| 无 Key 设置 | `packages/ui/src/login/LoginApiKeyForm.tsx:125-132` 的 Skip 只更新 family 设置，不写空 Key、不标登录成功；`Root.tsx:873-900` 等待入口关闭；服务有无会话 storage 准备接口 | 源码证明入口存在，尚未证明桌面可达、零网络或本地记录可读。U02 分开验证控制面与桌面可达性，不能用纯 mock 代替。 |
| 配置与密钥 | `PluginConfigControls.tsx:104-145` 支持 password/reveal 输入，最终原子写 JSON；Provider 独立仓库支持明确 filePath 与锁 | password 遮罩与 0600 不是加密/keychain 保证。当前文档说敏感项暂不支持 UI 直接填写，与固定代码不同。真实 Key 不放插件配置、环境或证据；使用隔离 Provider 引用/父进程授权传递。 |
| 模型执行 | `bootstrap/src/app/provider-registry-model-runtime.ts:69-89` 精确查 Registry 后调用统一 adapter；`model-execution.ts:255-318,350-385` 装配 Provider/Model | 不在角色插件内另建客户端或另一条自主 Loop；试验使用原生 provider/模型/工具链，真实凭据由内存 relay 注入。 |
| 禁用与原生能力 | `bootstrap/src/app/types.ts:385-387` 有插件启停/卸载；插件 Hook 随 session 装配 | U02/U06 在新 session 验证，关闭后不能仍有角色注入；G01 另需真实原生交互可用证据。 |

路径中省略的 `core/adapters/bootstrap/contracts` 前缀均位于固定源码 `apps/zcode-cli/packages/`。桌面相关 `packages/` 位于 ZCode 根。证据清单使用完整仓库相对路径。

## 合理候选

| 候选 | 可直接复用 | 自研差额与权限 | 判断 |
| --- | --- | --- | --- |
| A：官方插件 + bootstrap 薄宿主 | manifest、Hook、原生 Provider、Loop、工具与事件订阅；未来可复用原生 UI 设置 | 本地 Hook 进程、有界角色加载/ContextPacket、只读脱敏投影与独立 profile；宿主调用公开接口，不改原生 Loop | 优先做 U02。插件本身不能包办事件，但现有 bootstrap 导出可补这个窄边界。 |
| B：小范围下游 Host patch | 同一原生链路，宿主内增只读接口或身份接缝 | 维护 fork、差异和合约测试；必须有 A 失败的复现及最小 diff，不能因方便提前 patch | 保留后备候选；当前没有足够证据批准。 |
| C：插件自己调用模型或引入 DSH 作主回复 | 接口拼接自由 | 重复客户端、鉴权、调度与错误处理，事件来源分裂；改变 G00 架构 | 拒用。DSH/Dream 不默认启动。 |

Herta 的 `static-prefix.ts:48-141` 和 `actor-prompt.ts:320-417` 可借鉴稳定头先于动态记录，相关测试验证其自身顺序与等价性。其结果不能证明 ZCode 的请求缓存命中；本阶段不移植代码或角色资产。

## 测试、安装与许可观察

固定 ZCode 跟踪树的四个相邻测试为 services 的 Provider 迁移、nonCliAcpRetirement、importedClaudeRecovery，以及 UI 的 nonCliAcpRetirement；没有找到专门的 Hook/no-Key/本次投影测试。迁移测试实际断言源配置不被改写、保留已有个人配置、坏旧配置不覆盖成空配置。缺测试不等于能力失败，但需要 P01 实际补证。

Herta `static-prefix.test.ts` 与 `actor-prompt.test.ts`、相关 package build/test 命令已阅读；ZCode 根、CLI、desktop build 脚本与官方本地 marketplace 安装说明已调查。此单元没有运行安装、构建、Hook 或模型生成。官方教程的本地安装过程与固定源码 loader 能力仍须在隔离数据根验证；不借此修改用户全局市场。

## 交接与边界

U02 默认检验 A：先无 Key 控制面/设置与本地记录，再 mock 成功、工具失败、取消或恢复，最后在两条已授权路线运行少量合成只读输入。模型授权已明确为 7877 的 deepseek-flash 与 glm-5.3-flash、初批最多18请求、无金额上限；每次生成记账，禁止未授权自动付费重试。真实素材仅发送当前简化正文，私有人格原文不发送。

尚未证明的内容：桌面完整 no-Key 可达性、敏感配置 UI 的运行表现、原生身份层下的双模型角色行为、原生事件投影完整性和发行包交互。任何关键失败先记录并修复或保留阻断，不能凭调查文档接受 U02、U04 或 G01。

回滚：revert 本单元研究提交；私有原始人格档案、全部已保留版本、P00 接受记录及生产配置不删除。未知外部效果先核查，禁止盲重试。
