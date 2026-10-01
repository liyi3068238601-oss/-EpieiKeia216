# P00-U02：DSH SDK source fallback 隔离运行验证

状态：`ready_for_review`。已完成固定提交源码副本、隔离依赖安装、有效配置转储，以及 SDK initialize 的失败与恢复验证；没有发送 prompt 或调用模型。

路径修正：报告最初误写到 `docs/research/P00`；我先删除了该文件，再将报告写入本 evidence 目录。收到路径校验要求后，曾从本 evidence 文件重建一个同名临时副本，确认 SHA-256 一致后又精确删除。现在只保留本 evidence 报告，未触及已接受的 U01 文件。

固定官方仓库 `https://github.com/deepseek-ai/deepseek-harness.git`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`。从只读参考 checkout 用 `git clone --no-hardlinks` 建立 `.runtime/P00/dsh/source`；clone 的 HEAD 固定在该 commit，Git 工作树干净。没有操作 `D:\Deepseek Harness\deepseek-harness` 或生产 `C:\Users\liyi\.dsh`。

机器 Node 为 `v24.16.0`；仓库声明 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`。系统 pnpm `11.16.0` 未用于安装；从 npm 官方 registry 获取 pnpm `11.7.0` tarball，在 `.runtime/P00/dsh/tools` 内核验完整 SRI：`sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA==`。SHA-256 及下载 URL 见 `dsh-runtime-run.json`。

隔离 store/cache 下执行的安装命令：

```powershell
node E:\Xiadie\Xiadie\.runtime\P00\dsh\tools\bin\pnpm.mjs install --filter '@deepseek-ai/dsh-sdk-client...' --ignore-scripts --frozen-lockfile --store-dir E:\Xiadie\Xiadie\.runtime\P00\dsh\store --registry https://registry.npmjs.org
```

安装 exit 0，37 秒完成，锁文件 1,685 项通过 supply-chain 检查；过滤范围报告为 306/339 workspace projects，加入 1,127 个依赖包。`--ignore-scripts` 禁止 lifecycle scripts，因此没有执行 root postinstall；没有运行完整 build、native build 或测试。日志有一个可解释的 bin 链接警告：`apps/cli/lib/bin.js.EXE` 尚未构建。这是本轮 source fallback 的预期条件，不是安装失败。

## 隔离配置

PoC 使用独立 profile `sdk-minimal`、独立 `DSH_HOME` `.runtime/P00/dsh/dsh-home`，以及空的 `spikes/P00/dsh-runtime/workspace`。`spikes/P00/dsh-runtime/disable-tools.cordis.patch.yml` 把 `sandbox-policy` 设为 `read-only`，并禁用 Bash/PowerShell terminal provider、两个 persistent shell、`mcp-resources`、`jobs` 与 `timer`。bundle 自身的 `agent-loop.agents` 是空数组。固定 bundle 没有挂载文件、Web 或 subagent 工具；与 bundle README 的组成说明一致。合并后的 32 行 plugin 配置转储在 `dsh-runtime-config.yaml`，上述禁用行显示 `disabled: true`，sandbox mode 显示 `read-only`。

这证明合并启动配置里的能力行已被裁掉；因为没有发送 prompt，本轮没有要求模型枚举工具，也没有运行 sandbox 操作，不把它表述为运行时权限执行测试。SDK 的 `env` 参数完全替换子进程环境：使用隔离 `USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`DSH_HOME`，不包含 `HOME` 或父进程环境；`DEEPSEEK_API_KEY` 是假值。固定 DeepSeek adapter 确实读取 `DEEPSEEK_BASE_URL`，本次设为 `http://127.0.0.1:9`；只完成 initialize，没有发 API 请求，费用为 0。

配置转储命令显式带入 SDK source patch 和 PoC patch，exit 0；stderr 报 `typert-loader` patch entry not found。原因是 `sdk-minimal` 是独立完整 bundle，不含 `typert-loader` 行，而 SDK source fallback 会自动附加面向 CLI source 的 `sdk-source.cordis.patch.yml`。这条 warning 不影响转储或本轮 initialize。SDK client 把子进程 stderr 收入内部诊断缓冲区，不转发到外层日志，所以不能断言实际 initialize 子进程是否也产生同一 warning；原始配置转储 stderr 在 `dsh-runtime-config.stderr.log`。

## SDK launcher 结果

`spikes/P00/dsh-runtime/init-only.ts` 用固定提交的 `HarnessClient` 源码启动，不传 `dshBin`，所以走 SDK 默认 package manifest 解析和版本校验。CLI 与 SDK client manifest 都是 `0.2.0-rc.2`；`apps/cli/lib/bin.js` 不存在，而源码入口、source patch、CLI tsconfig 三个 fallback 文件都存在。SDK launcher 因而以 `node --import tsx/esm apps/cli/src/bin.ts` 启动 CLI 源码并设置 `TSX_TSCONFIG_PATH`；initialize 成功返回 serverInfo，实际验证了这条 fallback 路径。

| 用例 | Route | 观察结果 | 费用 |
|---|---|---|---:|
| 错误 route | `p00-u02-missing-provider` / `p00-u02-invalid-model` | 收到 `JsonRpcResponseError: no adapter registered for provider ...`；PoC 进程正常退出，exit 0 | 0 |
| 修正 route | `deepseek-official` / `deepseek-v4-flash` | `initialize_ok`，返回 `deepseek-harness-sdk-runtime` / `0.0.1`；关闭子进程后 exit 0 | 0 |

两个用例都只发 `initialize` 和关闭请求；`session/prompt` 从未调用。固定 server 代码在 initialize 中校验并解析 provider/model route、返回 `serverInfo`；只有后续 `session/prompt` 才懒创建 session 并排队消息。server test 也把 mock HTTP completion 请求数与 prompt 分开检查。本轮不把 initialize 成功写成模型成功、会话成功或业务输出成功。

辅助 TypeScript 文件第一次运行时，tsx 将它判作 CommonJS，因顶层 await 报 `TransformError`。在 spike 目录加本地 `package.json` 并声明 `type: module` 后，错误 route 与有效 route 两次均按预期结束。这是 PoC 文件模块类型设置问题，不是 DSH launcher 故障。

## 复现命令

```powershell
Set-Location E:\Xiadie\Xiadie\.runtime\P00\dsh\source
$env:USERPROFILE = 'E:\Xiadie\Xiadie\.runtime\P00\dsh\env\userprofile'
$env:APPDATA = 'E:\Xiadie\Xiadie\.runtime\P00\dsh\env\appdata'
$env:LOCALAPPDATA = 'E:\Xiadie\Xiadie\.runtime\P00\dsh\env\localappdata'
$env:TEMP = 'E:\Xiadie\Xiadie\.runtime\P00\dsh\env\temp'
$env:TMP = $env:TEMP
$env:PATH = 'C:\Program Files\nodejs;C:\Windows\System32'
$env:SystemRoot = 'C:\Windows'
$env:WINDIR = 'C:\Windows'
$env:TSX_TSCONFIG_PATH = 'E:\Xiadie\Xiadie\.runtime\P00\dsh\source\apps\cli\tsconfig.json'
node --import tsx/esm E:\Xiadie\Xiadie\spikes\P00\dsh-runtime\init-only.ts bad
node --import tsx/esm E:\Xiadie\Xiadie\spikes\P00\dsh-runtime\init-only.ts good
```

源码/PoC SHA-256、证据文件、exit code、安装来源和具体限制列在 `dsh-runtime-sources.json` 与 `dsh-runtime-run.json`。未验证 prompt/tool 输出、模型生成、审批交互、cancel/resume、完整 build、完整 test 或 sandbox 实际拒绝行为。
