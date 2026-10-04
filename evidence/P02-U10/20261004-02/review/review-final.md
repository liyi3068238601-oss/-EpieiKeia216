# P02-U10 独立审查

**决策：PASS**（仅限本报告的 P02-U10 本地 candidate / harness 审查）

审查目标为 author commit `d0952673ed6961cacfc38edf9c39256228c7dfc8`，基线 `178379a8ad9c0c27f833a412ff06f7b0095bab79`。最终 manifest 为 `evidence/P02-U10/20261004-02/manifest.json`，SHA-256 `da87f3a845b577c890bc21232f28b2cabbf271f493dbc4f7b2f4dea1565dac4e`，列出 356 个文件和 357 个变更路径。独立核对 Git blob、author worktree 原始字节和 manifest 一致；主仓仍位于干净基线，author worktree 位于精确目标且干净。

候选输入与闭包检查通过：descriptor SHA-256 `6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74`；6,717 个自有文件均验证通过，103 个仓库输入同时匹配候选源提交 `cd03ddc3a3f6f7ca67b4313e309db20db4755343` 与最终 author 源文件；250 个 proof 文件、45 个运行时 sidecar 均与其原件逐字节一致。依赖闭包包含 Better SQLite `13.0.3` / SQLite `3.53.4`，26 个 MIT 包文件；Windows addon SHA-256 为 `e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a`。独立审计确认三条 raw-index provenance 路径修复后可解析且其内容哈希正确。此前 36e9d2c checkpoint 的两处路径分隔符缺失已在最终 d095 中更正，旧问题和旧审计输出均保留。

最终 candidate-09 的完整 Desktop suite 为 6/6，degradation suite 为 3/3。独立关联了九个场景的 CLI PID、候选 addon 实际加载、CLI home alias 与 hash、SQLite/package 版本、Electron main PID / argv / cwd / execPath、每场景 18 条 guard 请求及两套件各自的九个注册表键快照。八个启用 P02 的场景提供了 CLI 实际 addon-load sidecar（offline 有两个）；`disabled_native` 明确关闭 P02 durable wrapper，Native fallback 仍完成两次 loopback 请求；该场景的 `not_instantiated` 仅表示 P02 ledger/probe 未创建，不表示 Native 停止，也不是 Better addon 加载证据。两套件共 11 个 loopback 模型请求、0 个外部请求。九键 suite 前后快照哈希均为 `f7271757a866ad841238ecad6b467c0c663c0e32c1a966976179b24e539cb9c1`，仅证明这两次运行未改变所选键值。

`success` 的存档 readback 报告记录 snapshot-v1 backup/restore、备份与恢复数据库摘要哈希相同、integrity 与 foreign-key 检查为 `ok`，且用户/版本及各类行计数符合结果文件。独立审查验证了该 readback 报告、proof 索引和原件哈希绑定；本审查没有另行打开或查询被忽略的原始数据库文件。实际 CLI 是 pinned Electron `41.0.3` 以 `ELECTRON_RUN_AS_NODE=1` 运行；固定 Node `24.14.0` 用于构建、driver/helper/readback 和本审查的 targeted test。Better binding 的范围仅限 P02 event store/backup，Native 自有 session、TaskIndex、automation store 继续使用 `node:sqlite`。

本审查在固定 Node `24.14.0` 上 fresh 运行 `sqlite-runtime-probe.test.mjs`，结果 1/1；覆盖同一 PID 的原始字节幂等复用、mtime 不变、冲突占位不覆盖、directory junction 拒绝。30c00b checkpoint 上的 guard 5/5、desktop side-effect 2/2、candidate-verifier 10/10 只在其代码与运行输入 hash 与 d095 最终输入保持一致的前提下复用；它们未在 d095 上重新运行。Author 的 fixed-Node typecheck/build、unit 161/161 与 Native 8/8 是归档的 author 证据；后两者是此前 checkpoint，并非本 reviewer 的 fresh rerun。

审查保留两类 reviewer-harness 失败：一次 663 manifest 检查与 author 文档冻结同时发生，clean-tree 前置条件因此停止；另有 reviewer 自身的候选审计脚本范围过窄及字段键名错误，均已修正并由最终 d095 审计成功替代。它们不是产品失败，也未改 author 生产文件。Candidate-07 的 offline probe `EEXIST` 失败及 Candidate-08 的 UI locator 超时仍保留；它们没有被计入通过场景。Candidate-09 的正常 success 路径通过，但 narrow onboarding timeout fallback 分支没有实际命中。

**限制与未覆盖项：** import-boundary 命令虽退出 0，但输出 `BOUNDARY_SCAN_NOT_RUN: packages/core is absent`，所以边界检查是 `NOT_RUN`。人工视觉审查、独立 Native 启动、installer/portable 部署、付费 Desktop/生产发布、物理断电恢复均 `NOT_RUN`。P02 effect guard 是 main-process instrumentation，不是 OS sandbox。关闭 P02 wrapper 的场景不代表关闭 Native 引擎。候选闭包只验证声明文件集和一个指向冻结 Native `node_modules` 的 junction，不能代表完整安装包依赖闭包。

早期未设 guard 的探索性启动曾写入四个 HKCU context-menu 键及协议相关键。之后在用户授权下，将观察到的五个 command/Icon 值修复为已安装 `D:\Zcode\ZCode.exe`；旧自定义值未知且不能恢复，故不声称复原历史注册表状态。当前 suite 的九键前后相同只覆盖其即时运行区间；历史 Recent-document list 没有 baseline/调用轨迹，影响未验证。两份 reviewer-owned 预检查 fixture 留在 experiments 区，因安全清理拒绝而保留；未尝试绕过清理限制，且它们未包含在 review archive 内。

