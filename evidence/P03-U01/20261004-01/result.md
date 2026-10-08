# P03-U01 result

状态：ready_for_review；作者研究材料待独立审查，未接受。
任务 baseline：ecc2aa40c92b4474a12c455ecb0460d47430ca5f，branch p03-u01，attempt 20261004-01。
前置：P02-U11 acceptance SHA-256 50e2df900bdecf891a2ddbe94934409a4e5491769144e52c188e2e3545550fd5，G02 pass；completion audit SHA-256 f282f2ec107a9da4cddabc725dd0e9f379e6a58aded53111abd29a12d56c2892。冻结 baseline input 在 baseline.json。

正式研究报告：docs/research/P03/P03-U01.md。来源文件级清单：source-manifest.json，SHA-256 0a0fb989107f8ef9b252f27f015e46ffbb1ab0bcc4d111565eff0bd9d6bf54dc，绑定 104 项输入、Pinned Native checkout 和 parser/ADR 准备 manifests。原有完整 source checkouts 未复制进 Git。详细比较、来源 pin/许可证、搜索日期/词/URL、Native 与 fresh host seam、权限差额、候选路线、NOT_RUN 界限和 rollback 均见研究报告。

作者候选：U02 先验证可信 per-turn provider 能否通过支持的 MemoryService 到达实际 Native request/Read 边界；如无法诚实提供受限 raw bytes/hash，才实验有界 Apache 来源只读 adapter。应用侧 UUID/key/legacy alias registry 和结果目录边界都需 owned fixture 与执行器实测。handoff 候选为本地静态模板加薄证据校验；MADR 作可许可模板来源，Native task completion 只作为执行证据。所有决定留给 U02 实测及独立审查。

命令/cwd/exit 记录：
- baseline helper：command-baseline-unit.json，exit 0。
- helper CLI inventory 首次 Windows PowerShell policy 失败、重试成功：command-helper-cli-inventory.json（失败）及 command-helper-cli-inventory-02.json（成功，5 个 helper --help 均 exit 0）。
- source manifest 首次 Windows PowerShell 不具备 Get-FileHash 失败、pwsh 重试成功：command-source-manifest.json（失败）及 command-source-manifest-02.json（成功，manifest SHA 如上）。
- 每个记录保留 argv/cwd/时间/exit/stdout/stderr；详细 Git helper diff 和 freeze 命令由对应 diff.json/final manifest 记录。
- Source/tests/licenses/install inspection 已做；候选 tests NOT_RUN，install/build NOT_RUN，Native/product runtime/model NOT_RUN。未发生依赖安装或产品修改。

审查判定、acceptance 和后续任务启动由 root coordinator 及独立 reviewer 执行。

## 2026-10-08 接续收尾

保留 2026-10-04 原有研究、失败命令及未提交修改。在相同 baseline 上重新核验 104 个来源输入及三个准备清单，研究内容仍针对固定 Native commit；没有将固定版本研究描述为最新上游。新核验命令和结果见 resume-source-readback-command.json 与 resume-source-readback.json。最终完整 SHA-256 和 Git blob 清单见 manifest.json，替代下文历史终端截断值作为当前产物身份。产品运行、真实模型和后续单元依旧 NOT_RUN。

## 作者工作区路径校正

本轮初次写文件误落在仓库旁路径 E:\Xiadie\.runtime\P03\worktrees\u01 下的 docs/research/P03/P03-U01.md 与 evidence/P03-U01/20261004-01/result.md。核实目标 worktree 尚无这两份文件后，将本轮创建的两个文件移入指定 author WT：E:\Xiadie\Xiadie\.runtime\P03\worktrees\u01；没有覆盖目标文件。移入后对目标文件计算 SHA-256，报告为 F061E6BBCC1C81EB10BE2A371256EE5D78E…，result 为 E156AE079D215C31A9A9CEF5D3161C67EEB…（PowerShell 展示截断）。两个 diff-unit 失败和成功重试均保留在 command-diff-unit.json、command-diff-unit-02.json、command-diff-unit-03.json；路径校正后 diff-check pass。误路径下文件已移走，未清理或删除其他旁路径内容。
