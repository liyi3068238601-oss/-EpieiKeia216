# P00-U03 结果

**作者状态：** `ready_for_review`
**范围：** 只读旧工程盘点；未接受、未修改执行状态、未 stage/commit。

任务卡 `planning/Xiadie_V2_v1.1/tasks/P00-U03.md` 第 11、15–27 行授权新增 `docs/baseline/local-inventory.md`，要求检查历史路径、区分资料/人格资产/旧数据库/不可覆盖内容、记录来源决定与命令证据，并明确缺失路径标 unknown。`AGENTS.md` 第 3、7–11 行要求冻结计划、保护项目与生产数据、记录命令/哈希/限制，并由作者提交 `ready_for_review`。前置 U02 整体验收收据为 `evidence/P00-U02/20261001-01/acceptance.json`，状态 `accepted`。新项目根盘点开始时为 `9e70d861102f1e2738e034311a6e220ad74377c8`；执行期间主控为 U02 复审追加 metadata 并提交 `97cf03ee156e9201dda9ee1dfa0fddd7ee53efa7`，该主控提交不是本盘点写入。

授权历史路径 `E:\Xiadie\Xiadie-next` 的本轮 `Test-Path -LiteralPath` 结果为 `False`（PowerShell 退出码 0）。因此没有旧工程分支或工作区状态可报告；本轮不查找其他副本。盘点分类与不迁移决定见 [local-inventory.md](../../../docs/baseline/local-inventory.md)。生产数据根只沿用既有发现文档中“路径存在”的线索，没有检查内部文件、数据库、人格资产或权限配置，也没有读取凭据。

生产 DSH 仓库 `D:\Deepseek Harness\deepseek-harness` 盘点前后 HEAD 均为 `c291e7961a515f6d7af9304e7fd1d257929aef26`，`git status --short --untracked-files=all` 前后完全相同，均只有以下 5 个原有未跟踪文件：`eccv866.png`、`lfn_gen1.png`、`lfn_gen1.txt`、`lfn_shot1.png`、`nax_net.txt`。未打开、散列、移动或修改这些文件。新项目根在开始前读到 `9e70d861102f1e2738e034311a6e220ad74377c8`；随后主控为 U02 复审提交 `97cf03ee156e9201dda9ee1dfa0fddd7ee53efa7`，这是协调者提交，不是本盘点的写入。盘点产物仅在任务允许的文档和证据目录中。

实际命令均在 `E:\Xiadie\Xiadie` 执行，完整调用及退出码见 `run.json`：

| 检查 | 结果 |
|---|---|
| `git rev-parse --show-toplevel` | `E:/Xiadie/Xiadie`，exit 0 |
| `git rev-parse HEAD` / `git branch --show-current` | 本轮复核时 `97cf03ee156e9201dda9ee1dfa0fddd7ee53efa7` / `p00-baseline`，均 exit 0 |
| `Test-Path -LiteralPath 'E:\Xiadie\Xiadie-next'` | `False`，exit 0；按任务卡标记 unknown，不扩大搜索 |
| DSH `git rev-parse HEAD` | 前后固定为 `c291e7961a515f6d7af9304e7fd1d257929aef26`，exit 0 |
| DSH `git status --short --untracked-files=all` | 前后 5 项完全一致，exit 0 |
| `tests/units/P00-U03.test.ts` 路径检查 | 不存在；本单元为文档盘点，未新增测试 |

调查中有两次无副作用的命令探测失败：曾将 PowerShell 的 `-ErrorAction` 参数误传给 `rg`，rg 返回 `unknown encoding: rrorAction`；曾按未确认的名称查找 `04_需求追踪.md`，该路径不存在。随后改用精确 `Test-Path`、任务卡引用和 `requirements.json`，未改变文件。失败记录见 `run.json`。

没有运行测试、构建、旧项目或生产配置。风险和限制：历史路径不存在，不能确认旧人格素材/数据库的内容、许可或备份；既有发现记录的生产根信息不是本轮内部盘点。回滚仅涉及本 attempt 新建的 `local-inventory.md` 和证据文件；不得删除或回滚任何既有用户文件、生产状态或计划基线。
