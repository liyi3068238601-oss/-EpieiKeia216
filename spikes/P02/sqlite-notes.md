# P02-U02 SQLite 隔离 PoC（仅 spike）

**交接状态：** `ready_for_review`。前置 P02-U01 已 accepted。基线 worktree `E:\Xiadie\Xiadie\.runtime\P02\worktrees\u02`，branch `p02-u02`，HEAD `e809d5c7e9969cbf2f5efd68df326e115cf6f1e6`。使用固定 Node `v24.14.0` / SQLite `3.51.2`，不运行 pnpm、不安装依赖、不访问网络或模型、不打开产品数据库；所有合成 DB/输出位于 `E:\Xiadie\Xiadie\.runtime\P02\experiments\u02\sqlite\`。只编写本目录允许的 `sqlite-poc.mjs`、`sqlite-worker.mjs`、本说明；未提交。

## 候选结论

建议 P02 后续存储默认继续用固定 Node 内置 `node:sqlite`：`DatabaseSync` 写入/迁移 + `sqlite.backup()` 快照，不增依赖。PoC 证明 API 在锁定 runtime 上可用，并在本地临时库上覆盖了本轮必要语义。它仍按 Node v24.14 文档的 Stability 1.1 Active development 处理；程序启动 stderr 有 `ExperimentalWarning`。本结论可作为 U05/U08 实现候选，不能替代产品层验证。

策略边界：借鉴固定 ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的 `BEGIN IMMEDIATE`、WAL、迁移账本/checksum、有界 BUSY 重试/回滚设计；不复制 Session schema/仓储。事件唯一键、canonical hash 冲突拒绝、event/origin/receipt 同事务必须按 Xiadie 的事件契约实现。future schema 需要独立只读预检；migration runner 本身不提供该拒写，也不做预迁移备份。在线快照验证后用同卷硬链接 no-clobber 发布；如果目标文件系统不支持同卷硬链接，应 fail closed 并设计可证明的原子无覆盖替代。固定 Node 24.14 API 参考：[node:sqlite](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html)；存储语义参考：[SQLite online backup](https://www.sqlite.org/backup.html)、[WAL](https://www.sqlite.org/wal.html)、[transactions](https://www.sqlite.org/lang_transaction.html)。ZCode 固定来源：[29628c9 session store](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/session-store)。

## 10 个实际场景

| 场景 | 结果与关键观察 |
|---|---|
| WAL、foreign keys、synchronous、busy | `journal_mode=wal`、`foreign_keys=1`、`synchronous=2 (FULL)`、`busy_timeout=0`；孤儿 origin 拒绝，SQLite errcode 787。 |
| Canonical identity / 重放 | 同 `(source_id, source_event_id)` 且 key-order 不同但 canonical hash 相同，重放为 duplicate/no-op，三表各 1 行；同 identity 异 hash 返回 conflict，行数和逻辑 SHA 不变。 |
| 事务内强杀 | 自己 spawn 的 worker 写 event/origin/receipt 并停在未提交事务；父进程只对其 PID 请求 `SIGKILL`。子进程退出后重开库，三表均 0 行、integrity `ok`。 |
| Commit 后、ACK 前强杀 | worker commit 后发送阶段消息，父进程在应用 ACK 前杀子进程。恢复后 receipt 存在；同事件重试得到 duplicate，仍只有一条事实和回执。 |
| 外部 effect 后、receipt 前强杀 | 仅用本地合成 JSON 文件模拟 effect；杀进程后 receipt 缺失且 effect marker 存在，恢复结果为 `unknown-effect-may-have-happened`，动作是人工核对，不自动重放。不是外部服务实测。 |
| 真实 SQLite BUSY / FULL / READONLY | 两连接竞争 `BEGIN IMMEDIATE` 得 SQLITE_BUSY errcode 5；180ms 上限实测等待 181ms 后失败，释放锁后立即可获锁。`max_page_count=3` 触发 SQLITE_FULL errcode 13，事务回滚；未填满物理磁盘。`DatabaseSync({readOnly:true})` 写入被 SQLITE_READONLY errcode 8 拒绝；未改 Windows ACL。 |
| 活跃 WAL online backup | 备份时 WAL 为 28,872 bytes；另一连接持有未提交 event。`backup()` 8 页、进度回调 7 次。新快照和 fresh restore 都只含已提交的 event/origin/receipt，逻辑 SHA 相同，integrity `ok`。 |
| 仅复制主 DB 负面对照 | 在 WAL 尚有已提交行时只复制 `.sqlite` 主文件；副本完整性仍为 `ok`，但事件行数为 0，说明 integrity check 不会证明主文件包含 WAL 中已提交内容。 |
| 迁移前备份 / 成功迁移 / fresh restore | 只读预检 schema v1 后先生成 online backup，再开始 WAL/事务迁移到 v2。备份和 fresh restore 保持 v1，关键行 SHA 与迁移前一致；源库为 v2。目标发布实际使用同卷 hard-link no-clobber。 |
| 迁移失败 / 回滚 / 恢复 | 在 ALTER 与新增行之后注入重复主键，得到真实 SQLITE_CONSTRAINT_PRIMARYKEY errcode 1555；事务回滚，源库仍 v1 且没有新增列。迁移前快照恢复到新文件后行 SHA 一致，integrity `ok`。 |
| 备份目标保护 / backup 失败 / future schema | 已存在目标 sentinel SHA 前后相同，迁移未开始；无效目标父级为普通文件，真实 backup API 返回 CANTOPEN errcode 14，迁移未开始。schema v99 通过只读预检拒绝；源 `.sqlite` SHA 与 sidecar 清单前后不变，无 WAL/DDL/备份。 |

三个进程杀测试 worker PID 为 25060、44972、43896；运行后 `Get-Process` 均查不到。代码用 `spawn` 直启固定 Node、不经 shell；只向自己创建的 child PID 发信号。child stage 等待、worker 命令等待及退出等待都有时限；未使用 `taskkill`、未对外部 PID 操作。

## 命令与结果记录

每次 PoC 均执行：

```text
Process argv: E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe E:\Xiadie\Xiadie\.runtime\P02\worktrees\u02\spikes\P02\sqlite-poc.mjs
PowerShell capture: & $node $script 1> $stdout 2> $stderr
```

cwd：`E:\Xiadie\Xiadie\.runtime\P02\worktrees\u02`。探针和 `node --check` 记录也在 experiments 输出目录。尝试历史（不覆盖失败证据）：

| command record | exit / 场景 | stdout / stderr 文件 | stdout SHA-256 | stderr SHA-256 | summary SHA-256 |
|---|---:|---|---|---|
| `run-20261003-131653.command.json` | 1 / 8 pass、2 fail | `run-20261003-131653.stdout.log` / `run-20261003-131653.stderr.log` | `8b55b41a25a95ac9f6b3a6c806d7552fc007cce3b765c46bc473cae90ef3914c` | `8e8e53e8c24c3b71604df4cbc32dbadad71355b6b64cd33904f0ec5bf6ba0dd6` | `425dd61f56315197dbd77104e99e890c64e2b3d92e315ae948ba9f36b0f48a67` |
| `run-20261003-131736.command.json` | 0 / 10 pass、0 fail | `run-20261003-131736.stdout.log` / `run-20261003-131736.stderr.log` | `ae08e750f6e813db41e49f54d3478b71e7ba91ac9796f4c1c4f58d20906e1ee2` | `76f8a474b7f59536ac2e61122be84afeee45d67cd216c17cc96e3633cba91f40` | `9bbd24cbe4a5fbddd8d92d2d6429e5285cca38e809d0a815add0ccaa3a79938b` |
| `run-20261003-131848.command.json`（最终代码） | **0 / 10 pass、0 fail** | `run-20261003-131848.stdout.log` / `run-20261003-131848.stderr.log` | `1dcfb7472b1d791c1169d940830d89dd83b1e62edbc7ca59237ec7ae19e549a2` | `3d83c1533eb77fe3ed746a496701e050cb5bf087820f556b2f437b0f4e8aba64` | `ece18c7bbfba3ccf8962413082e643d5fc4f8e1cbc8ee86e3d1909e5ece1573d` |

首轮两个失败均是 PoC 夹具错误而非 SQLite API 故障：`ALTER TABLE` 增列后仍使用两值无列名 INSERT，先报“table legacy has 3 columns but 2 values were supplied”，没走到预期约束分支。将两条迁移插入改为显式 `(id,payload)` 后两次完整重跑均 10/10 通过。完整命令 JSON、每次 stdout/stderr、各自 summary、runtime capability probe、语法检查日志均保留于 experiments 目录。最终运行 stderr 含预期 SQLite `ExperimentalWarning`。

输出目录完整文件 SHA 清单：`E:\Xiadie\Xiadie\.runtime\P02\experiments\u02\sqlite\file-manifest.sha256`，136 项；清单文件 SHA-256 `a8ccb13121d381093531615c1d13b39afccdae7f0df6dbbc0c1557f49dc9d93a`。最终 summary：`E:\Xiadie\Xiadie\.runtime\P02\experiments\u02\sqlite\run-2026-10-03T051848-688Z-b138f547\summary.json`。最终命令记录中有 cwd、exit、stdout/stderr 文件与 SHA、summary 路径；`verification-record.json` 保存 runtime 探针与语法检查命令记录。

## 版本/源码 SHA-256

| 文件 | SHA-256 |
|---|---|
| 固定 Node v24.14.0 `node.exe` | `63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088` |
| worktree `AGENTS.md` | `b6ab92bf4c41d1cbc44fede9c152614b38bc24e5de8c293a55db258735ef53f4` |
| `planning/Xiadie_V2_v1.1/tasks/P02-U02.md` | `6bdf8ad7f6d7ed5d6d1aa56e3b400f6120ab2d64d06fc1a8e13705aefe4e53d0` |
| `docs/research/P02/sqlite-reuse.md` | `82ccfcfb3f65b4edcd062a2cc04ddb1498d3458ec5d6fb11636f5a137400a4b6` |
| `spikes/P02/sqlite-poc.mjs`（最终） | `8b9b7ad5b192840c62733435d8464cee9215a62957d5fff824c320a230276241` |
| `spikes/P02/sqlite-worker.mjs` | `76e96b42f72960fc1c991f3171ca36fd7001f05012289faa9f77e3475007dccf` |

PoC 输入记录固定版本与摘要：Node v24.14.0 / SQLite 3.51.2 / module ABI 137 / N-API 10。Node 无库探针 exit 0，输出中确认 `DatabaseSync` 和 `backup` 均为 function；`sqlite-poc.mjs`、`sqlite-worker.mjs` 最终 `node --check` 均 exit 0。未运行升级脚本、pnpm、安装器或产品测试。

## 未覆盖边界

- `SIGKILL` 是真实子进程中断，不是 Windows 重启、断电、磁盘控制器缓存丢失或硬件故障；`synchronous=FULL` 选项已核对，但物理断电持久性为 `NOT_RUN`。
- 文件 effect 为本地 mock 文件，不代表模型、网络 API、支付/外部系统等真实副作用；恢复策略显式 unknown，不自动重放。
- `SQLITE_FULL` 用 SQLite `max_page_count` 受控复现，没有物理填盘；READONLY 用 SQLite `readOnly:true`，Windows NTFS ACL 拒权路径 `NOT_RUN`。
- WAL 备份测试为小型库、稳定的单个未提交写连接；持续外部写者使 backup 重启/饥饿、并发迁移竞态、超大库、备份清单签名/保留策略 `NOT_RUN`。future-schema fixture 使用 `PRAGMA user_version` 作版本源；若产品最终采用 migration ledger ID，应在只读预检中同时校验最大已应用 ID，当前 PoC 未覆盖这种 ledger 形态。
- 本脚本是独立 schema/薄适配 spike，不能作为产品存储组件或 U05/U08 的通过证据；它不验证 event PoC 的 source sequence=0 规范化、writer commit sequence、operation_id、terminal/attempt 规则。实际 schema 生命周期、源 runtime event cursor、迁移版本/ledger、备份保留和 OS 文件权限仍由后续实现/验收定契约。Node v24.14.0 的 experimental warning 仍是固定环境限制。

并行 author worktree 中 `evidence/P02-U02/`、`docs/adr/P02-reuse.md` 与 events/runtime/native spike 文件属于主控或其他作者的独立 scope；本 agent 未编辑这些文件。SQLite agent 只写本文件、`sqlite-poc.mjs`、`sqlite-worker.mjs`。未运行 git add/commit。