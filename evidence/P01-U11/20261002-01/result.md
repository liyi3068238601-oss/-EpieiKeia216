# P01-U11 作者结果：0.1.0 冻结候选

**作者结论：ready_for_review；尚非 accepted。** 根状态仍为 U11 running，G01 尚待独立审查。本文只记录 P01-U11 冻结材料与验证证据。

## 基线与范围

P01-U10 accepted 基线为 7a284538250d54c228a3a67fcabff4882c8afeff。U11 执行提交为 c90e8c14e7437e84b088212694bc3ae6a1a5cfcc。验证使用 candidate-06，仓库构建提交 82298c735dfbc4f278b5e920d79be7a83f979b55，固定 ZCode 源提交 29628c9acdb81b703bbd4080c207a0e7ce5e276e。

本单元唯一差异是 tests/integration/P01/desktop-ui.mjs 的五行测试快照命名调整：offline 流程的前后历史快照使用不同 checkpoint 文件名，避免二次写入触发 EEXIST。candidate 未重建；产品 packages、prompt、schema、assets、plugins、配置和 lock 文件未变。该改动修复既有 gate 测试，不扩大产品范围。

candidate descriptor SHA-256 为 25f92e7604b41479fdcdd9dcc089afe0ce6441db4586a7f7e7614805632a8907；descriptor 绑定 6,673 个产物、66 个项目输入。分组摘要与来源 hash 见 baseline.json；文件级冻结清单由 coordinator/freeze-inputs.json 和 descriptor hash 绑定。

## 命令与结果

工具链为 Node v24.14.0、pnpm 10.33.2；两次运行 cwd 均为 E:\Xiadie\Xiadie\.runtime\P01\worktrees\u11。准确 argv、耗时、日志长度和日志 SHA-256 见各 run 的 commands.json。

| Run | 命令 | 执行提交 | 结果 |
| --- | --- | --- | --- |
| final-01 full | pnpm run test:e2e -- --candidate E:\Xiadie\Xiadie\.runtime\P01\u10-candidate-06 --suite full --output E:\Xiadie\Xiadie\.runtime\P01\validation\u11-final-01\full | 7a284538250d54c228a3a67fcabff4882c8afeff | 6/6，exit 0；日志 SHA-256 ab6cfa87a143d3b8dd6aace5fff561bf3a1f3133b5b49cc6a105ccc41f55d6ac |
| final-01 degradation | pnpm run test:e2e -- --candidate E:\Xiadie\Xiadie\.runtime\P01\u10-candidate-06 --suite degradation --output E:\Xiadie\Xiadie\.runtime\P01\validation\u11-final-01\degradation | 7a284538250d54c228a3a67fcabff4882c8afeff | no-key 与 no-DSH 通过；offline UI 收到 503、显示失败并打开 Settings/历史，随后快照重名导致 EEXIST，runner exit 1；日志 SHA-256 3d8c3c6885d834ba3b7d5362b974466b657e499cdf0f23c3f12b2724894ffefd |
| final-02 degradation | pnpm run test:e2e -- --candidate E:\Xiadie\Xiadie\.runtime\P01\u10-candidate-06 --suite degradation --output E:\Xiadie\Xiadie\.runtime\P01\validation\u11-final-02\degradation | c90e8c14e7437e84b088212694bc3ae6a1a5cfcc | 3/3，exit 0，156.43 秒；日志 SHA-256 ae7209532de88721d3c1ec8fb1824038fa3e369ef9b3503a22b03f4ce14f2079 |

final-02 只重跑三项 degradation；full suite 复用同 candidate 的 final-01 6/6 结果，因为 U11 仅改动 offline history snapshot 的测试输出命名。final-02 中 no-key 的 provider/model rules 为空、发送禁用、Settings 可打开且 0 请求；no-DSH 使用一次本地 loopback 200 请求，DSH 进程树已核验；offline 使用一次本地 loopback 503，model_request_failed 可见、无成功回复，前后历史 marker 均已保存。外部模型请求 0，production/execution 均未改变。ZCODE_MODEL_RETRY_MAX_RETRIES=0 只用于本地 owned test harness，不改生产策略。

## G01 映射

以下为可核对的证据映射，不是作者自判 gate pass：

| G01 条目 | 真实证据 | 边界 |
| --- | --- | --- |
| 身份资产可验证 | [U04 acceptance](../../P01-U04/20261001-01/acceptance.json)；v3 persona、manifest 和 candidate descriptor hash，见 baseline.json | 资产版本含原游戏背景；不证明原创 IP 或公开再分发许可 |
| 主交互可运行 | [full summary](runs/final-01/full/summary.json) 与 [commands](runs/final-01/commands.json) | 实际 Desktop UI 自动化；后端为隔离 mock，不是 U11 真实模型调用 |
| 失败不报成功 | final-01 full 的 read_failure；[final-02 offline scenario](runs/final-02/degradation/scenarios/offline/scenario-result.json) | 503 与错误提示可见，无成功回复；旧 EEXIST runner 失败仍保留 |
| 禁用扩展仍保留原生 Runtime | final-01 full 的 disabled_native scenario；U06 accepted 结果 | 隔离 Desktop/mock 验证，不等于生产 provider 验证 |

前置 U01-U10 accepted 文件及摘要哈希由 [prerequisite audit](coordinator/prerequisite-audit.json) 固定：424 个计划跟踪文件中，PACKAGE_MANIFEST 列出的 423 项全部匹配。U09 共 18 次获批真实请求（历史 U02 4 次、U09 14 次）；其中只把 Flash 评为合格，Pro 测过但未合格，人工审阅为 not_reviewed。U10/U11 没有真实模型调用。

## 限制与后续

- 版本是本机开发 assembly，不是 installer、portable 包或已发布产品；没有发布授权。
- Desktop run 使用本地 mock；本轮真实模型调用 0，不能据此宣称真实凭据/付费链路通过。
- 身份沿用 U04 已接受的 v3 角色资产并保留游戏背景与版本史，不声称原创 IP。
- sidecar 是宿主核验证据，不是 renderer 回复面板；网络 guard 是 instrumentation，不是 OS sandbox。
- 视觉审查和 Core boundary scan 均 NOT_RUN；P02 应用持久层尚未开始。
- P01 只覆盖 R01、R02、R03、R05、R06、R13 的阶段证据，R13 全项目 Must 等后续阶段完成。

下一节点为 P02-U01：调查 Runtime event/transcript 与 SQLite 迁移备份。本轮未启动 P02。