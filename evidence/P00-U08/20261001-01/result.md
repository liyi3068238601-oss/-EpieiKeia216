# P00-U08 子代理记忆与主会话 Memory 根试验

作者状态：**ready_for_review**。基线为工作区 HEAD **b90d084d31b6854fa6d6bb9edc2ef62c8707649d**。本次只新增 spikes/zcode-memory/ 与 evidence/P00-U08/20261001-01/ 下的试验文件和证据；不改总状态、规划、固定参考源码或既有 accepted 证据；未提交。

## 实现与固定来源

离线 probe 直接导入固定 ZCode 提交 **29628c9acdb81b703bbd4080c207a0e7ce5e276e** 已构建的 ToolExecutorImpl、ToolRegistryImpl、PermissionService、Read/Write/Edit handlers、NodeFileSystemAdapter、persistent-agent-memory helpers、子代理过滤器和主 Memory 项目根 resolver。使用现有 tsx ESM loader 解析固定 workspace 依赖；未安装依赖或运行完整 CLI。ZCode 根 LICENSE 为 Apache-2.0。probe 只调用已有 API，不复制上游实现，不移植角色语料或 prompt 资产。相关 17 个源码文件和 10 个实际导入的构建入口均记录 SHA-256；固定源码 checkout 在执行前后都由 Git 实查为指定 commit 且 clean。

fixture 在本 attempt 输出目录内初始化一个纯合成 Git 仓库，并创建两个 basename 都为 TwinProject 的 detached worktree。Git 提交身份使用单条命令的 -c user.name 和 -c user.email 参数，没有改全局配置。所有实验路径均位于隔离输出目录；目录内 .gitignore 排除生成的 worktree、用户存储和主 Memory 存储，避免将临时嵌套仓库作为项目 gitlink 提交。

## 实测结果

1. **user/project/local 路径和隔离。** 对同名 agent Memory Keeper，在 A、B 两个同名 Git worktree 中都加载 user、project、local scope。user scope 按固定源码设计共享同一根；两边各自写入的不同文件均在这同一个共享根内。project 与 local scope 按实际 workspaceRoot 生成各自根，A/B 根不同，同名 marker 文件内容没有串域。六次 Write 都通过 ToolExecutorImpl 和 NodeFileSystemAdapter 落盘，读取到的实际字节与输入一致。
2. **启用 memory 时的工具面。** 三种 memory scope 的 profile 工具从 Read 投影为 Read、Write、Edit；不启用 profile memory 时不会自动加入 Write/Edit。只读 child profile 若只配置 tools=[Read]，memory 投影仍先加入 Write/Edit；显式配置 disallowedTools=[Write,Edit] 后，filterSubagentChildToolNames 将它们剔除，仅留 Read。将该结果注册为真实执行器工具表后尝试 Write，ToolExecutorImpl 返回 TOOL_NOT_FOUND，目标文件不存在。由此可见，只读配置需要保留明确的 Write/Edit 禁用规则，单靠原始 tools 列表不够。
3. **Plan 模式权限边界。** 实际执行器在 Plan 模式下允许把新 Markdown 文件写进已解析 memoryRoot；同样的 workspace 写入但目标在 memoryRoot 外，返回 PERMISSION_DENIED，文件不存在。对 memoryRoot 内目标显式 disallowedTools 禁止 Write 和 Edit 后，两者均返回 PERMISSION_DENIED；Edit 的目标字节在拒绝前、拒绝后及 worktree move 后完全相同。运行结果显示 memory 文件例外不会越过显式禁用规则。
4. **真实 worktree 和移动行为。** A/B 是同一 synthetic repository 的两个 detached Git worktree，且路径 basename 均为 TwinProject。用 git worktree move 移动 A 后，随工作树一起移动的 project/local 记忆文件仍可读，B 内容不变；user memory 在 workspace 外的 storageRoot，路径和内容保持共享。这个试验没有把普通目录名模拟成 worktree。
5. **主会话 Memory identity。** 直接调用固定源码的 resolveProjectMemoryRoot：未给 workspaceIdentity 时，根按规范化 workspacePath 生成，两个 worktree 分开，移动 A 后根随路径变化；显式给两个 worktree 同一个 identity 时根相同，换成另一个 identity 后根不同。此为 resolver 级验证，不能推断 ZCode 会自动给 worktree 分配或保持同一 identity；后续宿主需明确提供身份策略。
6. **名称边界。** agent 名 Memory Observer 与 Memory Keeper 的 project 根不同；Researcher/QA 和 Researcher:QA 经当前名称清洗后落入同一根，确认存在清洗碰撞。适配层若允许这类名称，需要稳定、无碰撞的 profile key；本试验没有修改上游清洗算法。

## 执行和证据

成功最终作者运行位于 runs/attempt-03/，命令为：

~~~powershell
$node = (Get-Command node.exe).Source
$loader = 'file:///E:/Xiadie/Xiadie/.runtime/P00/zcode/source/node_modules/tsx/dist/esm/index.mjs'
& $node --import $loader 'E:\Xiadie\Xiadie\spikes\zcode-memory\probe.mjs' --root 'E:\Xiadie\Xiadie' --output-dir 'E:\Xiadie\Xiadie\evidence\P00-U08\20261001-01\runs\attempt-03'
~~~

cwd 为 E:\Xiadie\Xiadie，Node 为 v24.16.0，exit code 0。原始 stdout 在 attempt-03-stdout.txt，完整断言、实际工具结果、scope roots、synthetic Git 命令、文件内容与 17+10 个 SHA 清单在 runs/attempt-03/probe-results.json。该运行有 18 项断言，全部为 true；其中六项 memory 写入成功，四个执行端拒绝用例均没有越权改盘。

首次运行 attempt-01 因 move 目标父目录缺失而失败，exit 1，原始输出保留；attempt-02 是补齐父目录后的早期目录 fixture 运行，未建立 Git worktree，不能替代最终 worktree 证据。attempt-03 是加入真实 Git worktree/move、主 Memory identity 和来源 checkout 前后校验后的最终作者运行。协调者另以同一 probe 文件 SHA **5a44150ab792c8e3c960d972f30ae4ae4175214e07e4864825ed68f13604cc96** 独立运行，exit 0；其 execution/stdout/stderr 与 probe-results 保存在同一 attempt 目录，作者未改写这些文件。

## 结论与限制

本试验支持把 ZCode 的子代理 persistent-memory 工具投影、scope 根解析和 memory Markdown 权限例外作为后续适配研究输入；它没有证明完整产品的 AgentRuntime、UI、安装包或会话记忆体验已通过。主 Memory 只验证 resolveProjectMemoryRoot helper，没有启动完整 runtime；子代理测试直接调 persistent-memory helper 和实际工具执行器，没有驱动模型或完整 agent dispatch；没有测试 MEMORY.md 索引内容的后续检索，也没有验证操作系统沙箱。所有实际文本均为 synthetic fixture，外部模型调用为 0，安装为 0。

主要源码定位：persistent-memory.ts 第 10–31 行是 agent scope root，第 39–62 行投影 Write/Edit，第 70–110 行加载；memory/project-root.ts 第 10–26 行以 workspaceIdentity 或 workspacePath 派生主 Memory 根；tool/executor/impl.ts 第 16–93 行构造并执行真实工具；tool/executor/permission-flow.ts 第 83–101 行计算权限并应用 memory 规则；tool/executor/memory-file-permission.ts 第 19–83 行限制目标及保留显式 deny；permission/service.ts 第 347–357 行处理显式 disallowedTools、第 433–441 行处理 Plan 写入拒绝；subagent/tool-policy.ts 第 4–21 行执行 child 工具过滤；adapters/src/fs/index.ts 第 115–116、486–489 行提供 Node 文件系统适配器。

回滚范围仅为本次新增的 spike 与 U08 attempt evidence；保留失败输出可供复核。没有全局配置、固定来源树、用户项目数据或外部状态需要回滚。本单元仍待独立审查，未标为 accepted。
