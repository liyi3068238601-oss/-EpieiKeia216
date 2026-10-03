# P02-U01 SQLite 候选调查

**状态：** `ready_for_review`（仅研究；U02 PoC 未运行）
**核查日期：** 2026-10-03（Asia/Shanghai）
**固定环境：** Node v24.14.0，pnpm 10.33.2；不升级、不安装依赖、不创建数据库、不改产品源码或生产 DB。

## 候选结论

U02 的首选 PoC 对象为固定 Node v24.14.0 自带的 `node:sqlite`：用 `DatabaseSync` 实现事实写入/迁移，以 `sqlite.backup()` 做在线快照。固定二进制的无库探针确认 `DatabaseSync` 和 `backup` 均导出，SQLite 3.51.2、Node module ABI 137、N-API 10；命令退出码 0。Node v24.14.0 于 2026-02-24 发布；相关 SQLite defensive-default 改动可追到 Node commit `c0ceb9b065`。它不需要新增 npm 包、安装脚本或第三方原生模块，和当前固定运行时/类型声明直接匹配。Node 内置 API 随 Node.js MIT 发行，SQLite 引擎标为 public domain；这不是新增包。这个结论是“进入 U02 验证”，不是“已通过验收/最终采用”：v24.14.0 文档把 SQLite 标为 Stability 1.1 Active development，运行时还发出 experimental 警告。版本需严格区分：截至本次核查，v24 最新维护版为 24.21.0，Node 最新主线为 26.10.0；当前 v24 文档记录 SQLite 从 v24.15.0 起为 RC，而 v26.8.1 文档记录自 v25.7 起为 RC。这些后续状态不回溯改变固定 v24.14.0 的稳定性。v26.10.0 对应 SQLite 文档页未能访问，来源索引记录了限制。

不采用 `better-sqlite3` 作为本轮候选实现：固定 ZCode 源码实际用的是 `node:sqlite`，Xiadie 当前依赖与 `node_modules` 没有 `better-sqlite3`；新增依赖也被本单元禁止。它的事务回调和 `.backup()` API 可作为对照（本次核查最近 tag 为 v13.0.3（release commit `dbc2ea1`，MIT，engine `>=22`，依赖 `node-addon-api ^8.0.0`，N-API 10），但 N-API 原生绑定会增加包、安装/预编译二进制与 Windows fallback 构建面，不能以“npm 成熟”替代本项目适配证据。我们没有安装或运行它。U02 若发现原生 API 无法满足验收，先记录失败证据，再走依赖选择/授权流程。

本地 ZCode 的迁移器只适合**借鉴实现模式/薄适配设计**，不是可直接复用的组件：其 `DatabaseSync` 启动迁移、WAL、`BEGIN IMMEDIATE`、schema migration checksum、busy 锁重试与事务回滚很接近目标；但它绑定 ZCode Session schema、共享类型/错误封装，且没有发现迁移前快照。它也未拒绝账本中比自身已知迁移更高的 future schema。事件唯一键方面，现有 `session_entry.id` PK + `ON CONFLICT(id) DO UPDATE` 会覆盖已有事实字段，不等同于要求的来源事件幂等键，也没有同一来源身份但 payload 不同则拒写的证据。因此不可将其账本、事务或主键描述成已满足 P02-U05/U08。

## 证据与设计差额

- **事实身份：** ZCode 表使用本地 entry ID；仓储冲突分支更新 `session_id/type/time/data`。P02-U05 需要能表达 `(source/runtime, source_event_id)` 的唯一身份，重复且同内容为 no-op，同身份异内容明确冲突并保持原行；来源日志是权威数据，规范化投影另用 origin 映射。以上是待设计/验证要求，不是 ZCode 已有保证。
- **原子性：** ZCode 在迁移和部分仓储路径使用显式 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`。U02 应证明事实原始记录、规范化事件、派生引用放在同一事务，进程中断不会出现部分写入；不同事务间再谈“最终一致”不足以满足单次保存语义。`BEGIN IMMEDIATE` 仍可能因竞争写者报 `SQLITE_BUSY`，只能有界等待后失败，不能误报已保存。
- **future-schema 拒写：** ZCode 的预检只遍历当前代码已知迁移并校验这些迁移的 checksum；没有检查“数据库最大已应用版本 > 当前支持版本”。此外它在迁移账本预检前会启用 WAL。新实现应先做只读版本/账本预检，future schema 时在任何 WAL/DDL/业务写入之前 fail closed，并验证文件字节与逻辑状态均不变。
- **WAL 一致性快照：** SQLite 官方 online backup API 复制一致快照；不能在 WAL 活跃时只拷贝主 `.db`，因为已提交页面可能仍在 `-wal`。Node `backup()` 是异步 Promise API；源连接应保持打开。外部写连接在备份期间写入可能使备份重启，持续写入时可能迟迟无法完成。备份目标应是唯一临时文件，完成后检查完整性/清单再晋升；不可直接覆盖唯一好备份。`-shm` 是协调结构，也不能把“复制几个文件”当作通用快照协议。
- **故障恢复：** 需要先成功生成、校验并登记迁移前备份，再进行迁移；备份目标拒写、磁盘满、SQLITE_BUSY 超时、备份 Promise 拒绝或校验失败时不得开始迁移。迁移中断后必须能在新的数据根从已验证快照恢复，核对 schema/关键行/hash。SQLite 的事务回滚不替代迁移前备份。
- **权限与 Windows：** 固定 Node 内置 SQLite 没有额外 Node addon ABI 或 Python/node-gyp 安装步骤；文件系统账户仍须能在数据目录创建/写入 DB、WAL/SHM、临时备份并执行同卷原子重命名。SQLite 没有应用角色级 DB 权限机制。本轮只读查看，不改变 ACL。`better-sqlite3` v13.0.3 声明 N-API 10、提供 Windows x64/arm64 prebuild 路径，但 fallback 仍有 native build 工具链要求；其安装在此环境/包管理器中的结果未验证。

## U02 故障矩阵（本轮全部 `NOT_RUN`）

| 场景 | U02 操作 | 通过证据 / 失败应有行为 |
|---|---|---|
| 同一来源事件、相同 payload 重放 | 两次写同 `(source_id, source_event_id, payload_hash)` | 仅一条事实/一组引用，第二次 no-op；计数及行 hash 稳定 |
| 同一来源事件、不同 payload | 重放 identity 相同、hash 不同 | 明确 conflict；原事实/引用不变，无“最后写入获胜” |
| 单次写入进程中断 | 在原始来源、规范化事件、派生引用之间注入终止 | 恢复后全有或全无；任何未提交写不宣称成功 |
| 未来 schema | 构造版本高于程序支持值的测试 fixture 后打开旧程序 | 在 WAL/DDL/写之前拒绝；错误可识别；DB 与 sidecar 哈希/状态不变 |
| 活跃 WAL 快照 | 已提交变更留在 WAL 时调用 `backup()`，另含未提交事务 | 备份包含已提交数据且不含未提交数据；`integrity_check` 通过；恢复行/hash 正确 |
| 备份期间竞争写者 | 外部写入源库，观察 backup progress/restarts | 有界完成或超时失败；避免无限忙等；迁移必须等 snapshot 成功 |
| 备份路径/容量/ACL 故障 | 目标不可写、磁盘满、目标重名/已有有效快照 | 不覆盖好备份；失败不启动迁移；临时残件可识别并安全清理 |
| 迁移中断与回滚恢复 | 在 DDL/ledger 写/提交附近注入失败并重启 | 事务状态无半迁移；用迁移前快照恢复后 schema、关键行和哈希一致 |
| 锁竞争 | 另一个连接持有写锁/读者妨碍检查点 | 仅对 `SQLITE_BUSY` 有界退避；达到上限明确失败，不留下伪成功/重复事件 |
| Windows 权限/路径 | 只在 U02 临时数据根验证正常和拒写目录 | 读写与原子晋升边界可解释；拒权错误可观察，原 DB/有效快照保全 |

**本轮未验证：** 没有实例化 SQLite 数据库、运行迁移、注入故障、安装/编译 `better-sqlite3`、执行产品测试、测 Windows ACL/杀进程恢复或验证 backup Promise 的具体 WAL 边界。应把这些全留给 U02 临时测试根。

## 本地核查范围

项目规范要求的 U01/U05/U08 任务卡与代码复用清单已读。ZCode 只读基线为 `references/zcode-29628c9`，HEAD `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，2026-09-24，`feat: update v3.14.3`，许可证 Apache-2.0。读取了应用/adapter package 元数据、SQLite store、migration runner、SQL migrations、session entry/input repositories、LICENSE/NOTICE；路径与 SHA-256 在同目录 `local-sha256.txt`。限定 package 源码未发现 `better-sqlite3` 声明/引用或 SQLite 安装钩子；适配器 package 未找到 SQLite 专用测试文件。此结论限定于所列固定 checkout 和包路径，不代表整个上游仓库所有模块都没有测试。

Xiadie 当前 package manager 为 pnpm 10.33.2，engine Node 24.14.x；锁文件没有本次新增依赖。本轮未运行 pnpm/Corepack、未联网服务、未使用模型调用。固定 Node 探针只加载 `node:sqlite` 并输出导出/版本信息，没有创建 DB。
