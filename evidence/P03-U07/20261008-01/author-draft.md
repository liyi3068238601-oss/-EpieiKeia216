# P03-U07：子任务最小知识包（作者草稿）

作者：`/root/p03_u06_io`。基线：`abc0bad7ed38b3f9ef442b2278e744d80bd03b3b`。作者状态：draft；独立审查与验收 pending。

实现已写入新文件 `packages/work/handoff-context.ts`。输入是宿主批准的 task-manifest 条目和显式 repo-relative 来源行范围；每项的适用 `paths` 与实际证据 `source_files` 分开，Read 白名单只可来自实际来源文件。项目 id 由 `ProjectRegistry.resolveWorkspace()` 的可信映射核对，基线取自实际 Git HEAD。原始 UTF-8 文件字节计算 SHA-256，受单文件/总计 1 MiB、摘录 32 KiB、packet 12 KiB 限制，并在采集前后复核映射、worktree、HEAD、文件身份与哈希。源码 hash 绑定来源字节，不代表独立验证其语义。

U04 reader 仅为明确选入的项目本地 topic 提供经验线索，authority 固定为 `experience-lead`。无记忆快照不生成 note；unreadable/corrupt 状态带原 U04 code 抛出。Native reviewer profile 关闭持久 memory、skills 和 MCP，只允许最终 provider projection 与 registry 均为 `Read`。可信 runtime factory 必须将 Native `FileSystemPort` 接到精确捕获快照；该组合边界不声称对任意自定义 handler 或 OS 文件系统提供通用 sandbox。结果写入单独 host sink，仅使用宿主授权的一个文件名，exclusive create、不覆盖并同步记录输出 SHA-256；audit 失败时文件保留、结果不算完成且不自动重试。

来源采用决定和固定 Native 引用见 `source-adoption.json`。ZCode 源为 Apache-2.0 固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；只读观察了其 memory 注入、runtime registry、Read handler 与 FileSystemPort，未复制代码或改动上游参考树。

作者本轮验证：在 `E:\Xiadie\Xiadie\.runtime\P03\worktrees\u07` 使用固定 Node `E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe` 执行 TypeScript `tsc --project tsconfig.json --noEmit`，exit code 0；`git diff --check` exit code 0。新增源文件为 LF 且以 LF 结尾。单元/真实 Native executor fixture、DSH mock、真实模型和桌面组合尚未在作者轮次执行；最终命令、输出摘要、source hash 与风险结论留待测试代理及主控正式复核补录。

此文件是未完成的作者结果草稿，不表示 `ready_for_review` 或 `accepted`。本任务未提交代码；没有触碰真实用户数据、生产 profile、key 或运行中的 DSH。

作者草稿源码快照：`packages/work/handoff-context.ts`，55,455 bytes，SHA-256 `cc39654d0eb8c17c815c3bd437eb9cfbb726cbc6d7868056be839787b37f9484`。若正式审查要求改动，此 hash 需随最终源码重新计算。
