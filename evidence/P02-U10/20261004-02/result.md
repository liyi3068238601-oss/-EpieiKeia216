# P02-U10 作者结果

状态：`ready_for_review`。这是作者提交的结果，尚未经过独立验收。权威计划 `planning/Xiadie_V2_v1.1` 未修改；前置 U01–U09 的接受记录按本次 baseline 引用。

## 实现与来源

候选使用已接受的 P02-U05 Better SQLite 事件存储和 P02-U08 在线备份接口，复用冻结的 P01 Desktop 工厂与运行时来源。U10 修改集中在 `tests/integration/P02/`：候选构建及闭包验证、Native 工厂接线、运行时绑定探针、受控 effects harness 和 Desktop UI driver。UI driver 对已验证的空密码跳过流程增加了窄超时转换：仅在 API-key 按钮已消失且原生 onboarding 或 composer 已可见时接受；其他超时仍失败。Candidate-09 的正常 success 路径通过，但本次没有实际触发这条转换分支。

候选源代码提交为 `cd03ddc3a3f6f7ca67b4313e309db20db4755343`。候选描述符 SHA-256：`6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74`；它固定 103 个仓库输入和 6,717 个自有运行文件。Better SQLite `13.0.3` 的 SQLite 版本是 `3.53.4`，Windows addon SHA-256 为 `e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a`。实际 Native CLI 是固定 Electron `41.0.3` 以 `ELECTRON_RUN_AS_NODE=1` 启动；固定 Node `24.14.0` 用于构建、driver、ledger verifier 和独立 reader，不是 Native CLI。Better 绑定仅覆盖 P02 事件存储和备份；Native 自有 session/TaskIndex/automation 存储仍使用 `node:sqlite`。

## 验证

- 固定 Node 类型检查与构建：no-emit、build 均 exit 0，命令原件为 `04-tsc-noemit.json` 和 `06-tsc-build.json`。边界扫描命令退出 0，但输出 `BOUNDARY_SCAN_NOT_RUN: packages/core is absent`，因此不计为边界检查通过。
- 同一固定 Node 的前序回归检查：unit 全量 `161/161`、Native 集成 `8/8` 通过，原件为 `fixed-node-unit-161.json` 与 `fixed-node-native-8.json`。这些检查早于最终 harness-only 修复；最终 Desktop 测试以 Candidate-09 为准。
- Candidate-09 完整 Desktop：6/6（`success`、`read_success`、`read_failure`、`cancel_recovery`、`disabled_native`、`pro_denied`），loopback 模型请求 9 次，外部请求 0 次。degradation：3/3（`no_key`、`no_dsh`、`offline`），loopback 请求 2 次，外部请求 0 次。两套件始终验证同一 descriptor 与 6,717 文件闭包。命令记录为归档中的 `73-candidate-09-build.json`、`74-candidate-09-desktop-full.json`、`75-candidate-09-desktop-degradation.json`；原始摘要与逐场景 sidecar 见相邻索引。
- 两套最终运行各自选取的 9 个注册表键的完整键快照，在 suite 开始与结束时 SHA-256 相同：`f7271757a866ad841238ecad6b467c0c663c0e32c1a966976179b24e539cb9c1`。关闭 Native 的场景没有事件 ledger 和 SQLite probe，按 `not_instantiated` 记录，不作为 addon 加载证明。

Candidate-07 offline 历史失败原件保留：同一 PID 重入触发运行时 probe 的 `EEXIST`，阻止了恢复，因此该次不构成 offline degradation 结论。Candidate-08 完整套件的 success 场景在 API-key 页面已切换到 Native onboarding 后发生 locator 超时；此失败不覆盖 Candidate-09。Candidate-09 正常通过，但没有观察到新超时转换分支被触发。对应 command、场景原件、descriptor 和 source-only 调查均已归档。

## 副作用与限制

一次早期未设 guard 的探索性启动使用测试可执行路径注册了 ZCode 菜单和协议处理器。之后用户授权将观测到的五个 Icon/command 值功能性修复到已安装的 `D:\Zcode\ZCode.exe`，独立回读确认成功；修复前未知自定义值无法重建，因此这不是还原历史状态。Candidate-09 两套 guarded suite 没有进一步更改选定的九个键。历史 recent-document list 没有初始快照或调用轨迹，其影响未验证。

P02 effects guard 仅是受控测试 harness 的主进程 instrumentation，不是 OS sandbox，也未修改 Native 产品代码。普通 Native 启动、installer/portable 部署和菜单品牌不在本次验收范围。测试使用自有 profile、合成本地 effects 与 loopback model fixture；人工视觉审查为 `NOT_RUN`。Candidate 闭包只覆盖完整自有文件集及一个冻结 Native `node_modules` junction，不能据此声称完整依赖闭包或发行包已验证。

本次 scope 仅为 `tests/integration/P02/`、`docs/evals/P02/` 与 `evidence/P02-U10/`。精确 diff 与文件哈希见相邻 `manifest.json`；最终 author commit 以该 manifest 对应的 Git commit 和独立 verify-author 记录为准。回滚代码应仅撤销 U10 作者提交；已授权的五值注册表功能修复是独立外部状态，不会由代码回滚自动恢复为未知旧值。
