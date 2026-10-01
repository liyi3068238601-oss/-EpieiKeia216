# P00-U08 实测映射

计划卡中 tests/units/P00-U08.test.ts 是目标位置示例，固定 ZCode CLI 仓库中没有现成可复用的同类单元测试。此次采用独立离线 runner spikes/zcode-memory/probe.mjs；它调用固定 build 的 API 和真实 Node 文件系统，不创建应用测试框架，也不声称完整 CLI 或 AgentRuntime E2E。

| 验收点 | 实际入口 | 输出证据 / 断言 |
|---|---|---|
| 启用 persistent memory 后工具投影变化 | projectPersistentAgentMemoryTools，按 user/project/local profile 各执行一次 | probe-results.json 的 profileProjection、scopeMatrix；18 个断言中包含无 memory 不加 Write/Edit 的控制组 |
| user/project/local scope 与同名项目隔离 | loadPersistentAgentMemory；六个 Write 调用经过 ToolExecutorImpl 和 NodeFileSystemAdapter | scopeMatrix、writes；sameNameProjectsShareUserRoot、sameNameProjectsSeparateProjectRoots、sameNameProjectsSeparateLocalRoots、projectAndLocalMarkersIsolated、userScopeShared |
| Plan 下记忆 Markdown 可写，普通工作区写入受拒 | ToolExecutorImpl.execute(Write)，真实 permission flow/Write handler/NodeFileSystemAdapter | writes；planModeAllowsMarkdownMemoryWrite；negativeCases.planOutsideMemory，断言 PERMISSION_DENIED 且文件不存在 |
| 显式禁止 Write/Edit 不被 memory 例外覆盖 | ToolExecutorImpl.execute(Write/Edit)，PermissionService.disallowedTools | negativeCases.explicitWrite 与 explicitEdit；explicitDisallowedWriteAndEditDenied；Edit 的拒绝前后字节相同 |
| 只读子代理工具过滤后执行端拒绝 | memory 工具投影 -> filterSubagentChildToolNames -> 只注册过滤后的 Read 工具 -> ToolExecutorImpl.execute(Write) | profileProjection 与 negativeCases.filteredChildWrite；childFilterRemovesWriteAndEdit、executorRejectsFilteredChildWrite；实际错误 TOOL_NOT_FOUND，目标不存在 |
| 两个同 basename Git worktree 与移动 | 合成仓库 git worktree add --detach；写入后 git worktree move | gitCommands、move、writes 与实际文件内容；project/local 内容随移动后的工作树保留，B 内容独立 |
| 主会话 Memory path 与 identity | 固定 resolveProjectMemoryRoot resolver | mainMemoryRootIdentity；无 identity 时路径变化；显式相同 identity 跨两个 worktree 相同；不同 identity 隔离 |
| profile 名称隔离及清洗冲突 | loadPersistentAgentMemory | profileNameCollision；不同名称 Memory Observer 与 Memory Keeper 分离，Researcher/QA 与 Researcher:QA 实际碰撞 |

运行证据和来源绑定见同目录 verification.json。attempt-01/02 是保留的过程记录；最终验收映射绑定 attempt-03。
