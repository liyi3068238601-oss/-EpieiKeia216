# P01-U02 隔离试验结果（进行中）

日期：2026-10-01。作者状态 `running`，未提交 `ready_for_review`，未独立接受。前置 U01 已接受。真实模型仍为零次，等待已经提出的 7877 传输方式选择；U03 和产品实现尚未开始，G01 未通过。

## 当前实际结果

| 试验 | 最新 run | exit | 结果 |
| --- | --- | --- | --- |
| 无 Key 原生控制面 | `no-key-1790855533337618800` | 0 | 空 Key Provider 设置与重启读取、SQLite 合成会话重开通过；不是 UI 历史展示 |
| 原生 Loop + 本机 mock | `mock-1790856351042829800` | 0 | 正常读、缺失读、越界 Hook 拒绝、junction 拒绝、compact、恢复、插件禁用均通过 |
| 实际 Desktop 两次启动 | `desktop-no-key-1790856449203452900` | 0 | 无 Key Skip、实际 SettingsPage、语言偏好保存与重启重读通过 |
| Desktop 启动端口复核 | 同上 | 0 | 第一次 63946/63948，第二次 63103/63105；只监听回环，均不与启动前已有端口重合，固定 9229 关闭 |
| 隐藏窗口截图/视觉验收 | 同上 | — | NOT_RUN，原生 capture 超时，不能称视觉通过 |
| 两个授权模型 | 未运行 | — | NOT_RUN，生成请求 0；用户已授权模型与预算，剩余问题是凭据传输方式 |

对应命令在项目根 `E:\Xiadie\Xiadie`：`python -X utf8 spikes/P01/run-no-key.py`、`python -X utf8 spikes/P01/probe.py mock`、`python -X utf8 spikes/P01/run-desktop-ui.py`、`python -X utf8 spikes/P01/verify-ports.py`。摘要保留具体 child command、cwd、exit code、输入/代码 SHA、原生输出与产物 SHA。`baseline.json` 绑定任务卡、U01 接受证据、当前人设及 Desktop 构建清单。

## 来源、采用与隔离

采用决定暂为 `docs/adr/P01-reuse.md` 中的 provisional：复用固定 ZCode 原生 Desktop/Provider/Loop/工具/SQLite 与官方 Hook；只增加有界角色接入和脱敏投影所需差额，不新增另一条自主 Loop。固定 bootstrap/runtime 接缝属于 private 工作区，不能称稳定公开 SDK。原生第一系统消息仍为 ZCode，真实角色表现尚待模型验证。

控制面/Loop 使用 P00 已有隔离构建，Desktop 使用另建的干净 checkout；固定提交均为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。Desktop 以 Node 24.14.0、pnpm 10.33.2、Electron 41.0.3 构建；全量 6643 产物/工具链绑定和实际构建日志在 `desktop-build/manifest.json`。首轮 runtime prepare 曾由 Corepack 选用 pnpm 12.8.1，修正固定 shim 后以 pnpm 10.33.2 重新准备与构建；旧记录保留。无打包发行验收；可选 ssh2 crypto addon 编译失败并采用 Node/JS fallback。

生产文件前后 SHA 一致；这项检查会只读生产配置、凭据文件、数据库及 Mofox TOML 的字节来计算 SHA，不解析或输出凭据，不把生产内容传给子进程。无 Key child 使用独立完整环境和 profile。Desktop Main/Host/Scheduler 均先加载测试 guard；记录一次 canary 拒绝、原生工具与设置操作，非 OS 网络沙箱。owned offline endpoint 返回 503，不向外转发。端口要求进入项目 `AGENTS.md`，未来产品入口继续落实；不改或停止本机已安装 ZCode。

模型转发代码包含父进程凭据内存、全阶段请求账本（初始 18 次）、跨进程锁、串行 relay 和工具结果续接约束；在传输决定明确之前拒绝读取实际模型凭据。当前配置端口的无认证 HTTPS metadata 探测不支持 TLS，选择待用户回复，详见 `evidence/P01/transport-decision.json`。不得用官方 DeepSeek 价格替代网关实际计费。

## 失败与修正证据

历史失败 run 逐次保留，未被最新 PASS 覆盖：Playwright 清除 NODE_OPTIONS 导致 guard 未加载；无 Key/onboarding UI 时序；窗口意外可见；BrowserWindow constructor 包装失败；隐藏 GPU/software/native capture 超时；Scheduler 入口 guard 未加载；白名单 PATH 中 PowerShell 不可达；重启后无 Key Welcome 仍显示。当前分别以启动 `-r`、原生入口等待、窗口方法拦截、原模块静态导入 guard、绝对 PowerShell 路径、每次启动明确 Skip 修正。截图仅记录 NOT_RUN。第一次工具验证遗漏订阅层回执，改用实际 `runtime.subscribeEvents` 后七种分支通过；恢复凭原生请求携带持久化 compact 摘要证明，未声称临时 Hook transcript 含完整历史。

## 剩余工作与回滚

确认传输方式后执行两个授权模型的少量原生只读路径，记录实际 usage、费用返回情况和失败/恢复边界；通过后收敛 ADR、来源采用决定和 diff，并向独立审查提交确切 author commit。目标 `tests/units/P01-U02.test.ts` 按现有框架映射为 `spikes/P01/README.md` 中的实际入口，不另造重复实现测试。

U02 未接受前不把后续依赖视为可用。回滚优先 revert 本单元提交；仅撤本单元文件，保留隔离失败 profile 与原始证据，不动冻结压缩包计划、接受的 P00、上游参考树、用户资料或生产配置。未知外部效果先核查，不自动重试。
