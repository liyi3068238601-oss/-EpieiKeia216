# P01 复用路线（待真实模型试验和独立验收）

状态：`provisional`。P01-U01 已接受；U02 的控制面、实际 Desktop 无 Key 设置和原生 Loop/mock 试验通过。两个已授权的 7877 模型尚未调用，传输方式待用户回复。此 ADR 不放行 U03，也不代表 P01 或 G01 通过。

继续采用 G00 冻结的路线：**ZCode 为唯一主 Runtime/Loop，Xiadie Core 提供角色资产、有界上下文与脱敏证据投影；DSH 只接受明确工作包委托，Herta 只借鉴许可允许的结构。** 本次不默认启动 DSH/Dream。

| 采用内容 | 实际证据 | 边界与未验证项 |
| --- | --- | --- |
| 固定 ZCode 官方插件 manifest/Hook、Provider、Loop、工具 executor、SQLite | `summary-mock.json` 的七种正常/故障/恢复分支 | bootstrap/runtime 为固定工作区内的 private 接缝，不宣称稳定公开插件 SDK；原生第一系统身份仍为 ZCode，真实角色一致性待验证 |
| 固定 ZCode 原生 Desktop、renderer/preload、Host 与 Scheduler | `summary-no-key-ui.json` 两次启动的设置页与原生文件语言偏好 | 隐藏 DOM 功能验证，截图 NOT_RUN；尚未在 Desktop 界面打开本地历史记录 |
| 现有确定性文件系统适配与权限校验 | native `Read` 成功、缺失失败、Hook 拒绝越界、realpath 拒绝 junction | 仅合成 fixture 只读，未放行写文件、Shell 或真实用户资料 |
| 用户批准的 Mofox 精简人设 v3 | `persona-versions.json` 与用户选择 | 所有版本保留；用户保留游戏背景，不称原创角色，不推定公开分发权利 |
| 有界 Hook packet 与原生事件订阅 | 临时 transcript 有界派生，`subscribeEvents` 实际工具回执 | Hook 临时 transcript 是单事件内容，恢复由原生持久化摘要证明，不称完整历史 Hook 可读 |

所需最小差额为：角色版本加载、ContextPacket 校验、固定 bootstrap 薄宿主装配、脱敏回复/证据投影和独立配置入口。当前没有证据支持重写自主 Loop 或把三套工程硬融合。U02 真实模型角色路径若失败，保留反例再决定最小修补。

端口决定：用户要求与本机 ZCode 分离。关闭上游开发模式固定 9229；试验服务使用回环动态端口，启动前后检查已有监听集合。此次两次 Desktop 启动通过；后续产品启动必须落实该要求。全局 ZCode 配置和进程保持原样。

来源：ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（Apache-2.0），官方插件文档固定 `c94279c9a449235fd5991f7903a6c7e4fdc3ab7e`；Herta `4623df120adf99340ce5f7e25ed829466975e3ae`（MIT 代码，排除角色资产）；DSH 固定 `639ed015397290b3745d163aafe02ffee4aa3f84`，本单元未新增 DSH 代码。具体来源与读取范围沿用已接受的 `docs/research/P01/native-reuse.md`。未移植 Herta 角色素材。

允许路径映射：试验代码在 `spikes/P01/`，构建与 profile 在忽略的 `.runtime/P01/`，证据在 `evidence/P01-U02/20261001-01/`，状态在 `evidence/P01/`。只读参考树、压缩包计划与接受的 P00 证据不改。回滚优先 revert 本单元提交；隔离数据与失败证据保留，未知外部效果先核查，不盲目重试。
