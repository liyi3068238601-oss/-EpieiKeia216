# P01-U08 配置、密钥与无 Key Desktop 验证

U08 实现与验证材料已整理到可独立审查状态。最终 UI 验收唯一指向 `ui/u08-no-key-1790939126108911100/summary.json`：实际 Electron Desktop 在隔离无 Key profile 下启动两次，设置页和预置的原生本机历史记录均可见；进程退出码为 0，源码保持干净，生产文件未变更，未发起模型请求。

## 配置与密钥模块

`packages/config/src/index.ts` 提供 version 1 profile、严格校验、portable 导入/导出、owned 路径解析和 child 环境构造。默认 profile 为 offline 且没有 credential reference；只接受固定引用 `existing-zcode:deepseek-official`，官方模型 ID 为 `deepseek-flash` 与 `deepseek-v4-pro`。授权对象只在每次调用时传入，不写入 profile 或 child env。

`packages/secrets/src/index.ts` 在调用父进程内存 resolver 前校验授权。offline、no-key、denied、缺失或不匹配引用都不调用 resolver。resolver 异常和 credential-use callback 的同步 throw/异步 reject 都转为固定错误，不保留异常 message、stack 或 cause。canary 测试仅使用合成字符串，不涉及真实 Key、付费调用或 DSH。

owned 路径包含 `root`、`profileFile`、`home`、`data`、`temp`、`workspace`、`storage`、`userData`、`sessionData`、`appData` 和 `localAppData`。路径解析拒绝 junction/symlink 根与越界后代。child env 仅继承 `PATH`、`SYSTEMROOT`、`WINDIR`、`COMSPEC`、`PATHEXT`；HOME、APPDATA、TEMP 和 ZCode 数据/存储/Desktop 路径均映射到 owned 根。HTTP endpoint 使用动态分配的非零 loopback 端口，拒绝 9229，并禁用固定远程调试端口。

## Desktop overlay 与来源

固定只读上游源码位于 `.runtime/P01/desktop-source`，commit 为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，许可为 Apache-2.0。`packages/config/desktop-build.mjs:11-24` 在构建内存中只改写 `packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `initialize`：仅 `isProviderNotReadyError` 命中时，原有 `getClient(params)` 才回退到 `getReadOnlyClient(params)`；后者使用上游默认 `start-if-needed`。ready 路径和其他错误保持原逻辑。`packages/config/desktop-build.mjs:35-55` 复用固定源码已有 main、preload、renderer、metadata、配置及 CLI 产物，复制上游 `LICENSE` 与 CLI notices；`:67-83` 只重新构建 host 并对目标源码做单点 overlay。没有修改 reference source，main、renderer、preload 均未改。该产物复用固定源码的 `node_modules` junction，仅供本机开发验证，不是可移植安装包。

上游调用映射：`packages/services/src/zcode-agent/zcodeAgentService.ts:3352-3375` 是被覆盖的 `initialize`。只读 helper 位于 `:3097-3124`。模型和写入门禁仍由 `:3423-3428` 的 `createSession`、`:4430-4433` 的 `sendPrompt` 等路径调用 `getClient`；overlay 不更改它们。`packages/config/test/warmup.test.mjs` 从固定 commit 的 Git blob 读取原文、校验工作树文件字节一致，调用实际 `patchReadOnlyWarmup`，转译并执行真实 `initialize` 方法，覆盖 ready、不就绪、其他错误三条路径。

build-06 证据位于 `desktop-build-06.log` 与 `desktop-assembly.json`。实际 UI 使用 `.runtime/P01/u08-desktop-06/packages/desktop`；清单记录 6,638 个产物文件、固定源码 commit、main/renderer/preload 未变、recipe SHA-256 `147548e7664c7fe65826ec1910af76a8279215fa4375253d611bda01294bd9e3`。随证据保存的 assembly descriptor SHA-256 为 `f601ff1f9193b879c5b6048345bc931eb1a5d4a5f2e8471761ad2e00e16a78c2`。

## 最终真实 UI 验收

唯一主验收记录为 `ui/u08-no-key-1790939126108911100/`。`summary.json` 保存精确命令、cwd 和退出码：Node 24.14.0 执行 `packages/config/test/desktop-no-key.mjs <隔离目录>/spec.json`，cwd 为本 U08 worktree，exit 0，用时 43 秒。`ui-result.json` 记录两次真实 Desktop 启动；每次 settings 与预置 native history 都可见，监听地址为 `127.0.0.1` 动态端口。摘要确认 `reference_source_clean=true`、`code_unchanged=true`、`production_unchanged=true`、`model_requests=0`、`real_credential_loaded=false`、`DSH_started=false`。这是 DOM/状态功能检查，没有视觉验收。

早期运行日志保留在各自的 `ui/` 子目录，没有覆盖或删除。运行 `1790937019718396400`、`1790937102850114400`、`1790937348691498000`、`1790938030377916400`、`1790938450902355500` 以 exit 1 结束，属于启动、seed 或迁移定位阶段的失败尝试。`1790938566650938700` 的两次 UI 功能检查通过，但它是源码缓存残留被发现之前的结果，不能作为最终 clean-source 验收。`1790938916163132300` 的 UI 子结果通过且 exit 0，但总摘要 `passed=false`、`reference_source_clean=false`，同样不通过最终门槛。`1790939126108911100` 才是源码清洁核验后的最终通过轮次。

两批由早期 source-cwd 启动创建的 Windows `%SystemDrive%` 缓存均已移出 reference source，分别保存到 `.runtime/P01/u08-residue-20261002` 与 `.runtime/P01/u08-residue-20261002-02`；`runtime-residue-preservation*.json` 记录了来源、目标、文件大小与 SHA-256。最终 build 和 UI driver 以独立 assembly 为 cwd，因此最新 summary 的 source clean 检查为 true。build-01 的日志记录 tsup 对相对入口 `src/host/index.ts`、`src/host/tasksStorageWorker.ts` 解析失败；该日志没有记录 shell 调用行或数值退出码。build-05 在 builder 的源码清洁断言发现 `?? packages/desktop/%SystemDrive%/` 后提前停止；原失败日志保留。build-06 日志记录 tsup 成功和 assembly descriptor，但没有独立的 shell 命令、cwd 或退出码字段；实际加载该产物的最终 UI 命令、cwd、退出码均在最终 `summary.json` 中。

无 Key Claude migration scan/import 没有通过本次验收，也不是本次要求的历史读取门槛。实际通过路径读取的是隔离 profile 中预置的原生历史记录。迁移入口可由 `OnboardingDialog.tsx:61-64, 192-208, 440-453` 到 `useClaudeSessionMigration.ts:138-155` 映射；导入经 `zcodeTaskServiceAdapter.ts:2654-2678` 调用 `createSession`，仍会经过 provider 的 `getClient` 写入门禁。报告不把该路径描述为已验证。

## 验证命令与限制

以下命令在 U08 worktree 执行，记录为通过；Node 固定为 24.14.0：

- `node.exe node_modules/typescript/bin/tsc --project tsconfig.json --noEmit`
- `node.exe --test packages/config/test/warmup.test.mjs`（3/3）
- `node.exe tools/run-tests.mjs unit P01-U08`（15/15）
- `node.exe tools/run-tests.mjs unit`（49/49）

`tools/check-import-boundaries.mjs` 报告 `packages/core` 不存在，因此没有产品 Core import 可供扫描。真实 UI 与上述模块/单元测试覆盖本次 U08 范围；Claude migration、视觉设计验收、真实 Key 和模型请求均不在通过范围内。
