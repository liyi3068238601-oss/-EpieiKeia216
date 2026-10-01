# P00-U01 本地初步发现

日期：2026-10-01。此文件是来源调查输入，P00-U03 正式盘点仍须在前置通过后执行。

## 本轮实查

- 启动时工作区仅有两个 ZIP，没有 Git 或产品源码。v1.1 解压后 423 个 manifest 文件的大小与 SHA-256 全部匹配，计划结构验证 PASS。
- 用户要求迁移至 `E:/Xiadie/Xiadie`。迁移前后 9,143 个文件、188,936,024 字节全部通过 SHA-256 核对；详细记录见本次证据目录 `relocation.json`。初始 `baseline.json` 中原路径保留为历史证据。
- `D:/ZCode` 是桌面安装目录，有 `ZCode.exe` 和 `resources/app.asar`，不是源码 checkout。
- DSH 本地源码位于 `D:/Deepseek Harness/deepseek-harness`，有 `.git`、`node_modules` 和 `.dsh-build`；来源调查负责者另核分支、提交、脏状态和版本。
- `C:/Users/liyi/.zcode`、`C:/Users/liyi/.dsh` 是现存生产数据根；仅只读调查，试验必须独立数据根。
- `E:/Xiadie/Xiadie-next` 与历史 `F:/test/dsh-comfyui-ctl` 路径当前不存在。不据此推断其它位置没有副本。
- Node 24.16.0、pnpm 11.16.0、Python 3.12.10、uv 0.11.16 可用。它们是本机现状，不代表已满足各固定提交工具链。

## 模型配置

只读元数据由 `inventory-runtime.py` 提取；只输出白名单字段和凭据存在布尔值，不复制凭据。
ZCode 配置中存在官方 DeepSeek `deepseek-flash` / `deepseek-v4-pro` 和内嵌凭据；DSH 存在 7877 网关四个模型配置。配置存在不证明账户额度、网络或模型请求已经跑通。

最初用户授权先查询可用配置，再确认具体模型和费用上限。曾提出官方 `deepseek-flash` 候选：最多 12 请求，10 万输入 / 1.2 万输出 token，预算 0.05 USD。该候选未采用；官方价格不能用于 7877 网关计费。原提案价格来源：https://api-docs.deepseek.com/quick_start/pricing/ 。

## 尚未取回的历史资料

计划 U01/U02 引用的 Library 原始文档未在当前包提供。E 盘按精确文件名候选检索无匹配，但 WindowsApps 无访问权限，不能宣称全机不存在；可访问 Pages 的首轮列表为空，也不构成全部 Library 搜索。范围暂以 v1.1 冻结需求为准，P00-U05 必须明确这些历史来源的核查限制。

## 历史经验只作检索线索

记忆记录提示 DSH 默认全局数据根、共享实例 ledger 竞争，以及 Windows 单进程 terminate 不保证回收子进程。本轮必须从当前源码与真实隔离试验复验，不能将旧 PID、端口或安装版本视作现状。

## 模型授权更新

用户选择 7877 网关，随后答复预算“无上限”。采用本机 DSH 已配置默认模型 `[基元]deepseek-flash`，通过 7877 网关；费用不预设总上限，试验仍按具体用例小样本执行并记录实际 usage。GET /models 已返回 200 并确认默认模型存在；U01 时尚未发生成请求。
