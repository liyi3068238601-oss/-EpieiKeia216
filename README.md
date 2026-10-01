# Xiadie V2

当前执行 P01「最小骨架与遐蝶角色」，P00 / G00 已验收。P01-U01 来源调查与 P01-U02 隔离试验已独立验收；最小 TypeScript 工作区正在独立 worktree 中实现，尚未完成整个 P01 / G01。

项目根：`E:/Xiadie/Xiadie`。权威计划为 `planning/Xiadie_V2_v1.1/`，从原始 v1.1 ZIP 解压并逐文件核验 SHA-256；计划副本保持不变。

- 当前进度：`evidence/P01/status.json`；已冻结的 P00 基线见 `evidence/P00/status.json`。
- 研究产物：`docs/research/P00/`、`docs/research/P01/`。
- 单元证据：`evidence/<task-id>/<attempt-id>/`。
- 固定源码参考：`references/`，不纳入 Git，禁止修改生产工程和配置。
- 试验在 `spikes/` 与独立 `.runtime/` 数据根进行；生产 ZCode、Mofox 与 DSH 配置保持独立。

默认采用固定版本 ZCode 的原生 Runtime / Loop 与 Hook；Xiadie 补充角色资产、分层上下文与执行证据。采用决定和试验范围见 `docs/adr/P01-reuse.md`、`evidence/P01-U02/20261001-01/acceptance.json`。这不是稳定公共 SDK 的承诺，也不是完整发行包。

P01 模型路线已切换到 DeepSeek 官方接口，默认 `deepseek-flash`，评测另使用 `deepseek-v4-pro`。授权和请求额度记录见 `evidence/P01/authorization.json`；真实凭据不得写入仓库、证据或配置导出。角色采用用户审核的精简版，所有版本的保留记录见 `docs/research/P01/persona-versions.json`。

桌面启动使用独立数据根与系统分配的 loopback 端口，禁用原生固定 9229；不得停止或改动本机已安装 ZCode 来腾出端口。产品启动入口将在相应实现任务验收后提供。

计划结构验证：`python planning/Xiadie_V2_v1.1/tools/validate_plan.py`。该命令不验证产品或 Runtime。
