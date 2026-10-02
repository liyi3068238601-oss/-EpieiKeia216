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
