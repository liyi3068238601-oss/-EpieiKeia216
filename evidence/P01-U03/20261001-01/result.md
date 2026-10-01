# P01-U03：最小 TypeScript 工作区

状态：`ready_for_review`。作者工作位于分支 `p01-u03`，基线为已接受 U02 的提交 `46099706bc6f2c041d7f0a704bbb7bd04635d6e6`。本单元未更新主工作树的执行状态。

## 实现

- 根 `package.json` 固定 Node `24.14.x`、pnpm `10.33.2` 与 TypeScript `6.0.2`；根 `tsconfig.json` 只编译 `packages/contracts/src/`。没有创建 pnpm workspace，也没有创建 Core 或运行时包。
- `packages/contracts/` 提供运行时无关的 `JsonValue` 类型和严格 `isJsonValue` 检查，拒绝非有限数字、循环、稀疏数组、访问器、符号键及非普通对象。
- `tools/check-import-boundaries.mjs` 使用 TypeScript AST/解析器递归检查 Core 可达的静态本地依赖，包括导入、重导出、import type、import-equals、动态 import 和 require。它拒绝 ZCode、DSH、Electron、`adapters/`、`.runtime/`、`references/`、绝对路径及 `file:` URL，并对计算出的 import/require 目标 fail closed。Core 中符号链接被明确报告为不支持。
- `tools/run-tests.mjs` 将 `P01-U03` 选择器映射到 Node 内置测试；未知选择器退出非零。`test:eval` 和 `test:e2e` 明确输出 `NOT_IMPLEMENTED` 并退出 2。
- 沿用了已有根 `.gitignore`，只添加根构建输出忽略规则。改动范围是根 package/lock/tsconfig/ignore 与 .gitattributes 字节保真映射、`packages/contracts/`、`tools/` 和本单元证据。

## 来源与差额

采用 U02 已接受的“固定 ZCode 原生 Runtime/Loop，保留有界 Core/Hook”方向，但 U03 不导入 ZCode、DSH 或 Electron。ZCode 固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（Apache-2.0）与 Herta 固定提交 `4623df120adf99340ce5f7e25ed829466975e3ae`（MIT 代码许可；角色资产排除）只作为既有架构决定来源；U03 没有复制两者代码或资产。测试使用 Node 内置 `node:test`，唯一开发依赖为 TypeScript `6.0.2`（Apache-2.0）。

执行书计划的 `tests/units/P01-U03.test.ts` 映射到 `packages/contracts/test/` 下的 Node 内置 unit、contract 和 integration 测试。扫描器的负例包括 Core 到本地 wrapper 再到 Electron 的传递重导出、传递进入 adapters、本地 TS path alias 指向 references、计算动态 import/require、file URL、Windows 绝对路径和位于 `.runtime` 下的合法 worktree 路径。

## 验证

固定工具链为 Node `v24.14.0`、pnpm `10.33.2`、TypeScript `6.0.2`。完整干净副本位于 `E:/Xiadie/Xiadie/.runtime/P01/clean-install-u03-20261001-03`，独立 pnpm store 位于 `E:/Xiadie/Xiadie/.runtime/P01/pnpm-store-u03-20261001`。安装使用 `pnpm install --frozen-lockfile --ignore-scripts --store-dir ...`；未安装或修改全局工具。

基础验证日志保存在 `logs/attempt-3/`；junction 修复迭代保存在 `logs/attempt-4/` 至 `logs/attempt-7/`；最终定向复核保存在 `logs/attempt-8/`：

| 命令 | 结果 |
| --- | ---: |
| 干净安装（冻结 lockfile、忽略生命周期脚本） | 0 |
| `pnpm run check`（attempt-3 与 attempt-8） | 均为 0 |
| `pnpm run build` | 0 |
| `pnpm run test:unit` | 0，3 项通过 |
| `pnpm run test:contract` | 0，1 项通过 |
| `logs/attempt-3/` 的 `pnpm run test:integration` | 0，9 项通过 |
| `logs/attempt-8/` 的 `pnpm run test:integration` 与 `-- P01-U03` | 均为 0，各 15 项通过 |
| 三个测试套件各自 `-- P01-U03` | 均为 0 |
| `pnpm run test:unit -- P99-U99` | 2，预期的未知选择器拒绝 |
| pnpm 简写 `pnpm test:unit -- P01-U03` / `pnpm test:unit -- P99-U99` | 分别为 0 / 2 |
| `pnpm run test:eval`、`pnpm run test:e2e` | 均为 2，预期的 `NOT_IMPLEMENTED` |

attempt-4 与 attempt-5 加入真实 Windows directory junction 负例，覆盖 Core 目录 junction、Core 内源码 junction，以及 Core 导入的本地 wrapper 再导入 junction（preserveSymlinks: true）；junction 指向 references/upstream 或 adapters 时均要求报告 SYMLINK_SOURCE_UNSUPPORTED。attempt-6 验证普通 pnpm-style node_modules 包 junction 可作为 external 接受。attempt-7 加入 canonical target 位于 references、adapters、.runtime 或禁 framework 路径时的 junction 负例。attempt-8 增加 canonical target 在仓库外、但 source 与 target 都含 node_modules 的真实 junction 负例，确认它不会被外部依赖例外吞掉；check 和两种 integration 命令均通过，15 项无 skip。check 的边界命令明确报告 BOUNDARY_SCAN_NOT_RUN: packages/core is absent。integration 测试证明的是 checker policy fixtures，不是产品 Core 已通过边界审计。logs/test-integration.* 保留了首轮 4/5 失败记录；attempt-3 的 9 项、attempt-4/5 的 12 项、attempt-6 的 13 项、attempt-7 的 14 项、attempt-8 的 15 项结果均保留在独立日志目录。首次 lock-generation 失败的原始 stdout/stderr 未能保留；观察到的错误文本、原因和记录缺口见 initial-failure-note.json，不提供伪造的原始日志 hash。

## 限制与回滚

目前没有产品 Core，因此没有真实 Core 导入图覆盖；当前边界结论仅限工具实现和合成 fixture。检查器是静态源码边界检查，不是运行时安全沙箱；任意 `eval` 或非静态字符串构造不在本单元证明范围内。`NOT_IMPLEMENTED` 的 eval/e2e 不能作为产品验收。

本单元不修改生产配置、密钥、模型或 Desktop，也不产生外部数据写入。需要回滚时只 revert 本作者提交；隔离 clean copy 和 pnpm store 位于 `.runtime/P01/`，不属于 Git 改动。

根 package/源码由 .gitattributes 的 -text 规则保留原始字节，证据沿用仓库 evidence/** -text 规则。本单元文件长度与 SHA-256 清单见 `manifest.json`；其自身 SHA-256 见 `manifest.sha256`。
