# P01 恢复执行线索

本页保存暂停前的只读调查，不表示 U06 或发行包已经实现、测试或验收。下一单元是 P01-U06，必须先读取 U05 的最终验收记录与本次暂停交接。权威任务卡始终是 `planning/Xiadie_V2_v1.1/tasks/`；不修改冻结计划。

## U06：插件接入与失效阻断

固定 ZCode 源码提交为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，本地只读路径 `references/zcode-29628c9/`。已接受 U02 试验的入口是 `spikes/P01/plugin/.zcode-plugin/plugin.json`、`hooks/hooks.json` 和隔离 `createZCodeApp` 配置；启用与禁用插件的原生运行证据可复用，不能称为 Marketplace 安装验证。

源文件 `apps/zcode-cli/packages/core/src/hooks/configured-runner-callback.ts` 的 `parseHookStdout` 会把无法解析的 JSON stdout 当作诊断文本，返回 `undefined`；runner 的异常处理也会记录 Hook 失败后继续。主控重新读取这些路径及 `hooks/output.ts`、`runtime/methods/turn.ts`，确认有效 `UserPromptSubmit decision: block` 才会在模型循环前设置 `preventContinuation` 并结束当前回合。仅有 SessionStart 校验或捕获 `hook_run_failed` 不足以覆盖全部失败：坏 JSON 可以表现为无注入的成功 Hook。

恢复时先完成宿主侧 approved character / ContextPacket 预检，再验证原生 Hook 回执与阻断路径。不得依赖 Hook “通常成功”来保证身份和权限。独立反例至少覆盖：无效素材、超时、非零退出、错误 schema、坏 JSON、缺少有效回执，且确认这些失败不产生模型请求；还要覆盖禁用扩展后原生 Runtime 可用。

`additionalContext` 是 user 层的 system-reminder，生命周期上下文有 24k 字符上限，不能直接称为 system 权限。U05 分区是数据契约，原生宿主 system / project rules / tool permissions 仍需在实际接入中保持各自权限。

Hook transcript 是每次回调创建并随后删除的临时文件。UserPromptSubmit 只含当前 user 内容，Stop 只含当前 assistant，不能冒充完整历史；读取须有界并及时转成摘要或哈希，不保存临时路径作为可恢复历史。原生 resume 有 SessionStart，compact 后没有同等 Hook 事件，需要分别验证。

## U07 至 U11：未开始的验收范围

- U07：用真实工具收据投影成功、失败、取消与部分完成，禁止再加模型重写来伪造成功。
- U08：独立配置、秘密引用、无 Key 的实际 UI 历史、异常与导出凭据检查；产品启动入口必须隔离数据根并使用动态 loopback 端口，禁用固定 9229。
- U09：通过实际已接入的管线做两条 DeepSeek 官方 API 模型 ID 路线评测。当前阶段模型生成请求累计 4 次，初始 18 次小样本约束尚余 14 次；预算沿用用户“无上限”。两条模型 ID 有效，但后端独立性未确认。不要读取或复制真实用户历史作测试资料。
- U10/U11：在精确提交上独立集成回归、候选包运行和 G01 验收；开发目录启动不替代 Windows 发行包运行。未获授权自动进入 P02 或正式发布。

## Windows 候选包：源码可行，发行验证未运行

暂停前只读检查确认 `.runtime/P01/desktop-source` 与固定 ZCode 提交一致且干净。U02 已编译 Preview flavor 和 Electron 41.0.3，实际 Settings DOM、偏好保存与重启重读通过；Windows packaging 与包内 runtime assets 验收仍为 `NOT_RUN`。本地 runtime assets 的已有产物不能替代完整包内资源验证。

`packages/desktop/electron-builder.config.js` 支持 `ZCODE_DESKTOP_DIST_DIR`，NSIS 为可选安装目录；源码的 Main AUMID 与编译期 flavor 相关，所以打包时应保持 Preview 身份一致。不要只覆盖 appId 后声称隔离完成。builder hook 会临时修改 node_modules 中的 NSIS 模板，候选包应在独立副本制作，保留固定参考源。

可研究的候选方向是在隔离副本设置 `ZCODE_PREVIEW_IDENTITY=1`、`ZCODE_ENV=test` 与项目 `.runtime` 输出目录，使用 `electron-builder --win nsis --x64 --publish never`，或 portable target；这些命令尚未执行。已知 builder 缓存没有 NSIS/nsis-resources/winCodeSign/app-builder 工具，离线打包能力未证，需要恢复后调查依赖或补齐工具；本次暂停不下载、不打包。

运行复核可以参考 `spikes/P01/run-desktop-ui.py` 与 `verify-ports.py` 的独立 HOME/profile/data roots 和启动前 listener 快照。现有脚本只实测未打包 Electron，候选包必须另做实际启动与端口检查。

官方打包参考：[CLI](https://www.electron.build/docs/cli/)、[Windows targets](https://www.electron.build/v26/docs/win/)、[NSIS / portable](https://www.electron.build/v26/docs/nsis/)。这些线索来自只读源码与文档调查，不是发行验收证据。
