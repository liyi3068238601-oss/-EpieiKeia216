# P01 复用路线（作者提交独立验收）

状态：`ready_for_review`。P01-U01 已接受；U02 控制面、实际 Desktop 无 Key 设置、原生 Loop/mock 及两个官方 DeepSeek model-ID 的只读路径均通过。独立审查接受 U02 后才放行 U03；此 ADR 不代表 P01/G01 通过。

继续采用 G00 冻结的路线：**ZCode 为唯一主 Runtime/Loop，Xiadie Core 提供角色资产、有界上下文与脱敏证据投影；DSH 只接受明确工作包委托，Herta 只借鉴许可允许的结构。** 本次不默认启动 DSH/Dream。

| 采用内容 | 实际证据 | 边界与未验证项 |
| --- | --- | --- |
| 固定 ZCode 官方插件 manifest/Hook、Provider、Loop、工具 executor、SQLite | mock 七个分支；Flash/Pro 各两次真实模型请求，原生 Read 及角色回复通过 | bootstrap/runtime 为固定工作区内的 private 接缝，不宣称稳定公开插件 SDK；第一系统身份保留 ZCode，真实回复采用用户批准的遐蝶人设；完整人格评测仍在 U09 |
| 固定 ZCode 原生 Desktop、renderer/preload、Host 与 Scheduler | `summary-no-key-ui.json` 两次启动的设置页与原生文件语言偏好 | 隐藏 DOM 功能验证，截图 NOT_RUN；尚未在 Desktop 界面打开本地历史记录 |
| 现有确定性文件系统适配与权限校验 | native `Read` 成功、缺失失败、Hook 拒绝越界、realpath 拒绝 junction | 仅合成 fixture 只读，未放行写文件、Shell 或真实用户资料 |
| 用户批准的 Mofox 精简人设 v3 | `persona-versions.json` 与用户选择 | 所有版本保留；用户保留游戏背景，不称原创角色，不推定公开分发权利 |
| 有界 Hook packet 与原生事件订阅 | 临时 transcript 有界派生，`subscribeEvents` 实际工具回执 | Hook 临时 transcript 是单事件内容，恢复由原生持久化摘要证明，不称完整历史 Hook 可读 |

所需最小差额为：角色版本加载、ContextPacket 校验、固定 bootstrap 薄宿主装配、脱敏回复/证据投影和独立配置入口。关键 PoC 已通过，没有证据支持重写自主 Loop 或把三套工程硬融合。后续实现复用这条已实测接缝。

用户把模型路线改为 DeepSeek 官方；使用 `https://api.deepseek.com`，`deepseek-flash` 和 `deepseek-v4-pro`。四次生成请求全部成功，生产配置前后 SHA 相同。旧 7877 授权与传输状态保存为历史，不再使用其 HTTP 路线。官方新闻说 Pro 可能重定向 Flash，而当前定价/模型列表仍列两 ID；只确认两个真实 model-ID 路线，底层后端独立性未确认，不称不同后端能力对照。

端口决定：用户要求与本机 ZCode 分离。关闭上游开发模式固定 9229；试验服务使用回环动态端口，启动前后检查已有监听集合。此次两次 Desktop 启动通过；后续产品启动必须落实该要求。全局 ZCode 配置和进程保持原样。

来源：ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（Apache-2.0），官方插件文档固定 `c94279c9a449235fd5991f7903a6c7e4fdc3ab7e`；Herta `4623df120adf99340ce5f7e25ed829466975e3ae`（MIT 代码，排除角色资产）；DSH 固定 `639ed015397290b3745d163aafe02ffee4aa3f84`，本单元未新增 DSH 代码。具体来源与读取范围沿用已接受的 `docs/research/P01/native-reuse.md`。未移植 Herta 角色素材。

允许路径映射：试验代码在 `spikes/P01/`，构建与 profile 在忽略的 `.runtime/P01/`，证据在 `evidence/P01-U02/20261001-01/`，状态在 `evidence/P01/`。只读参考树、压缩包计划与接受的 P00 证据不改。回滚优先 revert 本单元提交；隔离数据与失败证据保留，未知外部效果先核查，不盲目重试。
