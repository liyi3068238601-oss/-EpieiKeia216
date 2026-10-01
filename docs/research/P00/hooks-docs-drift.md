# Hooks 官方资料核对

2026-10-01 读取官方 Hooks 文档 https://zcode.z.ai/en/docs/hooks 和插件开发说明 https://github.com/zai-org/zcode-plugins/blob/main/docs/PLUGIN_DEVELOPMENT_CN.md 。`git ls-remote https://github.com/zai-org/zcode-plugins.git HEAD` 在新项目根执行，exit 0，返回 `c94279c9a449235fd5991f7903a6c7e4fdc3ab7e`。固定链接为 https://github.com/zai-org/zcode-plugins/blob/c94279c9a449235fd5991f7903a6c7e4fdc3ab7e/docs/PLUGIN_DEVELOPMENT_CN.md 。

当前网页说明项目级 hook 配置忽略，用户级与启用插件按顺序执行；固定 ZCode 源码包含 workspace hook discovery/review。因此动态网站不作为固定提交的兼容承诺，PoC 以固定源码行为和实测为准。

试验选择官方插件布局 `.zcode-plugin/plugin.json` + `hooks/hooks.json`，命令采用 process 的 argv 形式，并在隔离的用户 config 中注册本地插件。SessionStart 用 startup/resume/clear/compact matcher，UserPromptSubmit 没有 matcher 过滤；stdout 仅协议 JSON，诊断写 stderr。采证必须在 hook 返回之前读取并另存临时 transcript；上游返回后会清理临时目录。

公开 hook 不接受可直接调用模型的内部对象；allow 也不能绕过明确 deny、Plan 写禁令与硬工具限制。这些仍需执行端负例验证，不能仅引用文档宣布安全。
