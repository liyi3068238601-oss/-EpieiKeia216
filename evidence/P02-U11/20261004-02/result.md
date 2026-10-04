# P02-U11 作者结果

作者状态 **ready_for_review**；`accepted:false`、`G02=pending_independent_acceptance`。Baseline `b95cfd2be02959dd8c390e2b141d24d1093daf81`，attempt `20261004-02`，worktree `E:\Xiadie\Xiadie\.runtime\P02\worktrees\mature-freeze`。U10 前置已接受；独立输入审计确认 10 项前置接受、423 项计划文件且 `plan_mismatches=[]`。author-tree scope 是 `docs/releases/0.2.0/` 与 `evidence/P02-U11/20261004-02/`。

## 结果

* 候选09材料复用检查：descriptor `6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74`，material commit `cd03ddc3a3f6f7ca67b4313e309db20db4755343`，source pin `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；103/103 材料输入同时匹配 candidate descriptor 与 baseline Git blobs，0 mismatch。候选闭包 6,717 项。
* fresh actual Desktop 候选：full 6/6、degradation 3/3，候选闭包在每个场景前后及每 suite 后保持 descriptor SHA 一致。两套合计 11 个合成 loopback 模型请求；真实外部模型请求/凭据/付费调用为 0，`DSH_started=false`。
* P02 实际运行时 binding：Better `13.0.3` / SQLite `3.53.4`；Windows addon `e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a` 位于候选 CLI 自有 `apps/zcode-cli/packages/cli/dist/node_modules/better-sqlite3/prebuilds/win32-x64.node`。Desktop summary 声明 Electron `41.0.3` executable 以 `ELECTRON_RUN_AS_NODE=1` 运行 app-server，CLI PID 与 `process.dlopen` addon sidecar 关联。Node `24.14.0` 用于 build/helpers/independent reader，不是 CLI SQLite 实际加载证据。
* `disabled_native` 的 durable wrapper/probe 是 `not_instantiated`、ledger admission 为 `ledger_absent_not_admitted_allowed`、admitted facts 为 0；其两次请求是 Native fallback loopback 请求，不是 P02 ledger facts。其余场景的 binding 都是 `verified_actual_cli_load`。U11 不将独立 reader 的旧 “fixed Node CLI” qualification 文案当作 runtime identity；原报告完整保留，权威 CLI 身份证据为 Desktop runner、进程 PID 链和 addon probe。
* `success` SQLite backup 与新根恢复的 DB SHA 相同 `511fc9597f58ccb1be8cfb8ac04aa37b6148305bad1749e7a2bf3ae9c61c9db5`；独立 reader 的 raw ledger report显示 integrity/fk 检查为 ok，facts/observations/origins/receipts hashes 一致。生产/执行 hash snapshots 两套 before/after 相等；九个选定注册表键快照也各自相等。guard 只是 main-process instrumentation，不是 OS sandbox。
* UI actions 没有命中 `observed-api-key-onboarding-transition`；candidate09 未触发新的 onboarding-timeout fallback 分支。

## 必需附件与命令

旧 release README/freeze 从 `ead4b6bff78250ae9a538819062fd7cb00bd4113` 的 Git raw blobs 保存并 byte-identical 校验。`candidate-proof-index.json` 列出 139 个候选/命令/运行报告文件；`runtime-raw-candidate09/index.json` 列出 42 个 main runtime、guard、CLI alias、PID-bound addon probe 和 registry sidecar，所有拷贝字节均复核一致。完整命令参数、cwd、exit、stdout/stderr 在 `command-index.json` 指向的逐命令 JSON 内；该 generator 外层命令记录在 `commands/17-write-release-proof-final-command.json`，命令索引对它作了显式自引用排除，并由本 author manifest 绑定。

本 attempt 包含 `baseline.json`、十项前置/423 项计划审计、材料输入 byte audit、旧 release history copy、candidate proof archive、runtime raw index、production/execution pre/post hashes、registry pre/post hashes、来源决定、`diff.json`、rollback 和本结果。用例/产品报告只声称本实际开发候选和隔离 loopback profiles。

## 需求与支持范围

R03/R04/R05/R24 映射见 [freeze.json](../../../docs/releases/0.2.0/freeze.json) 与 [P02 requirement evidence](../../../docs/evals/P02/requirement-evidence.md)。U11 复用已接受 U01-U10 证据，并新鲜验证 candidate09 Desktop/ledger/backup runtime seam；它没有重新运行历史 unit161、Native8 或全部 P02 单元测试。更完整的限制包括：原始 prompt currentValidation 仍 NOT_VERIFIED；unknown external effect 不盲重放；不覆盖完整 transcript/并发编辑/任意 OS/filesystem 崩溃；不验证 installer/portable、付费 Desktop 路由、普通 unguarded Native startup、真实用户凭据、人工视觉检查、物理断电或 OS sandbox。Native 自身 `node:sqlite` 未替换；角色素材公共分发许可未在本单证明。P03 尚未开始。
