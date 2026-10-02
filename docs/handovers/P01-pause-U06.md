# P01 在 U06 后暂停

已完成用户要求的完整暂停边界：P01-U01 至 U06 均已独立验收，U07 至 U11 实现未开始。P01 / G01 尚未验收，P02 未开始。

作者提交 `ef716c8a1ae4b0c67c9af9ea6d84fee809399d1a`；合入提交 `025cf2003498bfb94856913f2fa2712da03f3bc8`。本地分支 `p01-pause-u06` 固定最终交接、状态和证据清单。旧书签 `p01-pause-u05` 与其历史证据保留。

## 已完成与验证

- U06 将已批准的 v3 角色资产和 ContextPacket 接入固定版本 ZCode 原生 Hook；保留原生 Runtime / Loop、工具和项目规则。
- 模型调用前验证本轮 nonce、会话、回合、完整上下文及 Hook 回执；无效资产、Hook 超时、非零退出、坏 JSON、缺失或截断回执均阻断模型调用。失败摘要保留原始状态与哈希。
- 验证原生 marketplace 安装/禁用、空闲 sendInput 直到 completion 的生命周期、取消、持久化 resume、显式 compact 后的新回执和独立存储路径。
- 独立审查绑定上述作者提交；主目录 check / build 通过，U03–U06 单元 26、契约 5、集成 40 项通过，0 失败、0 跳过。审查记录见 `evidence/P01-U06/20261002-01/review-final.json`，验收见同目录 `acceptance.json`。
- 原始计划 ZIP 与 424 个计划文件逐字节一致；5 处固定源码检出保持干净，全部人设版本保留，原 Mofox 配置未改。核验见 `evidence/P01/checkpoints/U06/preservation.json`。
- U06 无新增真实模型请求，P01 累计仍为 4 次。当前默认 DeepSeek 官方 `deepseek-flash`，第二评测 ID 为 `deepseek-v4-pro`；两者后端独立性尚未确认。

## 验证范围与限制

U06 集成使用真实固定源码 bootstrap、已安装 Hook 子进程及 AiSdkModelAdapter，模型端连接系统分配 loopback 端口上的合成 HTTP mock。该结果不代表真实模型、Desktop、DSH、GUI/CLI 产品装配或 Windows 候选包已验收。当前仍没有完整产品启动入口；产品端口隔离须在后续装配复验。

启用扩展时，仅支持单个空闲输入、submitPrompt、resume 和显式 compact；队列/steer、子代理及绕过 UserPromptSubmit 的后台路径不受支持，缺回执时阻断模型。禁用扩展时直接委托原生行为。Core 尚不存在，Core 边界扫描为 NOT_RUN。路径预检不是进程沙箱；父进程 TEMP 与完整启动隔离仍须后续落实。上游接口是固定提交的私有集成接口。

## 恢复入口

1. 在 `E:/Xiadie/Xiadie` 先检查 `git status --short`、`git log -5 --oneline` 与 `p01-pause-u06`，读取当前状态和 U06 acceptance。保留作者、审查 worktree 与 `.runtime` 试验资料。
2. 可执行 `python -X utf8 evidence/P01/checkpoints/U06/reproduction/verify-checkpoint.py` 校验书签、磁盘及 Git 对象。它要求 HEAD 位于该暂停书签且工作区干净；恢复提交之后应针对历史书签查看记录，不要改旧清单。
3. 下一单元为 `planning/Xiadie_V2_v1.1/tasks/P01-U07.md`：把角色回复与工具状态分开，完成声明必须有原生执行证据，默认不增设人格改写模型调用。沿用 runtime.subscribeEvents、TurnResult 与 SessionProjection；历史 transcript 不能替代工具回执。
4. `read-only-preparation/` 已保存 U07、U08、U09 和 G01 调查。它们是历史只读设计资料，部分生成于 U06 最终 sendInput 支持之前，使用时须对照当前源码；不构成后续单元验收。
5. 后续按依赖推进 U07 → U08 → U09 → U10 → U11 / G01。模型授权保持既有范围：官方两模型、人设与合成只读资料、凭据仅内存；初始 18 次小样本请求已用 4 次，金额预算按用户“无上限”。恢复后若执行真实请求，先核对账本和当前路由。不得自动进入 P02 或正式发布。

## 工具链、端口与回滚

固定工具链 Node 24.14.0 / pnpm 10.33.2 / TypeScript 6.0.2 位于 `.runtime/P01/desktop-build-evidence/`；PATH 同时前置 bin 与 Node 目录。主目录精确 argv、cwd、时间、退出码、原始日志及 SHA-256 位于 `evidence/P01/checkpoints/U06/root-validation/`。

产品与试验均须使用独立数据根，服务绑定系统分配的 loopback 端口；桌面启动禁用固定 9229，不得停止或改动本机 ZCode 来腾端口。U06 未启动 Desktop/DSH 或新增付费请求。验证失败的历史日志与隔离资料全部保留。

仅回滚 U06 时，在新的开发提交中 revert 作者提交 `ef716c8a1ae4b0c67c9af9ea6d84fee809399d1a`，同步修正执行状态；不覆盖已验收前置、人设版本、计划、生产配置或历史检查点。本次没有远程推送、正式发布或数据迁移。
