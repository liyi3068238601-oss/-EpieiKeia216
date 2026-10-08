# U02 文件服务与项目拓扑子试验

2026-10-08，基线 `c691a5b7a975ac4420f880c8233c7b0bb7893958`。此子试验等待 U02 总作者整合和独立审查，不能单独代表 U02/G03 通过。

固定 Native `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的 MemoryService、project-root 和 index-content 源通过既有 esbuild 0.27.7 编译到独立输出；没有更改上游或安装依赖。实际执行 Node v24.14.0。源码编译输入、执行脚本和 bundle 的完整 SHA-256 见 `run-02/summary.json`，命令/cwd/exit/输出见 `run-02-command.json`、`run-02/commands.json`。ACL 原始输出用 Base64 和 SHA-256 保留，同时提供 GB18030 解码文本。

结果：14 项真实原生文件服务断言全部通过。包括 A/B 同名文件隔离、frontmatter 原样读取、catalog、缺失、相对/绝对逃逸、大小写别名、5 MiB 限制、真实文件 ACL 拒绝及恢复、更新后重新读取、junction 拒绝、索引超限警告。坏 UTF-8 被替换、坏 frontmatter 被原样返回是经过实测的契约差额；相应断言通过只证明观察成立，不表示服务满足 U04 四态要求。

真实 Git 自有 fixture 包含两个同名仓库、A 的两个 linked worktree 和一份目录副本。已验证 common-dir/private-dir 区别、同盘 `git worktree move`、从 E 盘复制到 C 盘后哈希一致并 `git worktree repair`；跨盘原副本保留为档案，登记的活动 worktree 指向新位置。换路径的 legacy Native key 会改变，显式同一 UUID 投影在各路径一致，但与旧 legacy key 不同。输出中的 UUID/mapping 是试验参数，不是已实现的持久项目注册表。

记录日期为三年前的合成主题与当前 schema 源文件冲突。服务保留旧主题原始字节；试验前后记忆树哈希一致。此处未测模型事实判断或产品新鲜度策略，这部分由 Native 子试验和 U05/U08 验证。未读任何生产记忆或凭据；真实模型、DSH、Desktop 均 NOT_RUN。没有网络服务或端口占用。

`run-01-command.json` 是日志完善前的成功试跑；最终结论绑定 `run-02`，该次补充了文件服务子进程身份及 ACL 原始输出。所有试验目录保留；任何回滚仅撤本子试验提交，不能删除或移动用户项目。临时 ACL 在 finally 中恢复，并实际重读成功。最终 Native checkout 仍 clean。

复跑：用固定 Node 运行 `spikes/P03/topology-service.mjs --output <E:/Xiadie/Xiadie/.runtime/P03/experiments/下全新绝对目录>`。不支持覆盖旧 attempt。跨盘目标由系统 Temp 中新建的 `xiadie-p03-u02-owned-*` 目录承接，位置写入结果。该脚本仅适用于本机 Windows 隔离验收环境。
