# P01-U08 配置、密钥与无 Key Desktop 验证

U08 实现、path-boundary review fixes 和最终运行证据已整理为 ready for review。当前唯一主验收是 `ui/u08-no-key-1790940517353035900/summary.json`：隔离无 Key profile 下实际 Electron Desktop 连续启动两次，设置页和预置原生本机历史记录均可见；退出码 0，源码保持干净，生产文件未变更，没有发起模型请求。

## 配置与密钥

`packages/config/src/index.ts` 提供 version 1 profile、严格校验、portable 导入/导出、owned 路径解析和 child 环境构造。默认 profile 为 offline 且无 credential reference；只接受固定引用 `existing-zcode:deepseek-official`，模型 ID 为 `deepseek-flash` 与 `deepseek-v4-pro`。授权对象只按调用传入，不写入 profile 或 child env。

`packages/secrets/src/index.ts` 在调用父进程内存 resolver 前校验授权。offline、no-key、denied、缺失或不匹配引用都不调用 resolver。resolver 异常及 credential-use callback 的同步 throw/异步 reject 均转为固定错误，不保留异常 message、stack 或 cause。canary 测试只使用合成字符串，不涉及真实 Key、付费调用或 DSH。

owned 路径包含 `root`、`profileFile`、`home`、`data`、`temp`、`workspace`、`storage`、`userData`、`sessionData`、`appData` 和 `localAppData`。路径解析拒绝 junction/symlink 根与越界后代。child env 只继承 `PATH`、`SYSTEMROOT`、`WINDIR`、`COMSPEC`、`PATHEXT`；HOME、APPDATA、TEMP 和 ZCode 数据/存储/Desktop 路径均映射到 owned 根。HTTP endpoint 使用动态分配的非零 loopback 端口，拒绝 9229，并禁用固定远程调试端口。

## Desktop overlay 与审查修复

固定只读上游源码位于 `.runtime/P01/desktop-source`，commit 为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，许可为 Apache-2.0。`packages/config/desktop-build.mjs:13-59` 新增 `resolveDesktopBuildPaths`：先对 pinned source 做 `realpath`，将 destination 解析为最近已存在祖先的物理路径并补回缺失段，再用 `path.relative` 检查输出是否落入 source 树。它能识别 Windows 大小写变体与指向 source 的已有 junction；修复了原先大小写敏感 `startsWith` 检查可绕过的问题。`packages/config/test/desktop-build-paths.test.mjs` 覆盖同源、已有/待创建后代、case-variant、prefix-adjacent 同级目录和 junction ancestor。所有删除都限于 OS temp 下前缀匹配的本测试目录；测试从未写入真实 pinned source。

`packages/config/test/warmup.test.mjs:11-18` 现在通过 `P01_U08_ZCODE_SOURCE` 指定源码位置，默认使用 `.runtime/P01/desktop-source` 的明确绝对路径，并继续校验 commit 和 source bytes；从主 checkout 运行时不再把 `../../desktop-source` 错解析到 `E:\desktop-source`。

Desktop 启动补丁仍只更改内存中的一处调用：`zcodeAgentService.ts:3352-3375` 的 `initialize` 仅在 `isProviderNotReadyError` 命中时让 `getClient(params)` 回退到上游 `getReadOnlyClient(params)`，使用上游默认 `start-if-needed`。ready 路径和其他错误保持原逻辑。只读 helper 位于 `zcodeAgentService.ts:3097-3124`；模型和写入门禁仍在 `:3423-3428` 的 `createSession`、`:4430-4433` 的 `sendPrompt` 等路径调用 `getClient`。`desktop-build.mjs:75-96` 复用固定源码已有 main、preload、renderer、metadata、配置和 CLI 产物，复制 `LICENSE` 与 CLI notices，只重建 host；没有改动 reference source、main、renderer 或 preload。assembly 复用固定源码的 `node_modules` junction，仅供本机开发验证，不是可移植安装包。

## 最终 build 与真实 UI

最终 assembly 为 `.runtime/P01/u08-desktop-07/packages/desktop`。`desktop-build-07-command.json` 记录精确构建命令、cwd、exit code 和时长：Node 24.14.0 执行 `packages/config/desktop-build.mjs <desktop-source> <u08-desktop-07>`，cwd 为本 U08 worktree，exit 0，用时 63.985 秒。`desktop-assembly-07.json` 记录固定源码 commit、6638 个产物文件及逐文件 SHA-256；核验结果为全部 hash 匹配、source clean、recipe match。recipe SHA-256 为 `1b72f8b3660ffb0093e9ef1e272c26ac3b2e6d6439a065fbcc97f47cae6b6c0d`，assembly descriptor SHA-256 为 `0561ef2b728be014545a6ac2a76ccfeabc0b9905ae59badef252098b787bdce6`。较早 `desktop-build-06.log` 与 `desktop-assembly.json` 原样保留；因 path-boundary fix 导致 recipe 改变，它们不是当前验收产物。

最终 UI run `u08-no-key-1790940517353035900` 的 `summary.json` 保存精确命令、cwd 和退出码：Node 24.14.0 执行 `packages/config/test/desktop-no-key.mjs <隔离目录>/spec.json`，cwd 为本 worktree，exit 0，用时 43.109 秒。`ui-result.json` 记录两次实际 Desktop 启动，每次 settings 与预置 native history 均可见，监听端口为动态分配的 `127.0.0.1` 端口。摘要确认 `reference_source_clean=true`、`code_unchanged=true`、`production_unchanged=true`、`model_requests=0`、`real_credential_loaded=false`、`DSH_started=false`。这是 DOM/状态功能检查，没有视觉验收。

更早的 UI/build 证据都保留，没有覆盖旧日志。UI runs `1790937019718396400`、`1790937102850114400`、`1790937348691498000`、`1790938030377916400`、`1790938450902355500` 以 exit 1 结束，属于启动、seed 或迁移导航阶段的失败尝试。`1790938566650938700` 的功能检查虽通过，但发生在 source cache residue 被发现之前；`1790938916163132300` 的 UI 子结果通过且 exit 0，总摘要仍为 `passed=false`、`reference_source_clean=false`。`1790939126108911100` 是此前的 source-clean UI 通过轮次，现在已由新 recipe 下的 `1790940517353035900` 取代为唯一主验收。

两批早期 source-cwd 启动创建的 Windows `%SystemDrive%` 缓存均已移出 reference source，分别保存至 `.runtime/P01/u08-residue-20261002` 和 `.runtime/P01/u08-residue-20261002-02`；`runtime-residue-preservation*.json` 记录来源、目标、大小与 SHA-256。build-01 日志记录 tsup 无法解析相对入口 `src/host/index.ts` 和 `src/host/tasksStorageWorker.ts`，但没有保存 shell 命令、cwd 或数值 exit code。build-05 在源码清洁断言发现 `?? packages/desktop/%SystemDrive%/` 后提前停止，原失败日志保留。build-07 的构建命令/cwd/exit 已在专用 metadata 文件精确记录。

无 Key Claude migration scan/import 未通过本次验收，也不是本次要求的历史读取门槛。实际通过的是隔离 profile 中预置的原生历史读取。迁移入口可由 `OnboardingDialog.tsx:61-64, 192-208, 440-453` 到 `useClaudeSessionMigration.ts:138-155` 映射；导入经 `zcodeTaskServiceAdapter.ts:2654-2678` 调用 `createSession`，仍经过 provider `getClient` 写入门禁。报告不将该路径描述为已验证。

## 验证与限制

Node 24.14.0、pnpm 10.33.2、offline frozen install。最终验证命令在 U08 worktree 执行：

- `node.exe node_modules/typescript/bin/tsc --project tsconfig.json --noEmit`：通过。
- `node.exe --test packages/config/test/desktop-build-paths.test.mjs`：4/4 通过。
- `node.exe tools/run-tests.mjs unit P01-U08`：19/19 通过。
- `node.exe tools/run-tests.mjs unit`：53/53 通过。

warmup 行为测试调用真实 `patchReadOnlyWarmup`，从固定源码提取并转译 `initialize` 后验证 ready、不就绪和其他错误三条路径。`tools/check-import-boundaries.mjs` 报告 `packages/core` 不存在，因此没有可扫描的产品 Core import。guard 是 Node/Electron instrumentation，不是 OS sandbox；视觉验收、Claude migration、真实 Key 与模型请求均未执行。
