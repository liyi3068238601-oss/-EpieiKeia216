# P01-U10 作者结果（candidate-06 / final-04）

**作者结论：`ready_for_review`，尚非 `accepted`。** candidate-06 的 full Desktop suite 6/6 场景通过，check、unit 与 e2e-full 均 exit 0。U10 实现已提交供精确独立审查；根级状态和 G01 gate 仍以 `evidence/P01/status.json` 为准，本文不改写状态，也不提前开始 U11。

## 基线、产物与实现范围

基线为 `1dee2d18b684f602aa6dacd3f6049f35cf14d262`。candidate-06 由代码提交 `82298c735dfbc4f278b5e920d79be7a83f979b55` 构建；descriptor SHA-256 为 `25f92e7604b41479fdcdd9dcc089afe0ce6441db4586a7f7e7614805632a8907`，CLI bundle SHA-256 为 `56bc58a658d938b9090e6004b1ab3cc4ab4ec32ed1c1b6e2138aeb2676cce44d`。构建命令和 descriptor 绑定见 [commands-06.json](builds/commands-06.json) 与 [candidate-descriptor.json](builds/u10-candidate-06/candidate-descriptor.json)。运行命令及场景证据见 [final-04 commands](validation/final-04/commands.json) 和 [final-04 summary](validation/final-04/ui-full/summary.json)。

U10 的产品接缝只在固定 ZCode bootstrap protocol entry 上做 build-time factory 替换：复用 native app、provider registry、model adapter、runtime、CLI 和 invocation-context 单例；U06 host 接管身份门禁，U07 的 turn/tool 投影写入私有 sidecar。renderer 的主回复、输入框、发送和停止操作保持 ZCode 原生路径，没有新增回复证据面板。`tests/integration/P01/` 包含候选构建、factory、真实只读工作区 port、Electron/CLI 网络 guard 和 Desktop runner；根 `package.json`、`tools/run-tests.mjs`、`tools/run-stage-tests.mjs` 只映射命令到实际入口。

与基线比较，U10 没有修改 `packages/`、`assets/`、`plugins/`、`tests/evals/persona/`、`pnpm-lock.yaml` 或 `tsconfig.json`。builder 验证候选实际输入与 Git blob，并在 descriptor 绑定源版本、资源 hash、CLI bundle 和唯一 invocation-context。只读文件口使用固定 native filesystem 方法和物理路径边界；网络 guard 覆盖 Electron 主进程、utility 与 CLI 子进程，但它仍是进程 instrumentation，不是 OS sandbox。参考源码固定为 ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，按 Apache-2.0 使用并保留上游许可/NOTICE；参考源码树未修改。角色资产沿用项目已接受的 v3 资产，保留原有来源限制，不据此主张额外发行权。

## 验证结果

使用 Node `v24.14.0`、pnpm `10.33.2`。final-04 在作者 worktree `E:\Xiadie\Xiadie\.runtime\P01\worktrees\u10` 执行：`pnpm run check` exit 0；`pnpm run test:unit` 79 项通过、exit 0；`pnpm run test:e2e -- --candidate E:\Xiadie\Xiadie\.runtime\P01\u10-candidate-06 --suite full --output E:\Xiadie\Xiadie\.runtime\P01\validation\u10-final-04\ui-full` exit 0，用时 168.255 秒。确切 argv、cwd、耗时和日志 hash 见 `validation/final-04/commands.json`。

| 场景 | final-04 | 实际结果 |
| --- | --- | --- |
| `success` | 通过 | 真实 Desktop 普通输入和原生回复，经本地 loopback mock |
| `read_success` | 通过 | 原生只读工具读取成功并返回结果 |
| `read_failure` | 通过 | 缺失文件被报告为失败，没有伪报成功 |
| `cancel_recovery` | 通过 | 实际 Stop 后再次发送并收到“已恢复。”；cancelled 投影来自原生 terminal event |
| `disabled_native` | 通过 | 候选 gate 关闭后 native 普通回复成功；原生 auxiliary-title 请求也按固定 SDK 的实际形状接受 |
| `pro_denied` | 通过 | `deepseek-v4-pro` 不可选，模型请求数为 0 |

final-04 共记录 9 个 parent-owned loopback POST、0 个外部请求；DSH-like 子进程为 0，进程树检查已验证，`production_unchanged=true`、`execution_unchanged=true`。辅助标题的本地 wire capture 以固定 `@ai-sdk/openai-compatible 2.0.60` + `ai 6.0.193` 验证 `generateText` 发出的 body keys 为 `max_tokens/messages/model`，其中 `stream`、`tools` 和 `tool_choice` 均缺省。final-03 的 relay 曾把缺省 `stream` 派生为 false 并拒绝请求；candidate-06 已修正接受精确 wire 形状，final-04 中对应 auxiliary-title POST 返回 200。capture 记录见 [command](validation/title-sdk-capture/command.json) 和 [wire output](validation/title-sdk-capture/stdout.jsonl)。

为让隔离场景在拒绝时只尝试一次，final-04 test harness 显式设置 `ZCODE_MODEL_RETRY_MAX_RETRIES=0`。这是本地 offline 验收参数，不代表或改变生产默认重试策略。所有 UI 场景均没有真实 API Key：portable profile decision 为 no-key，native provider 使用仅指向 loopback relay 的合成 placeholder。该配置证明的是受控 mock 场景，不是官方 Desktop 生产认证或付费链路。

另有基线回归 `baseline-regression/result.json`，在 wrapper commit `4d67560605cf3b79e9437528a78b2ab6198af5a1` 运行：contract 5、integration 41、Python guards 10、mock eval 10 均通过。它不是 final-04 提交上的完整重跑。由于 accepted `packages/`、`assets/`、`plugins/`、`tests/evals/persona/`、`pnpm-lock.yaml` 和 `tsconfig.json` 相对 P01 基线未改，这些数字可作为未变前置输入的补充证据；U10 自身以 candidate-06 exact commit 上 check、79 项 unit 和 6 格 full run 为准。

## 许可、模型与未覆盖范围

U09 已用完预先批准的 18 次官方模型调用预算（历史 U02 4 次生成 + U09 14 次）；U10/U11 没有新增真实模型调用或付费请求。candidate 的 synthetic key 只服务于受 guard 限制的动态 loopback relay。U09 实测 `deepseek-flash` 与 `deepseek-v4-pro`，只有 Flash 获得候选资格；Pro 的 persona 评测不合格，U10 的 picker 拒绝场景通过。人工角色审阅仍为 `not_reviewed`。

final-04 主交互以真实 Desktop DOM、输入框、按钮和原生对话路径验证；视觉验收为 `NOT_RUN`。用户在窗口中看到 ZCode 原生回复；turn/tool receipt 通过 sidecar 提供宿主核验，不是 renderer 中的回复证据面板。产物是依赖固定源码和本机依赖的隔离 assembly/candidate，不是安装器、可移植发行包或已发布软件。边界检查仍为 `BOUNDARY_SCAN_NOT_RUN`（`packages/core` 尚不存在）。

U08 已接受的无 Key Desktop 证据覆盖隔离 profile 中 Settings 打开与预置 ZCode 原生历史读取；它不声称完整无凭据 UI 状态展示。candidate-06 的 U10 full scenarios 虽没有真实 Key，但 native provider 仍装配 synthetic loopback 配置。后续专门的 no-key 验收应核验 owned 配置为空、relay 请求为 0、真实 UI 历史 marker 可见且 Settings 可打开；不得将该验收计划写成已通过，也不得将 U08/ZCode 历史说成 P02 持久化。P02 尚未启动，Xiadie 应用级持久层尚未实现。

作者结果为 `ready_for_review`。U11 尚未执行，G01 仍待独立审查/阶段 gate 决定；本文不把作者 full run 通过写成 G01 pass。