# P00-U01：DeepSeek Harness（DSH）复用调查

状态：ready_for_review；本轮 U01 静态调查已整理，尚未 accepted。
调查基准：官方仓库固定提交 639ed015397290b3745d163aafe02ffee4aa3f84。
范围：只读检查源码、测试、版本、构建入口、共享 Web adapter 和本机权限配置。未安装依赖、未构建、未启动 DSH、未执行测试，也未调用模型。

## 结论

官方 SDK 是客户端拥有生命周期的 DSH 子进程：TypeScript client 启动 dsh --profile sdk，通过 stdin/stdout 上按行分隔的 JSON-RPC 通信。适合下一阶段做隔离单次请求 PoC；它不是现有共享 Web profile 的 RPC client，也不能直接复用同一个共享会话。

固定提交的 wire 协议只有 initialize、session/prompt、shutdown 三个请求。没有按 prompt 取消、单 session 关闭、持久 session 恢复、服务端发起 approval 请求或独立 turn-complete 结果。session.status=idle 只表示 agent 当前空闲；messageId 是排队消息 receipt。两者都不能单独证明业务成功。高层 run() 将 receipt 与随后整体 idle 区间组合，并把区间内最后一条 root assistant 消息作为 finalResponse；README 提醒 steering、注入或重叠队列会影响归属，所以并发 prompt 下不能把它视作强因果结果。

本机正式 DSH 仓库为 D:\Deepseek Harness\deepseek-harness，版本 0.1.5-rc.2；固定 SDK checkout 版本为 0.2.0-rc.2。默认从 package manifests 解析 @deepseek-ai/dsh 时，SDK launcher 会校验 client 与 DSH 版本一致；显式传入 dshBin 会绕过该 manifest 版本校验。U02 必须核对实际启动的 CLI 版本并使用隔离源码或运行环境，不能未经核验直接指向当前本地 checkout。正式仓库有 5 个原有未跟踪文件，本调查未打开、修改或清理。

## SDK host 与协议入口

固定提交 packages/sdk/README.md:10-12 将协议描述为 stdio 上的 newline-delimited JSON-RPC。packages/sdk/protocol/README.md:30-46 和 packages/sdk/protocol/src/types.ts:15-119 给出 wire 面：

| 方向 | 方法 | 行为 |
|---|---|---|
| client → server | initialize | 校验并配置 provider/model route，返回 serverInfo；此时不创建 session |
| client → server | session/prompt | 使用请求携带的 sessionId；若该 id 尚无 session，则首次 prompt 时惰性创建 agent/session，再排队并返回 messageId |
| client → server | shutdown | 关闭整个 SDK host/runtime |
| server → client 通知 | session.event | 转发 DSH runtime 的 session/agent 事件 |
| server → client 通知 | session.status | 转发 running/idle 状态 |
| server → client 通知 | subagent.started、subagent.finished | 当前进程内的子代理生命周期事件 |

协议 README:50-52 将 messageId 定义为 durable queued-message identity；它不是 assistant 回复 id，也不是 turn 完成标记。README:113-115 明确列出 wire 缺项：没有协议版本协商、cancel、session-close 或 server→client request。类型定义中没有 approval/respond 请求。

packages/sdk/server/src/server.ts:95-129 转发全部 session event/status，不将事件绑定到一个 prompt 的 turn。initialize 在 :137-170 校验并配置 provider/model route，返回 serverInfo，不创建 session。session/prompt 在 :178-194 接收 sessionId；未知 id 由 :261-294 惰性创建 agent/session 后再排队并返回 receipt。请求分派在 :248-258 只接受上述三个请求。核心 API 自身有 ctx.agents.resume()（packages/core/agent/README.md:32-47），但 SDK server 没有暴露恢复已持久化 session 的 wire 方法。不能把核心内部 API 当成 SDK client 的 resume 能力。

## 响应、取消与 idle

packages/sdk/client/src/api.ts:176-224 的高层流程先等待匹配 messageId 的 inbox receipt，再收集到下一次整体 idle。结果组装在 :288-310：finalResponse 只是该区间最后一条 root assistant 消息文本，没有消息时为空字符串；它没有业务成功判定或 prompt→turn 的因果 id。

protocol transport 的 abort 只会从 client 删除 pending request 并拒绝等待方，不撤销 server 已排入 runtime 的工作（packages/sdk/protocol/src/transport.ts；测试 packages/sdk/protocol/tests/transport.spec.ts:73-83）。client/src/client.ts:177-184 说明没有 wire cancel，超时后服务端仍继续处理；:320-335 只是本地放弃请求；:383-410 的 close() 最终关闭整个 SDK runtime（EOF、SIGTERM、必要时 SIGKILL）。

因此，单次调用超时不等于 DSH 工作已取消；idle 不代表模型成功、工具执行成功或业务验收通过；SDK 暂无单 session/单 prompt cancel，关闭 client 会影响该 client 管理的全部工作；SDK wire 当前没有 resume。静态测试佐证：server/tests/server.spec.ts:352-372 覆盖 idle 转发但没有 turn-outcome 归属；client/tests/dispose.spec.ts:91-164 检查整个子进程退出流程。以上测试只读检查，没有执行。

## Approval 与真实权限

通用 JSON-RPC transport 支持 server→client request 和 handler，但当前 SDK server 不会发出该方向的 request；SDK 类型映射也只定义 client→server 的三个请求。因此当前 SDK host 没有 approval/respond 往返。server README:125-128 也列出缺少 per-prompt result、cancel 和 server 发起的 request。上游 approval subsystem 的 packages/interaction/user-approval/README.md:28-48 说明：ask 依赖已组合的 answerer；缺失 answerer 时结果为 unavailable 并 fail closed，approval service 自身不会弹出人类确认 UI；never 会拒绝。

SDK app profile（packages/bundle/sdk-app/README.md:12,26,32-47）继承 base。base README:50,70,88 和 cordis.patch.yml:225-273 显示默认工具能力涉及文件、shell、web、子代理；权限模式默认读取 DSH_PERMISSION_MODE 或 workspace-write，并按模式配置 approval。SDK profile 没有额外收紧为只读。静态检查未发现 SDK/base profile 配置了独立人类 approval answerer。U02 需检查实际权限与失败行为，不能假设会出现审批 UI。

本机只读检查 C:\Users\liyi\.dsh 下 Web profile 的 cordis.patch.yml、cordis.yml、settings.yaml 中 sandbox/approval/permission/preset/shell 相关配置标记，并检查当前进程、用户、机器范围的 DSH_PERMISSION_MODE。配置文件中未发现直接写入的权限模式覆盖，三个环境范围均未设置该变量。这不等于确认运行中 DSH 进程的有效权限；本轮没有启动进程。正式 profile 与凭据未改动；本清单没有保存任何 key/token 值或凭据引用。

## DSH_HOME 与启动版本约束

packages/sdk/client/src/types.ts:24-53 接受显式 dshHome 和 env。client/src/launch.ts:122-155 将 dshHome 设置到子进程 DSH_HOME 并启动 --profile sdk；默认 package-manifest 解析路径在 :55-65 校验 client 与 DSH 版本，显式 dshBin 路径则在 :128-135 绕过该校验。源码 fallback 在 :91-108 检查 CLI 源文件、profile patch 和 tsconfig，并通过 tsx/esm 启动。若 options.env 未提供，client 继承父 process.env；若提供对象，则它完整替代父环境。SDK client 自身不 scrub 环境；scrubbedParentEnv 是 dsh-subprocess 提供给调用方组合使用的 helper，client 不会自动调用。U02 应显式传入全新临时 DSH_HOME 和受控 env，不能读取或写入 C:\Users\liyi\.dsh。

内部 @deepseek-ai/dsh-subagent-dsh-sdk 是另一种隔离模式：README:28-56 要求绝对路径的独立 dshHome，每次 run 新启 DSH 进程；父子只传 cwd 与 route，不继承父对话，且不能施加工具过滤、深度、persona 或 schema。src/run.ts:233-254 使用脱敏父环境加显式 env；:316-359 的 AbortSignal 会 settle aborted 并关闭/杀死整个子进程。它为一次性子代理提供更明确的 abort/reap 行为，但不补足通用 SDK 的单 prompt cancel。对应 fake-child 测试位于 `packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts:513-521,652-660`，未运行。

## 源码 fallback 与完整构建入口

| 项目 | 只读观察 |
|---|---|
| 固定官方 checkout | E:\Xiadie\Xiadie\references\dsh-639ed015；HEAD 精确匹配固定 commit；detached、干净；remote 为 https://github.com/deepseek-ai/deepseek-harness.git |
| 固定源码版本 | 根 package 与 SDK packages 为 0.2.0-rc.2；Node engine ^22.19.0 或 >=24.0.0；packageManager 声明 pnpm@11.7.0 |
| 机器当前 DSH | D:\Deepseek Harness\deepseek-harness；HEAD c291e7961a515f6d7af9304e7fd1d257929aef26；master...origin/master；5 个原有未跟踪文件 |
| 当前 DSH 版本 | 0.1.5-rc.2；默认 package-manifest 解析若指向此版本会拒绝；显式 dshBin 会绕过版本校验 |
| 工具链 | Node v24.16.0；已安装 pnpm 11.16.0，与 manifest 的 11.7.0 不一致；Git 2.54.0.windows.1 |
| 构建痕迹 | 当前 checkout 有 .dsh-build/client-build-environment.json（254 bytes，时间 2026-09-10 23:12:45 +08:00）；只确认文件存在，不视作本轮构建通过 |
| 本轮执行 | 未运行 pnpm install、build、test、SDK、DSH |

SDK client 没有专用的 SDK build 命令。源码 fallback 不是完整 DSH 构建：默认 package 解析先校验 SDK client 与 @deepseek-ai/dsh 的 manifest 版本一致；built bin 缺失时，只有当 apps/cli/src/bin.ts、apps/cli/src/sdk-source.cordis.patch.yml、apps/cli/tsconfig.json 均存在，才会以 Node --import tsx/esm 启动 CLI 源码，并将 TSX_TSCONFIG_PATH 指向 apps/cli/tsconfig.json。显式 dshBin 会绕过 manifest 版本校验，调用方需自行核对该二进制版本。

源码 fallback 仍要求 tsx/esm 可解析，并且 monorepo workspace 依赖可解析。tsx 是根 package.json 的开发依赖；apps/cli/tsconfig.json 继承根 tsconfig.base.json 并引用 workspace 项目，为源码加载提供路径解析配置。它不是无需依赖的独立 CLI。是否能在全新 checkout/安装状态下直接启动，本轮未运行验证。

scripts/build.ts 的 --profile 选择的是完整构建期间使用的 public client artifact environment，不是 dsh --profile 的 runtime profile；scripts/client-build-environment.ts 只接受默认值或 official，sdk 会因 unknown profile 被拒绝。因此 pnpm exec tsx scripts/build.ts --profile sdk 不是有效 SDK build 命令。根 package.json 的默认完整构建入口是：

    pnpm run build

该命令依次运行 build:native-system、build:lib、build:web 并写入完整 client build record；build:official 也运行完整构建，只将 client artifact environment 选为 official。没有证据表明存在 SDK-only build。构建入口会先移除旧的 build record。根 package.json:208 的 postinstall 调用 scripts/install-lefthook.mjs；脚本 :711-723 会改 Git core.hooksPath 并安装/更新 hooks。因此本轮没有安装依赖或构建。若 U02 走源码 fallback，仍需在隔离副本准备 workspace 依赖；若必须构建，应先评估 install/postinstall 对工作树的影响。
## 共享 Web adapter 与许可边界

本机 adapter checkout 位于 D:\Mofox\插件\dsh_adapter\work\extracted\dsh_adapter，HEAD 4d833cf8a7eb14e7fa012e5d83e4b7475d79d83c，版本 1.1.0，package manifest 标为 UNLICENSED，根目录没有 LICENSE。README/API 描述共享 Web profile、本地 HTTP/WebSocket、任意 unary RPC、CLI/process 管理、事件路由和 DSH_HOME 数据路径；API 列有 session.cancel 等 RPC。adapter 能将 approval 事件路由给 actor 并处理单次响应；client.py 不把 rpc catalog 当运行时 allowlist，所以 catalog 是描述而非访问控制。兼容范围只是 README 自述，本轮未实测。

官方 SDK client 每个 client 管独立 DSH 子进程、stdio、sdk profile 和独立 DSH_HOME；adapter 连接已有共享 Web service，经 HTTP/WebSocket 和 router/actor approval 传递事件。adapter 可作为行为参考，但因标为 UNLICENSED 且没有许可证文本，本轮结论是不复制其代码；若以后确要使用实现，先取得明确许可。官方 DSH 根许可证为 MIT；复用官方 SDK 源码须保留版权与许可证，并另行遵守依赖包许可。

## U02 建议方案（NOT_RUN）

1. 在项目内新建一次性目录，例如 E:\Xiadie\Xiadie\scratch\P00-U02\run-<id>，创建全新显式 dshHome；确认其不指向 C:\Users\liyi\.dsh。
2. 使用固定 SDK 源码及同版本 CLI，或在显式 dshBin 时先独立核对 CLI 版本；SDK 默认 package-manifest 解析会校验版本，显式 dshBin 则绕过校验。cwd 指向空的 disposable workspace，设置专用 env。
3. 先用 mock provider 验证进程与协议主流程。任何真实模型调用前，必须用隔离 profile/patch 实际裁剪文件、shell、web、subagent 等工具，并检查最终发给模型的工具集不含这些工具；prompt 写着“不要用工具”不构成权限限制。完成该检查后，再由主控使用已授权 gateway 7877 和模型 route [基元]deepseek-flash 执行一次串行短 prompt，要求精确可检查的返回内容。记录脱敏启动参数、SDK 版本、JSON-RPC 时间线、messageId、assistant 内容和退出状态；验收检查真实 assistant 内容，不能仅看 receipt、idle 或非空 finalResponse。
4. 单独观察 timeout/abort 后子进程是否仍工作，以及 close() 是否结束整个子进程；不把本地 abort 宣称为服务端取消。
5. approval/respond 与持久 session resume 作为明确能力缺口记录；若产品必须提供这些功能，再设计独立 host 协议或受控 Web adapter 实验。

未测项：gateway generation、SDK integration、CLI/profile 启动、approval UI/answerer、cancel、resume、权限运行时探针、构建、测试、安装、ComfyUI/GPU 操作。以上只是 U02 建议，不是已验证结果。

来源文件、精确 SHA-256、commit、URL 和行号见同目录 evidence/P00-U01/20261001-01/dsh-sources.json。
