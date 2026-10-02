# P01 在 U05 后暂停

暂停依据：用户“准备在最完整的可暂定点停止”。本次停止在已完成独立审查的基础模块边界：P01-U01 至 U05 accepted；U06 及后续实现未开始。P01 阶段与 G01 尚未验收，P02 未开始。

作者提交：`96457a2ef13e697e1877bcf23deb79578422a08e`。整合提交：`f7d3bcff8926b4e931b4fba70c111bb519668800`。最终收尾提交由本地分支 `p01-pause-u05` 固定；该分支包含本页、验收记录、执行状态和校验清单，不是发行版本。

## 已保存与验证

- U01/U02：固定来源与隔离复用决定；已有两条官方模型 ID 的真实只读路线，累计 4 次生成请求。它们的后端独立性未确认。
- U03/U04：最小 TS 工作区、approved character 资产加载器；v0/v1/v2/v3 全部保留，当前批准资产为 v3。原始 Mofox 配置未改。
- U05：instruction/state/evidence/content 分区、source_refs/scope/version、确定性 JSON、approved snapshot 权限、整体预算失败。初审发现的 Proxy 二次读取问题已修复并保留反例。
- 合并后主目录 check/build 通过；单元 19、契约 3、集成 25 项通过，0 失败、0 跳过。独立 U05 复审记录在 `evidence/P01-U05/20261001-01/review-final.json`。
- 权威 ZIP SHA-256 `3fcc323f433c222a3b4c651d0661dfd0f1eeb4577ded0e07436821fc7e9c22ab`；424 个计划文件逐字节一致。固定源码与所有人设版本的保留核验见 `evidence/P01/checkpoints/U05/preservation.json`。

## 当前限制

ContextPacket 尚未接入产品 Hook，当前没有产品启动入口或完整 Windows 发行包。Core 不存在，因此边界扫描是 NOT_RUN。预算使用完整 packet JSON 的 UTF-8 字节估计，不是模型 tokenizer 实测，也不包含原生宿主规则；descriptor 快照不是进程沙箱。U02 动态端口实测不能替代后续产品启动入口与候选包复验。

## 恢复入口

1. 在 `E:/Xiadie/Xiadie` 核对 `git status --short`、当前分支与 `p01-pause-u05`，读取 `evidence/P01/status.json`、U05 acceptance 和 checkpoint manifest；保留已有作者 worktrees 与 `.runtime` 试验资料。
2. 读取 `planning/Xiadie_V2_v1.1/tasks/P01-U06.md` 与 [恢复线索](P01-resume-notes.md)。先实现宿主 approved character / packet 预检和有效 Hook 回执，再用原生 mock 证明无效素材、超时、非零退出、坏 JSON、缺回执全部阻断模型调用；扩展禁用时保留原生 Runtime。
3. 原生 system / project rules / tool permissions 仍须保留。插件 `additionalContext` 为 user 层，不可直接赋予 system 权限；resume、compact 和临时 transcript 分别验证。
4. 按任务依赖继续 U07 至 U11 和 G01；不得自动进入 P02 或正式发布。模型默认 DeepSeek 官方 `deepseek-flash`，评测第二 ID `deepseek-v4-pro`；阶段已用 4/18 次初始小样本请求，预算沿用用户“无上限”，仅使用获授权人设与合成资料。

固定工具链 Node 24.14.0 / pnpm 10.33.2 / TypeScript 6.0.2 位于项目 `.runtime/P01/desktop-build-evidence/`。PATH 必须同时前置 `bin` 与 `toolchain/node-v24.14.0-win-x64`，避免嵌套 pnpm 落到全局版本。主目录验证的精确 argv、cwd、退出码与原始日志保存在 `evidence/P01/checkpoints/U05/root-validation/`；重现脚本在 `evidence/P01/checkpoints/U05/reproduction/`。

## 回滚与记录

仅撤 U05 时优先 revert 作者提交 `96457a2ef13e697e1877bcf23deb79578422a08e`，并另行修正执行状态与验收记录；不覆盖早期提交、角色版本、冻结计划或生产配置。主分支保留作者与整合历史，没有 force push、发布或数据迁移。本次 U05 没有启动 Desktop 或新增模型调用。
