# P01-U01 调查提交

作者状态：ready_for_review。尚未接受 U02、尚未实现产品，G01 仍 pending。

前置：P00-U12 accepted，G00 pass；本单元 baseline 为 P01 入场提交 `d1d4606`。冻结计划、三个固定来源树和生产配置未改。

调查报告：`docs/research/P01/native-reuse.md`。比較官方插件加薄宿主、小范围下游 patch、插件内独立模型链路；优先试验第一路线，未在调查阶段批准 patch。官方当前文档与固定源码的敏感配置 UI 差异、Hook 字符限制及事件敏感数据均有说明。ZCode/Herta 的相关测试、许可、build/安装流程均已调查；源码阅读不当作运行成功。

人格材料：用户已采用源自 Neo-MoFox 的精简版，要求所有版本保留。四个版本已登记；完整原人格字段仅保存在 Git 忽略的本机私有档案，其余 TOML 配置不复制。原文件读取前后 SHA 一致。用户保留角色背景的选择优先于 R01 的原创措辞，该执行差异及未核实的公开发行权利明确记录。

## 实际验证

执行 `python -X utf8 docs/research/P01/verify-research.py`，cwd `E:\Xiadie\Xiadie`，exit 0。精确解释器命令见 `command.json`；真实 stdout/stderr 字节见 `stdout.bin`、`stderr.bin`；stdout 另作为 `verification.json` 保存。核验三个 Git 来源固定 HEAD/clean、28 个相关源码/测试/许可/安装脚本文件哈希、前置接受记录、授权与四个人设版本哈希、私有原稿不进 Git。固定 ZCode 跟踪的测试路径实际为四项，与调查报告一致。

本次核验没有模型生成、启动桌面、安装、构建或调用用户工具。`tests/units/P01-U01.test.ts` 的目标映射为本单元研究核验脚本；工作区标准 pnpm 命令待 U03 建立，不伪报本单元已有 TS 单测。

基线见 `baseline.json`，候选来源决定见 `source-decision.json`，实际单元差异见 `diff.patch`，独立审查绑定见 `ready-for-review.json`。审查员应重新核对具体文件字节，而不是沿用报告自述。

## 限制与回滚

尚未证明完整桌面 no-Key 设置流、Provider 运行时行为、双模型角色输出、可信投影或候选包。U02 先验证无 Key 设置/本地记录，再 mock 正常、失败、恢复，最后执行已授权的小样本真实路线；真实原人格档案不作为模型输入，DSH/Dream 不默认启动。

回滚优先 revert 本单元研究提交；保留原始人格、历史版本、失败证据和全部 P00 接受记录。无远程 push、tag 或发布。
