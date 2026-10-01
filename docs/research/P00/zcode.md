# P00-U01：ZCode 来源调查

日期：2026-10-01。作者状态：`ready_for_review`；尚未独立接受。本报告只调查来源和接缝，不代表兼容性、运行或产品验收通过。

## 调查范围与结论

固定源码锚点为 `zai-org/ZCode` commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，只读副本位于 `E:\Xiadie\Xiadie\references\zcode-29628c9`，工作树干净、HEAD 完全匹配。另检查了本机 `D:\ZCode`：这是带 `resources\app.asar` 的安装版，不是 Git 仓库，版本 `3.14.4.7912`；因此不能把安装版行为归因于固定源码提交。上游源码的版本信息为 3.14.3 系列。固定来源文件 SHA-256、行号和状态见同目录 evidence 文件 `evidence/P00-U01/20261001-01/zcode-sources.json`。

候选主路线是固定版本 CLI 的官方插件 Hook，加一个很薄的产品适配层来保存/呈现产品状态。官方 Hook 比直接改 ZCode Runtime 或嵌入整套应用更容易隔离、替换和验收。备用路线是在宿主侧调用 ZCode 已有的 Project Memory 服务做项目记忆列表/读取；当前入口不等于可写持久存储，也不能替代主会话生命周期钩子。当前代码还不能证明桌面安装版会在所有 agent 会话触发插件 Hook，须按固定提交做独立 PoC 后再选型。

## 固定提交提供的入口与隔离

仓库 README 给出的最小 CLI 开发入口是：

```powershell
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

前一命令会构建 `@zcode/cli` 及 workspace 依赖；CLI 包本身以 `src/main.ts` 为 dev 入口、`scripts/build.mjs` 为 build 入口，输出 `dist/zcode.cjs`（根 README 第 82、113–122 行；`apps/zcode-cli/packages/cli/package.json` 第 6–23 行；`src/main.ts` 第 1–70 行）。`--prompt/-p`、`--cwd`、`--mode`、`--resume`、`--continue` 和 `--prepare-storage` 均在参数表中注册（`src/arguments.ts` 第 30–80 行）；`--mode` 可取 `build/edit/plan/yolo`（`src/run.ts` 第 136–140 行）。CLI README 的 npm starter 段落不是当前 monorepo 脚本清单：当前包实际声明 `build/dev/typecheck/lint`，没有 `test` script。

隔离数据基目录用 `ZCODE_DATA_BASE_DIR`。固定源码将它解析为 `{base}/.zcode`，并在其下放 v2 应用配置；默认回落到 `HOME`/用户主目录（`packages/services/src/paths.ts` 第 9–12、28–55 行；根 README 第 59–63、128–135 行）。CLI provider runtime 也从同一变量解析数据基目录（`apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` 第 60 行），共享凭据路径依赖该根（`apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts` 第 280–289 行）。因此 `--cwd` 只选择项目工作目录，不隔离用户配置或凭据；PoC 必须同时把进程级 `ZCODE_DATA_BASE_DIR` 指到一次性目录，并使用一次性 `--cwd`。不要从生产 `.zcode` 复制凭据；如果 PoC 要发模型请求，另需显式注入已批准的独立配置。此 U01 不发生成请求。

固定 README 锁定 Node `24.14`、pnpm `10.33.2`（根 README 第 14–32 行；`mise.toml`）；这是仓库要求，不代表本机工具链已实测。最小 build 命令、`--help`、TypeScript 检查和测试均为 `NOT_RUN`。`pnpm bootstrap` 会安装 workspace 依赖、更新 submodule 并准备 desktop runtime（README 第 24–32 行，`scripts/bootstrap.mjs` 第 161–180 行），对验证 CLI Hook 来说范围过大，不作为 U02 的默认入口。

## Hook 路线及边界

固定源码的 Hook runner 可接收生命周期事件，并把 `additionalContext` 作为 `hook_context` 系统提醒附件投影进会话；总长度有 24,000 字符截断（`apps/zcode-cli/packages/core/src/runtime/methods/hooks.ts` 第 15、109–157 行；`runtime/methods/turn.ts` 第 237、422 行，恢复路径见 `runtime/methods/resume.ts` 第 261 行）。它是上下文补充，不是无限历史仓库，也不是授权机制；超限内容会被截断，PoC 应使用显式的小型摘要并在宿主保留完整事实来源。

兼容层会将临时 `transcript.jsonl` 写入 OS temp 目录并把路径传给 Hook，Hook 完成后递归清理目录（`core/src/hooks/configured-runner-input.ts` 第 25–65 行；清理在 `configured-runner-callback.ts` 第 66、111 行）。因此 Hook 收到的是本次回调的临时输入，不应假设它是稳定、完整、可长期引用的对话档案。Hook 成功返回的 context 和阻断结果在 `configured-runner-callback.ts` 第 123–153 行归一化；非零退出默认会降级继续，退出码 2 才作为阻断结果处理。若产品必须 fail-closed，不能把普通脚本错误当成可靠拒绝；要由宿主侧验证 Hook 结果并为超时、崩溃、拒绝分别验收。

当前官方文档（2026-10-01 读取，动态文档）说明 project hooks 会被忽略、user hooks/plugin hooks 可用，并要求在新会话生效；与固定提交工作树配置能力之间可能存在版本/发布差异。官方文档不是固定提交兼容承诺。U02 推荐采用用户隔离配置中的官方插件模板，不依赖项目级 Hook 信任行为，并记录 CLI 与桌面各自的触发结果。另有上游 Issue #32 报告 user/plugin Hook 未在桌面原生 agent session 触发，issue 已关闭为 not planned；这是用户报告而非复现结论，仍需本机验证。

插件会以配置的命令运行，属于代码执行边界；只在独立副本与隔离数据根加载经检查的插件，禁止从工作区或不受信任目录自动加载未审查代码。Plugin Hook 配置/发现入口见官方插件文档和固定提交 `apps/zcode-cli/packages/adapters/src/plugins/{index,hook-sources,plugin-components}.ts`。

## 记忆、子代理与最终工具集

固定提交已有 Project Memory 与 agent persistent memory 两套能力。Project Memory 服务提供项目作用域列表/读取；稳定读取和路径映射仍须在产品侧核对，写入需要另找受控服务入口（`packages/services/src/memory/memoryService.ts`、`projectMemoryStableRead.ts`；`core/src/memory/project-root.ts`、`runtime/helpers/project-memory.ts`、`context/sections/memory.ts`）。子代理 persistent memory 则把文件索引与提示词注入子代理上下文（`core/src/subagent/persistent-memory.ts` 第 90–105 行；`persistent-memory-prompt.ts` 第 9、108–110、151–167 行）。

有两个容易误判的安全接缝。第一，打开 persistent memory 时会把 `Write` 和 `Edit` 加入 agent profile 的工具配置（`persistent-memory.ts` 第 10、43–55 行）；最终子代理工具仍经过 allowlist/disallowlist 与 runtime 注册投影（`runtime/methods/subagent.ts` 第 131–141、275–328、497–534 行；`runtime/helpers/runtime-tools.ts` 第 81–85 行），不能只检查配置文件中的 `allowedTools` 就认定只读。第二，读取 `MEMORY.md` 时 `catch` 会把不存在和不可读都折叠为空索引（`persistent-memory.ts` 第 94–100 行）；目录创建失败还只会记录 debug 级日志。U02 必须分别测试缺文件、拒绝访问、目录不可写，并核对最后实际投影给模型的工具集；这类失败不能被当成“正常空记忆”。

## U02 PoC 设计（未执行）

建议先用 CLI host 和官方插件模板，在一次性 `ZCODE_DATA_BASE_DIR` 与 `--cwd` 下验证，不改 `D:\ZCode` 或 `C:\Users\liyi\.zcode`。在真正调用模型前，先用可观察的 `UserPromptSubmit` 阻断分支确认 Hook 已触发、宿主收到阻断、模型请求计数为 0；如果不能证明请求为零，立即停止。之后再分开跑：

1. **成功**：SessionStart/UserPromptSubmit 传小型版本化 context；确认它出现在正确会话、未混入另一个项目，记录 Hook 输入/输出路径、退出码和模型请求计数。
2. **失败**：Hook 超时、普通非零、退出码 2、坏 JSON、缺/不可读 MEMORY.md、memory 根不可写；确认各状态被区分、没有悄悄退化成允许越权或静默空记忆。
3. **恢复**：清除一次性坏状态后重启独立会话；确认宿主恢复、历史与摘要仍由持久层提供，临时 transcript 已清理，工作区/全局配置/真实凭据未变化。

最低通过证据：固定提交、构建产物哈希、隔离根实际路径、CLI 和桌面 Hook 分别触发结果、每种分支的退出/阻断状态、最终工具投影、模型请求数、恢复后目录哈希对照。U01 未构建、未启动 CLI、未安装插件、未运行测试、未执行 PoC、未发生成请求。`D:\ZCode` 二进制与 app.asar 的哈希见 evidence；本地 v2/CLI 生产数据根只盘点存在性，没有读写内容。

## 许可、测试与决定

固定仓库根 `LICENSE` 标明 Apache License 2.0（第 2–4 行、190–194 行，版权行标为 Copyright 2026 Z.AI Co., Ltd）。`NOTICE.md` 第 68–70 行明确第一方代码适用 Apache-2.0，并提醒该许可不自动覆盖第三方软件、复制代码、原生二进制、字体、图标及其他资源；License 第 90–114 行要求再分发时附许可、标注修改、保留适用声明和 NOTICE 归属。第三方依赖须另外检查 `THIRD-PARTY-NOTICES.md` 和上游许可。本调查没有复制或移植源码；如需复制，另记原路径、原 commit、许可和修改。

对固定副本执行文件名检索：`rg --files references/zcode-29628c9 | rg "\\.(test|spec)\\.(ts|tsx)$"`，命中 4 个 TypeScript 测试文件：`packages/services/test/providerConfigMigration.test.ts`、`packages/services/test/nonCliAcpRetirement.test.ts`、`packages/services/test/importedClaudeRecovery.test.ts`、`packages/ui/test/nonCliAcpRetirement.test.ts`。没有 Hook、插件、CLI 生命周期或 persistent-memory 工具投影的专门测试文件名。测试未运行；build/install scripts 未运行，也未启动产品。只有源码浏览、固定 commit 和哈希检查可记 `READ`/`VERIFIED`；构建、CLI Hook、桌面集成、PoC 和真实模型结果均 `NOT_RUN`。7877 `/v1/models` 的 HTTP 200 和默认模型存在性由本阶段主控记录在 `evidence/P00-U01/20261001-01/gateway-metadata.json` / `model-inventory.json`；那是元数据查询，不是生成验收。

候选决定：U02 先验证 CLI 官方插件 Hook 路线，UI/Project Memory 仅作为薄适配及备用；若桌面 Hook 不触发，暂停桌面集成结论，比较宿主服务侧适配，不将该差异解释成 Hook 工作成功。此候选决定供独立审查，不等于 U02 开工授权或 accepted。
