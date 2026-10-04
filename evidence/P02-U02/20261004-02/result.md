# P02-U02 mature SQLite binding spike

作者状态：`ready_for_review`。本 attempt 的固定基线是 `4163f5c5d1df93878bbfd2ecd85ab98cf9e919e2`；协调器 attempt 为 `20261004-02`。正确的实际入口是 `spikes/P02/mature-sqlite/mature-sqlite-spike.mjs`，baseline 的 `test_mapping` 已修正为该路径。

## 决定

为 P02-U05 规范化事件库采用 `better-sqlite3@13.0.3`，源 tag 的上游提交为 `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb`，许可证 MIT，`engines.node >=22`，N-API 要求 10。固定 Node `v24.14.0` / N-API 10 / Windows x64 实际加载 npm 包内 `prebuilds/win32-x64.node`，SHA-256 为 `e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a`。通过该 binding 的实际 SQL `SELECT sqlite_version()` 探测，better-sqlite3 内置 SQLite 为 `3.53.4`；`process.versions.sqlite` 单独记为 Node 内置 SQLite `3.51.2`。安装使用 `pnpm@10.33.2 install --ignore-scripts`，exit 0；包没有 install script。

这个决定只覆盖 normalized event store。Node 24.14.0 自带 `node:sqlite` 的文档将 API 标为 Stability 1.1（实验性）；它不再是事件库当前推荐。备份模块是否继续使用独立 Node SQLite 连接，留待主控结合 U05 prototype 和本次跨绑定数据验证另行决定。当前 spike 没有改动事件库产品源码、worker 或 backup 模块。

## 实测

最终脚本运行共 9 项、9 项通过。权威脚本输出是 `spike-result-run-05-final.json`（SHA-256 `1ab3ecdbcdefca6de2bbffaa52e8a69bda10a95062feca761fd9039c8f393469`）；`spike-result-final.json` 是前一次 9/9 预验证结果。原生 Node Runtime 16 项证据是旧 U02 的历史实测，本 attempt 未重跑。

| 检查 | 结果 |
|---|---|
| Windows x64 N-API 预编译 addon 确实加载 | 通过；版本、运行时、addon 路径和 addon SHA 均记录 |
| source+event ID 唯一、精确重放、同 ID 异载荷冲突 | 通过；唯一键为 `(source,event_id)`；重放不新增行，冲突保留原事实 |
| 事务提交前强杀 / 提交后强杀 | 通过；事件、origin、receipt 三表分别全无 / 全有，恢复后 `integrity_check=ok` |
| 有已提交 WAL 时在线备份与恢复 | 通过；48 行在 live WAL 中，在线备份完成，SHA-256 数据摘要一致，恢复副本由 Node `node:sqlite` 检查为 `ok` |
| 竞争写入 | 通过；持有 `BEGIN IMMEDIATE` 时竞争者收到 `SQLITE_BUSY`，配置 60 ms 超时，观测 118 ms，且小于 1000 ms 观测上限；释放后写入成功 |
| 只读打开和拒写 | 通过；读取成功，写入报 `SQLITE_READONLY`，原行数不变 |
| 实际 Node v1 产品账本双向读写和 Node backup | 通过；从实际 synthetic `event-ledger.sqlite` 连同当时存在的 WAL/SHM（本次均不存在）复制到 owned scratch；Node 只读打开 scratch 并以 SQLite backup 制作副本；better 读取原 schema 并写入后由 Node 读取；Node backup 该库后 better 再读取；Node 写入后 better 再读取；原账本 DB/WAL/SHM 前后字节状态相同 |
| 64 位整数精度负例 | 通过；`9007199254740993` 默认读成 `9007199254740992` 且无精确数值；`defaultSafeIntegers(true)` 读为精确 BigInt。适配层必须先做类型与范围检查，超出安全范围的 counter/static metadata 一律拒绝，不能作为安全 number 暴露 |

安装包完整文件树、`package.json`、pnpm lock、安装 metadata 和预编译 addon 的运行前/后摘要一致。better-sqlite3 包完整文件树 SHA-256 为 `dbd29487bbb8240a462174e84c2f90f4957aae33effcd64e6ce64a6a9569c4bd`；pnpm package integrity 为 `sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==`。实际 Node 账本原件 SHA-256 前后相同：`7b5960a4ba289203b36694368f675a642d5c28062b969f2a9ce4a7b9190aa8c2`。

## 上游研究

读取了 better-sqlite3 tag `v13.0.3` 固定提交 `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb` 的 `lib/database.js`、`lib/methods/backup.js`、`lib/methods/transaction.js` 与关联测试 `test/10.database.open.js`、`test/30.database.transaction.js`、`test/36.database.backup.js`、`test/40.bigints.js`。这些源码分别覆盖只读/打开行为、事务和 savepoint、online backup、默认 number 与 safe BigInt 行为。本 spike 读取上游测试用于定向设计，未安装上游开发依赖，也未声称运行上游完整 test suite。锁定源文件与 SHA 列于 `.runtime/P02/experiments/mature-sqlite-spike/research/index.json`。

## 命令和保留的失败记录

最终实测命令由 `E:\Xiadie\Xiadie\.runtime\P02\coord\run-command.py` 执行；cwd 均为 `E:\Xiadie\Xiadie\.runtime\P02\worktrees\mature-sqlite-spike`，固定可执行文件为 `E:\Xiadie\Xiadie\.runtime\P01\desktop-build-evidence\toolchain\node-v24.14.0-win-x64\node.exe`。具体 argv、UTC 时间、stdout/stderr、exit code 都保存在以下原始记录中：

| 记录 | Exit | SHA-256 | 含义 |
|---|---:|---|---|
| `.runtime/P02/experiments/mature-sqlite-spike/01-install.json` | 0 | `8655ec58e0d8231061c62583e467fd68eeed54738270bc3be8e3a4b0579b08e5` | 固定 Node/pnpm 下 `--ignore-scripts` 安装 |
| `.runtime/P02/commands/mature-sqlite/20261004-02-check-01.json` | 0 | `6189e55b30011e8c05b975dbe4ffbe761d4888f1048789bf8b10390a211353df` | 固定 Node 对 spike 脚本执行 `--check` |
| `.runtime/P02/commands/mature-sqlite/20261004-02-run-01.json` | 1 | `65c6b0201cd050388a64aac457497912ba240a1ef673c3bf2fb374d6c7a766a1` | 首轮发现 Windows `\\?\` 长路径比较问题；已修复并保留失败输出 |
| `.runtime/P02/commands/mature-sqlite/20261004-02-run-02.json` | 1 | `72c5290b6a9a1cc126609e63c332b0e05b9742f65156b39b3e870a8dd2940aca` | 首轮跨绑定误选简化 PoC DB，缺少实际 `event_observations` 表；失败输出保留。只读探测在该旧 PoC 文件旁生成了运行前不存在的零字节 WAL 与 SHM；仅对这两个本次新建文件做精确清理并核验主库 hash 不变，清理细节见 `sidecar-cleanup.json` 与下方 cleanup command record |
| `.runtime/P02/commands/mature-sqlite/20261004-02-cleanup-sidecars.json` | 0 | `986f7e5a69d0e8846349ecc6e12f3439a972704c3467e3be0d17bdc88c681aad` | 仅删除前述两个按 before/after hash 核实的本次 sidecars |
| `.runtime/P02/commands/mature-sqlite/20261004-02-run-03.json` | 0 | `1ffd3a6a46ac850155b95e7c575268159498c9ab3160c1207a3b1c82f3f05400` | 改用真实 synthetic 产品账本后 9/9 通过；预验证 |
| `.runtime/P02/commands/mature-sqlite/20261004-02-run-04-final.json` | 0 | `c6681cce1bd9387607cbeb5a70524c9c7f118df75cd1b33b7ef3ed77e7277354` | 加入 reviewer 独立输出根和竞争写等待上限断言后的实测；9/9 通过 |
| `.runtime/P02/commands/mature-sqlite/20261004-02-run-05-final.json` | 0 | `42c5583ddd0b66a4e0195a7e1957405d9625addbf6895f35afaf60e5b67af1fd` | 最终脚本，增加 better addon 实际 SQLite 版本探测，并区分 Node 内置 SQLite 版本；9/9 通过 |

协调器基线由 `.runtime/P02/coord/baseline-unit.py` 按 attempt `20261004-02` 创建，baseline commit 固定为 `4163f5c5d1df93878bbfd2ecd85ab98cf9e919e2`。初次传入的 test mapping 名称拼错为不存在的 `.test.cjs`；第一次启动在 native-load 路径断言处失败后发现此映射问题，并在完整场景矩阵运行前修正 baseline 唯一的 `test_mapping` 字段为现存 `.mjs` 入口，其余基线绑定不变。baseline 本身和最终 JSON 结果均纳入本 attempt evidence。

## 局限和后续边界

强杀是结束 owned worker，不等同于物理断电或存储介质故障；`SQLITE_BUSY` 延迟受 Windows 调度影响。本数据全为合成资料，无模型、生产事件、外部服务、桌面或安装包构建调用。Native Runtime 16 项旧结果只作为历史依据，未在新 attempt 复跑。U05 需要将事件写入路径适配到更成熟绑定，并把故障注入目标从 Node `DatabaseSync` prototype 调整为 better-sqlite3 实际构造器/实例；计数器与静态元数据须加入整数安全适配。backup binding 维持待决。

回滚只撤销本单元提交；产品代码和计划状态都未改变。本文件只给出作者建议，等待独立审查；不得据此自动接受 U02 或提前放行依赖。
