# U10 保留的失败与修正

失败不会因后续修复而改写为通过。原始候选及运行目录保留在项目 `.runtime/P01/`；此目录保存可审查副本及逐文件 archive index，Chromium 缓存、链接和自动生成的证书材料不进入证据提交。

| 尝试 | 实际失败 | 修正与重验责任 |
| --- | --- | --- |
| candidate 01 build | CLI bundle 无法从 Xiadie 工作树解析三个 `@zcode/*` 导入，exit 1，无可用 descriptor | 使用已配置的 `@p01/native-*` alias；candidate 02/03 构建成功 |
| 只读 FS 初版 | stub 未揭示方法名与真实 NativeFileSystemPort 不符 | 改用固定接口 `readTextFile` 等，并新增实际原生 adapter 读取、缺失和越界验证；4/4 |
| FS 原生测试初跑 | 原生 `.js` 导出指向 TS 源码，普通 import 无法解析 core.js | 复用固定源码的 tsx register；重跑通过 |
| candidate 02 success a | profile bridge 没有在正确的项目根运行 | runner 的 REPO 改为 parents[3]；失败保留 |
| candidate 02 success b/c | 首窗未出现，guard 将 Electron `session-created(session)` 误写为两个参数，TypeError | 按固定 Electron typings 修为单参数；candidate 03 首窗出现 |
| candidate 03 success a | Desktop 从 owned data/.zcode/v2/provider_config.json 读取配置，原测试写入其他路径，界面无模型；同时引导页过渡误判 | 按固定 Desktop paths.ts 写入正确的合成配置路径；未动生产配置 |
| candidate 03 success b | 界面已有 Flash 和输入框，但隐藏的 onboarding 节点仍被 count 命中，重复 Skip 点击超时 | 优先判断可见输入框；只点击可见引导页并等待步骤切换 |
| candidate 03 success c | 实际输入和发送后原生协议创建失败，0 模型请求；日志报 close 只读 | 固定 ProtocolRuntimeResources 会接管 app.close；factory 必须保留该方法的原生可写语义，修复后用新候选重跑 |
| candidate 04 success a | 已进入 CLI，但身份 Hook 没有有效回执，界面明确显示 hook-receipt 拒绝，0 模型请求 | CLI 专用 NODE_OPTIONS 预加载被后代 Hook 继承；改为只在目标 CLI argv 中注入 `--require`，不传播 NODE_OPTIONS |

candidate 04 success b 调试格通过：实际输入框/发送按钮、1 次本地 mock 请求、一个已完成回合的 U07 投影与回复 hash 一致。该格保存在 `debug-smoke/`，完整阶段验收以最终提交上的正式映射 full runner 为准。早期 UI 调试在作者修改期间执行，保留观察结果及原始日志，不将其当作最终代码的完整精确版本回归。

静态独立预审另外指出：构建必须验证干净的作者工作树并将实际输入逐字节对照 commit 的 Git blob；runner 不得只记录 factory/recipe 不匹配而继续通过。网络 guard 也须覆盖实际通过 spawn 启动的 CLI，而不只覆盖 Electron 主进程和 utility host。上述检查是最终验收的前提，不能用较早候选的构建通过代替。

测试入口曾允许 Node 在其他测试存在时静默略过缺失路径；`tools/run-tests.mjs` 现在先检查每个声明文件，缺失明确 exit 1。早期局部 13 项是 factory/FS 检查，不是包含 UI guard 的完整 U10 单测。

归档时曾遇到 Windows 长路径限制，归档脚本改用本次目录内的扩展绝对路径，并校验已复制字节后续传；Git 仅在此仓库启用 core.longpaths。自动生成的本次测试证书材料在作者分支整合前排除，保留其源位置与 hash，不输出内容。

## 正式 full-run 失败（原始记录保留）

| Run | 原始结论 | 后续处置与当前状态 |
| --- | --- | --- |
| `validation/final-01` | runner 在启动 UI 前以 `candidate_repository_not_clean_and_pinned` 拒绝候选；check 与 unit 命令通过，e2e exit 1。该轮没有实际 Desktop 场景，属于候选来源/干净树预检失败，不是产品场景失败。 | build-candidate 增加 Git blob 与实际输入字节核验，并要求 pinned/clean 候选；原始 `runner-failure.json`、commands 和日志保留。 |
| `validation/final-02` — `cancel_recovery` | UI 的 partial → Stop → 再次发送 → 回复恢复均成功，relay 有 2 个请求；但被取消回合的 completion Promise reject，使 sidecar 标记 `turn_completion_failed`，虽然原生 SQLite 已记录 `turn_complete.resultType=cancelled` / cancelled usage，导致该格未通过。relay 同时曾把 renderer client disconnect 记为 HTTP 500 `relay_internal_failure`，但 `upstream_attempted=false`；UI harness 的 disconnect 记账在后续修正。 | commit `1249821` 在 completion 拒绝时只读取已有 U07 collector 的原生 terminal 事件，并调用既有 `project(undefined, ...)`；仅原生 cancelled terminal 可以生成 cancelled 投影，任意异常不映射成取消。factory 测试覆盖该契约。final-03 中此格通过。 |
| `validation/final-02` — `disabled_native` | 禁用候选 gate 后原生回复可见，但 native Desktop 随后发出 auxiliary-title generate 请求；首版 harness 将它当成多余的对话模型调用，2 个请求未满足预期的单次普通生成。 | commit `68de988` 给实际 auxiliary title 请求分类并保留 native 形状；candidate-05 final-03 已证实该请求标为 `auxiliary_title:true`，但 pinned SDK 的 `generate` 请求没有 `stream` 字段；当前归档器把缺省推导为 `false`，relay 因形状校验以 `auxiliary_title_request_shape_mismatch` / HTTP 400 拒绝。主回复通过不使该场景或 full suite 通过。修正方案按 wire capture 接受 `stream` 缺省；隔离 env 显式设 `ZCODE_MODEL_RETRY_MAX_RETRIES=0` 保持单次拒绝，该测试值不代表产品的生产默认策略。candidate-06 / final-04 已重建重跑，见下。 |

final-01、final-02、final-03 与 final-04 的归档文件及其原始日志都保留在本目录的 `validation/` 中；上表仅作索引，没有覆盖早期失败记录。final-03 是历史 5/6、exit 1 的结果；final-04 使用独立新目录，不能回写旧 run。
## 修正后复验

| Run | 结果 | 证据边界 |
| --- | --- | --- |
| `candidate-06` / `validation/final-04` | check 0、unit 79/79、full suite 6/6，全部 exit 0 | wire capture 证明 pinned SDK 的 `generateText` body 不含 `stream` / `tools` / `tool_choice`；candidate-06 按该真实形状接受 disabled-native auxiliary-title POST。全轮仅 loopback mock、9 次本地 POST、0 外部模型请求。`ZCODE_MODEL_RETRY_MAX_RETRIES=0` 只在隔离测试 env 生效，不代表生产默认值。作者结果为 `ready_for_review`，尚未独立 accepted，也不等于 G01 pass。 |

这一复验没有删除或覆盖此前失败记录；精确产物与命令见 [result.md](result.md)、`builds/commands-06.json` 和 `validation/final-04/`。