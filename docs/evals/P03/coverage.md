# P03-U09 覆盖准备：G03、R07、R08、R24

此文件是 U09 的准备性覆盖映射，不是结果或验收报告。计划卡、需求矩阵、P03 记忆政策、复用 ADR 和固定 Native checkout 均只读。精确 U01–U08 author commit、acceptance/review 原始字节大小与 SHA-256、U09 卡片/基线、Native 许可及七项 raw file hash 见 [source-adoption.json](../../../evidence/P03-U09/20261008-01/source-adoption.json)。

本映射逐项使用 U01–U08 的 canonical acceptance 与独立 review 记录。U01/U02 的旧 result 文档保留了提交时 `ready_for_review` 的历史措辞；后续 acceptance 和 review 才将这些单元接受。P03-U09 卡片仍是不可变计划输入；当前执行基线记为 `running`。U09 整体验收为 `NOT_RUN`。

| 已接受单元 | author commit / integrated commit | canonical acceptance | independent review | 产品与测试路径 |
| --- | --- | --- | --- | --- |
| P03-U01 | `bb923d6197a40199e9b4b95d00235a5cb4355594` / `150b53da1753fed4f1258bbf90c226e21b6da454` | `evidence/P03-U01/20261004-01/acceptance.json` | `evidence/P03-U01/20261004-01/review-final.json` | 研究/来源清单：`docs/research/P03/P03-U01.md`、`evidence/P03-U01/20261004-01/source-manifest.json`；无产品文件或产品测试路径 |
| P03-U02 | `e9314207347d33dd61cab941a8dca549c9575ca8` / `964d08bfd626f438c8d161760f9aa7828831f15b` | `evidence/P03-U02/20261008-01/acceptance.json` | `evidence/P03-U02/20261008-01/review-final.json` | 隔离试验：`evidence/P03-U02/20261008-01/topology-service/`、`native-runtime/`；未直接修改产品文件 |
| P03-U03 | `2530a944f9c4f403675378e843c44a11c9880681` / `0fd6d87993e17e4f2ca97a33351f9f2dfe0c54ba` | `evidence/P03-U03/20261008-01/acceptance.json` | `evidence/P03-U03/20261008-01/review-final.json` | `packages/projects/registry.ts`; `packages/projects/test/registry.test.mjs` |
| P03-U04 | `326ee26a77f5b79a0220e86cc9edcaa5542bb5fd` / `36850a0717dad3cd27d9a4b5cc1ae7f9bab354b6` | `evidence/P03-U04/20261008-01/acceptance.json` | `evidence/P03-U04/20261008-01/review-final.json` | `packages/adapters/zcode/src/project-memory.ts`, `host.ts`, `plugins/xiadie/hooks/context.mjs`; `packages/adapters/zcode/test/project-memory.test.mjs`, `project-memory-host.test.mjs`, `host.test.mjs`, `transcript-host.test.mjs` |
| P03-U05 | `74a442909cb540360a82826a113adcac68d78818` / `3d570fa5354209416b5081e9ca7f82bfa3e4476f` | `evidence/P03-U05/20261008-01/acceptance.json` | `evidence/P03-U05/20261008-01/review-final.json` | `docs/policies/project-memory.md`, `templates/project-note.md`; `packages/projects/test/project-memory-policy.test.mjs` |
| P03-U06 | `5ff89f14b79370d63553ac10cec6adb57143964e` / `27f4fab6ead14053f2bc8ff65415f126306566d2` | `evidence/P03-U06/20261008-01/acceptance.json` | `evidence/P03-U06/20261008-01/review-final.json` | `packages/projects/registry.ts`, `export.ts`, `relocate.ts`; `packages/projects/test/project-memory-migration.test.mjs` |
| P03-U07 | `3ec0583ee1aefef66b58576c9700bac38c099a10` / `f3d0cfcdbeda8406c4adde9fa4486ffa4deed3f0` | `evidence/P03-U07/20261008-01/acceptance.json` | `evidence/P03-U07/20261008-01/review-final.json` | `packages/work/handoff-context.ts`; `packages/work/test/handoff-context.test.mjs` |
| P03-U08 | `035bb11b423f6e06da6cefc595ac1c936a548ca6` / `39635a10a481da66c2038d629cac89c78b872514` | `evidence/P03-U08/20261008-01/acceptance.json` | `evidence/P03-U08/20261008-01/review-final.json` | `packages/projects/freshness.ts`; `packages/projects/test/freshness.test.mjs`; `tools/run-tests.mjs` U08 selector |

这些单元的接受记录只约束各自的产品与验证边界。U01 的研究、U02 的隔离试验和其余 accepted unit 都不能代替 U09 阶段集成或 G03 gate。

## G03 Must 映射

计划把 G03 写为三项：项目记忆不自然衰减、目录迁移可追、原生与应用数据没有双写权威。下表中的 `G03-M1` 至 `G03-M3` 是本覆盖文档的局部追踪标签，不修改计划卡。

| 项目 | 核验标准 | 已接受单元及当前产品/测试路径 | U09 当前边界 |
| --- | --- | --- | --- |
| G03-M1 | 时间经过本身不让项目记忆过期；需要按当前 Git base 与证据原始字节重验。 | U04/U05/U08；`packages/adapters/zcode/src/project-memory.ts`、`docs/policies/project-memory.md`、`packages/projects/freshness.ts`；测试 `packages/adapters/zcode/test/project-memory.test.mjs`、`packages/projects/test/project-memory-policy.test.mjs`、`packages/projects/test/freshness.test.mjs`，最终集成目标 `tests/integration/P03/native.integration.test.mjs`。 | 下层 unit 已接受；Native/destination 候选最终集成仍 `NOT_RUN`。 |
| G03-M2 | 项目身份和 Native memory 路径在物理迁移后可追溯；导入/迁移有显式确认、回滚和不覆盖行为。 | U03/U06/U08；`packages/projects/registry.ts`、`export.ts`、`relocate.ts`、`freshness.ts`；测试 `packages/projects/test/registry.test.mjs`、`project-memory-migration.test.mjs`、`freshness.test.mjs`，最终集成目标 `tests/integration/P03/native.integration.test.mjs`。 | Registry 与 relocation 的下层测试已接受；U09 的最终端到端绑定仍 `NOT_RUN`。 |
| G03-M3 | 不建立 Native 与应用的双写事实库：registry metadata 负责身份，Native MEMORY/topic 的原始字节负责笔记内容；经验与 freshness history 不升级为事实库。 | U03/U04/U05/U07/U08；`packages/projects/registry.ts`、`packages/adapters/zcode/src/project-memory.ts`、`packages/adapters/zcode/src/host.ts`、`packages/work/handoff-context.ts`、`packages/projects/freshness.ts`；测试 `packages/adapters/zcode/test/project-memory.test.mjs`、`project-memory-host.test.mjs`、`packages/projects/test/project-memory-policy.test.mjs`、`packages/work/test/handoff-context.test.mjs`，最终集成目标 `tests/integration/P03/native.integration.test.mjs` 与 `reader-parent-acl.test.mjs`。 | 下层 authority/guard tests 已接受；U09 的 Native/destination 测试最终重跑仍 `NOT_RUN`。 |

Authority 边界按 `docs/policies/project-memory.md` 和 U04/U05/U08 接受结果解释：registry metadata 只确立 project identity/workspace binding/revision；Native raw memory bytes 是被选中 note 内容的源；note 一律是 `experience-lead`，frontmatter 不能提升事实级别；U08 freshness history 是核验历史/append proposal。P03 coordination status ledger 仅记录阶段进度，不是业务 `TaskLedger`，不能据此填 owner/progress。

## R07、R08、R24 映射

| 需求 | P03 范围内的含义 | 已接受单元及当前产品/测试路径 | 覆盖范围限制 |
| --- | --- | --- | --- |
| R07 项目记忆与源码事实分工 | 源码、同 revision 测试和 accepted evidence 决定当前实现事实；memory 只作为经验线索；无业务 TaskLedger 实体时 owner/progress 是 unknown。 | U03/U04/U05/U07/U08；`docs/policies/project-memory.md`、`project-memory.ts`、`handoff-context.ts`、`freshness.ts`；测试 `project-memory-policy.test.mjs`、`project-memory.test.mjs`、`handoff-context.test.mjs`、`freshness.test.mjs`；最终 U09 目标 `tests/integration/P03/native.integration.test.mjs`。 | 本文只映射 P03。R07 还关联 P08/P15；不代表其他阶段已验收。 |
| R08 子代理 scope 与最小 handoff | handoff 要显式、最小、受项目与证据边界约束；hash 绑定字节，不证明语义为真。 | U07/U08；`packages/work/handoff-context.ts`、`packages/projects/freshness.ts`；测试 `packages/work/test/handoff-context.test.mjs`、`packages/projects/test/freshness.test.mjs`，以及 `tests/integration/P03/native.integration.test.mjs`、`native.worker.mjs`。 | 本文只映射 P03。R08 还关联 P00/P08/P09；不代表这些阶段已验收。 |
| R24 备份恢复与旧工程保护 | 导出、导入与 relocation 保留来源/映射关系，采用不覆盖和显式回滚，保护旧 project 数据。 | U03/U06；`packages/projects/registry.ts`、`export.ts`、`relocate.ts`；测试 `packages/projects/test/project-memory-migration.test.mjs`。P02 的 `tests/integration/P02/durable-host.mjs`、`native.worker.mjs` 和 `packages/storage/backup/test/backup.test.mjs` 是可复用的保护/恢复测试样板。U09 集成目标为 `tests/integration/P03/native.integration.test.mjs`。 | 本文只映射 P03。P02 acceptance 只是测试样板；R24 在 P09/P14/P16 的工作仍需单独核验。 |

## U09 source adoption 与执行边界

U09 复用 P01 Desktop transport/factory 的隔离和边界测试方式，以及已接受 P02 的 candidate builder、durable host、side-effect guards 和固定 Node Native worker 方式。P02 参考路径包括 `tests/integration/P02/build-candidate.mjs`、`durable-host.mjs`、`desktop-main-guard.cjs`、`registry-write-guard.cjs`、`native.worker.mjs` 和 `native.integration.test.mjs`。这些只是测试/组合样板；P01 transport gate 记录没有 generation、credential open、socket connect 或 Native runtime launch，不能变成 U09 paid-model 证据。

U09 Native 参考固定在 `.runtime/P01/desktop-source` commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，现场工作树为 clean，LICENSE 为 Apache-2.0。Z03–Z07 五个来源文件及测试所用两个 Native path/key resolver helper 的实际文件字节 SHA-256 已逐项记录在 source-adoption JSON。哈希通过对本机文件读取字节计算，非 Git LF-normalized blob hash。Native 源码、许可证、安装态和用户 memory 均保持只读。

U09 baseline 已把 corrective reader scope 登记到 `packages/adapters/zcode/src/project-memory.ts`，并把 selector 登记到 `tools/run-tests.mjs`。当前路径映射是供后续最终绑定使用，不记录仍在变化的 U09 source/test/selector 字节哈希。最终 binder 需等所有 writer 停止后，再核实并绑定确切 commit、产品与测试 raw hash、selector、固定工具链、命令/cwd/exit code、真实 stdout/hash 记录与独立 reviewer。

当前边界如下：

- 协调方报告第一次真实 Windows ACL ancestor run 的三个 case 均通过。那次 JSON 诊断在恢复后读取累计 resolve 次数，显示 4；denied capture 自身断言为 2。诊断现已改为在恢复前保存 denied-call 数，并另外输出恢复后的总数。诊断修正后的最终 U09 selector 重跑仍为 `NOT_RUN`，原始 stdout 尚未在此记录中绑定。
- Native/destination candidate 仍有 writer 在改，最终构建/集成是 `NOT_RUN`。
- portable installer、paid model、DSH 与 installed ZCode application 均没有 U09 结果，本映射不声称它们通过。
- 这份文档和 source-adoption 都是 preparation/source-adoption，不是 U09 `ready_for_review`、pass、accepted，也没有关闭 G03。
