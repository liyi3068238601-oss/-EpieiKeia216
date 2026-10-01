# P00-U07 原生上下文接缝试验

作者状态：`ready_for_review`。前置 U06 已 accepted，基线 `1697826`。本单元仅新增 `spikes/zcode-context/` 和本 attempt 证据；P01 尚未开放。

采用原生插件的 SessionStart/UserPromptSubmit 路线，使用现有 bootstrap API 驱动原生 Loop、模型适配器、事件、持久化、compact 与工具执行器。未改上游 Loop，也未制作 UI。所有 packet、Hook 与驱动代码为本次原创合成测试，没有移植 Herta 角色 prompt 或素材。ZCode pin 为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；API/插件接口按该提交核验，当前网页说明不能替代固定源码行为。

## 实测

成功 mock run：`mock-1790831051954627900`，Python command `python spikes/zcode-context/probe.py mock`，cwd `E:\Xiadie\Xiadie`，exit `0`；内部 Node argv/cwd/exit 与原始 provider 请求、Hook stdin/临时 transcript 哈希、事件输出均记录在 summary 和 runs 目录。8 次本地模拟模型请求，外部模型调用 `0`。

- 同一个 Runtime/session 连续执行 new → compact → postcompact → Read 失败 → Write 拒绝，关闭 App 后同一 sessionId 冷恢复。
- 原生事件包含 `compact_completed`。compact/postcompact 未运行 SessionStart；postcompact 的 UserPromptSubmit 注入了当前唯一 packet version，并位于当前用户请求之前，排除了只检查旧历史 marker 的误判。
  compact 摘要请求本身没有运行新 Hook，不将它记为新 packet 注入成功；compact 后仍可含原生保留历史或摘要，验证的是下一条普通用户请求的新版本附加内容。
- 新会话、postcompact 和恢复的 UserPromptSubmit 实际顺序为 user audit → plugin；恢复 SessionStart 的 source 为 `resume`。原生首条 system 消息仍为 ZCode，注入内容为 user-level `<system-reminder>`。
- 缺失文件 Read 经原生执行器失败，插件 PostToolUseFailure 的新 marker 出现在下一次模型请求，随后同一 Runtime 完成本轮。
- Write 的 PreToolUse 插件返回 `allow`，实际原生 `permission_denied` 仍报告 Plan 只允许只读工具；`forbidden.txt` 未生成。本试验关闭 memory，不将这个结果推广为启用 memory 的权限保证。

真实 run：`real-1790831125052621600`，command `python spikes/zcode-context/probe.py real`，同一项目 cwd，exit `0`。7877 的 `[基元]deepseek-flash` 收到一个工具列表为空的请求，HTTP `200`，准确返回 `synthetic-xiadie|blue-orchid`。当前用户请求只要求读取两个字段，没有写入它们的值；值来自原生插件附加的合成 packet。真实计量为输入 `2583`、输出 `10`、合计 `2593` token，网关未返回金额。恢复/compact/工具故障的模型响应为 mock；这一次真实调用仅证明所选模型读到了本次附加上下文。

真实凭据只在 Python relay 内存和到用户选定网关的 Authorization header 中使用，没有进入子进程配置或证据。四个选定全局文件 before/after 哈希一致；这只是选定文件核验，不是 OS 沙箱。该用户选定网关仍使用 HTTP，不作 TLS 保证。

## 保留的失败与修正

1. `mock-1790830833806044700`：不带 tsx 的直接 bootstrap 导入因 workspace source export 内 `core.js` 无法解析而失败；Node exit `1`、模型请求 `0`。改用已存在的 tsx ESM loader file URL，未安装或修改依赖。
2. `mock-1790830862739595200`：误将原生 `getMode()` 的返回值应为 `plan` 作为断言；实际 `plan` 被原生执行状态规范化为 `build + planEnabled=true`，断言在模型调用前失败，exit `1`、请求 `0`。依据执行状态源码改为同时检查 base mode 和 Plan flag；未关闭权限检查或改变原生规则。

## 采用决定与限制

至少一条不重写 Loop 的上下文路线已实际跑通：官方插件 Hook，薄 headless bootstrap test host。后续优先沿用此接缝；本次没有证据要求另写 Loop、人格二次模型改写或 UI 层注入。Hook 输出仍受固定源码的 24,000 字符附加上下文截断与进程输出上限约束，不能当作最终 token 预算或 privileged system identity 的替代。正式人格跨模型一致性留待 P01/P13；Core/Life 的有界来源与预算留待 P04。

执行基于 U02 构建的现有编译入口，并经 tsx 解析部分 workspace 源码出口，不是完整 CLI 启动等价或可再分发的完整 compiled-tree 验证。summary 只绑定两个 compiled 入口；额外 loader 和来源文件哈希见 verification。Windows UI/安装器/完整产品、恶意插件、OS 隔离和启用 memory 后的权限为 `NOT_RUN`，不能报为通过。

测试映射：`tests/units/P00-U07.test.ts` 映射为 `spikes/zcode-context/probe.py` 的实际原生运行与请求/事件/真盘断言，不建立产品测试框架。成功和失败原始证据均保留。回滚本单元独立提交即可，隔离数据根保留供复核；不删除用户或上游文件，不涉及外部发送、发布或资产分发。
