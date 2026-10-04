# Xiadie 0.2.0 本机开发候选冻结

当前作者快照为 **ready_for_review**，`accepted:false`，G02 等待独立审查。当前状态与后续接受记录以 [P02 status](../../../evidence/P02/status.json) 和 [U11 acceptance](../../../evidence/P02-U11/20261004-02/acceptance.json) 为准；作者文档不会自行关闭 gate。

本次冻结只整理已经接受的 P02 实现和新鲜候选证据。它保留 ZCode 原生 UI/Runtime 与已接受的人设/事件账本行为；P02 durable event-store/backup API 使用 `better-sqlite3` 13.0.3（内置 SQLite 3.53.4）。实际 Desktop app-server 使用固定 Electron 41.0.3 executable 的 `ELECTRON_RUN_AS_NODE=1` 模式，Better 的 Windows `win32-x64.node` 在实际 CLI PID 中由 `process.dlopen` 加载。固定 Node 24.14.0 只用于构建、辅助脚本和独立 ledger reader。Native 自身存储仍使用 `node:sqlite`，本轮没有替换 Native。

候选材料提交 `cd03ddc3a3f6f7ca67b4313e309db20db4755343`，上游源码固定 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；descriptor SHA-256 `6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74` 绑定 6717 个候选文件和 103 个材料输入。复核脚本逐项确认这 103 个输入与当前 clean author baseline 的 Git blob 一致。候选复用已接受的 U10 candidate09，没有重建。运行期 Better 包闭包共 26 个文件，实际 addon SHA-256 `e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a`；MIT license、上游 license 与 third-party notices 的字节/hash 都由 descriptor 固定。[完整冻结索引](freeze.json) 与 [候选归档索引](../../../evidence/P02-U11/20261004-02/candidate-proof-index.json) 保存文件级绑定。

新鲜实际候选重跑为 **full 6/6** 和 **degradation 3/3**，两套共 11 个本机合成 loopback 模型请求，真实外部模型请求/凭据/付费调用均为 0，未启动 DSH。`disabled_native` 关闭 P02 durable wrapper/probe；它产生的 2 个本地请求属于 Native fallback，不是 P02 ledger facts。其余实例化场景有 Electron CLI PID、Better addon 路径/hash 和 SQLite 版本 sidecar。`success` 场景的 SQLite backup/restore SHA 相同，integrity/fk 检查通过。执行输入、生产配置/文件与两套各自的九个选定注册表键快照前后均一致。主进程写入 guard 是 instrumentation，不是 OS sandbox。

| 要求 | 当前阶段依据 | 限制 |
| --- | --- | --- |
| G02 来源可追 | U03/U04/U05/U09/U10 接受证据、candidate09 的 103 输入和 6,717 文件闭包、实际 CLI/addon PID sidecar | 原始 prompt 当前验证仍为 NOT_VERIFIED；哈希不证明任意业务事实 |
| G02 已提交事实可恢复 | 已接受 U07/U08/U10 与本次 `success` 的 Better-backed backup/restore 和 canonical table hashes | 不恢复未保存的原文、整段对话或缺失历史 |
| G02 失败重试不伪造历史 | 已接受的 U05/U07/U10 unknown-effect/no-replay 证据与本次 fresh full/degradation 状态 | 任意外部副作用/物理断电不在覆盖范围 |
| R03/R04/R05/R24 | [P02 需求映射](../../evals/P02/requirement-evidence.md)、十项已接受前置、423 项计划文件审计及本次实际 UI/SQLite 报告 | 只覆盖 P02 阶段；不是全项目 Must 关闭 |

原始 ledger reader 报告保留了旧的 `qualificationBoundary` 文案，称 CLI 为 fixed Node CLI；该独立 reader 只证明 ledger readback，不作为实际 CLI 身份依据。实际 Electron 模式由 Desktop runner 的精确资格边界、main/CLI PID 关联和 `process.dlopen` addon sidecar 证明。新的 onboarding timeout fallback 分支在 candidate09 的 UI actions 中未触发。

本构建是固定源码/依赖目录的本机开发候选，不是安装器、可移植包或公共发布。真实付费 Desktop 路由、人工视觉审阅、完整依赖闭包、普通无 guard 的 Native 启动、物理电源/磁盘故障和全系统隔离未验证；公开角色素材许可亦未由本次冻结扩展证明。已接受 U10 Native8 和早期单元回归是历史阶段证据，本 attempt 没有重跑。完整限制、来源决定、回滚和命令均见本 attempt 的 [结果](../../../evidence/P02-U11/20261004-02/result.md)、[来源决定](../../../evidence/P02-U11/20261004-02/source-decision.md)、[回滚说明](../../../evidence/P02-U11/20261004-02/rollback.md) 与 [command index](../../../evidence/P02-U11/20261004-02/command-index.json)。下一节点是 [P03-U01](../../../planning/Xiadie_V2_v1.1/tasks/P03-U01.md)，本次停在 G02，未启动 P03。
