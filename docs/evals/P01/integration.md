# P01 集成验收边界

P01 的目标是固定 ZCode 上可运行的角色、一次只读工具和诚实失败。权威范围见冻结计划 `planning/Xiadie_V2_v1.1/01_项目计划书.md` 的 P01 段和 U10/U11 任务卡。此文记录测试入口和证据层级；阶段是否通过，以 `evidence/P01/status.json` 及精确版本的独立验收为准。

## 测试入口

使用项目固定的 Node 24.14.x、pnpm 10.33.2 和已有 Python 3.12 环境；运行前固定 ZCode 源码、依赖和本地候选必须已存在。

```powershell
pnpm run check
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run test:eval
pnpm run test:e2e -- --candidate '<候选 assembly 的绝对路径>' --suite full
pnpm run test:e2e -- --candidate '<同一候选 assembly 的绝对路径>' --suite degradation
```

`test:eval` 使用 U09 的真实原生 Runtime + 本地模型 mock 矩阵。`test:e2e` 使用真实 Electron/renderer、输入框和按钮，经原生协议和 Runtime 到本地 mock。两者默认不读真实 Key、不发起付费请求。真实评测另有显式授权入口，受已有账本及调用上限约束；当前初始 18 次请求已用完，U10/U11 不再增加。

Python guard 补充检查：

```powershell
python -X utf8 -m unittest discover -s tests/evals/persona -p test_relay_guards.py -v
python -O -X utf8 -m unittest discover -s tests/evals/persona -p test_relay_guards.py -v
```

## 阶段需求与证据

| 需求 | 已接受的实现和证据 | 集成时必须补足 |
| --- | --- | --- |
| R01 身份和表达 | U04 批准 v3 资产和版本保留；U05 ContextPacket；U06 Hook/回执门禁；U09 两个真实模型 ID 的五类样本 | 最终候选的身份资产绑定、实际普通消息和工具路径；不能把 mock 文案称为真人格评测 |
| R02 主工作边界 | U01/U02 复用决定；U06 原生 Loop；U07 原生终态投影 | Desktop 保持原生主回复；关闭扩展后的原生对话；不启动 DSH/Dream |
| R03 先查再试 | 固定上游 commit、采用决定、独立单元验收 | 候选代码/资源 hash、命令和精确版本独立审查 |
| R05 会话和流式 | U06/U07 成功、失败、取消、partial、resume 原生测试；U08 历史读取 | 实际 Desktop 发送、读取成功/失败、取消后新回合恢复 |
| R06 模型和降级 | U08 独立配置与凭据桥；U09 能力矩阵 | Flash-only 候选资格、Pro 拒绝、无 Key/离线可解释降级 |
| R13 来源和预算 | U05 分层来源及保守 UTF-8 packet 上限；U09 API usage | 确认候选同一模型调用链应用已验证 packet；完整宿主 tokenizer 预算器属于后续 P04 |

## 结果的适用范围

U09 真实矩阵的 10 格运行成功，仅证明五类场景在两个指定 ID 上实际执行。Flash 在此范围内获得候选资格，仍有冗长和元评论的修订项；Pro 在分歧场景反转承诺双方，保留原始输出并暂不开放为人格候选。独立代理审查与真人审阅分开，真人审阅仍为 `not_reviewed`。两个 ID 使用同一 DeepSeek API adapter，不声明两个独立后端。

DOM 功能验证不等于视觉验收。本地开发 assembly 依赖固定源码的依赖目录，不等于可分发安装器。U07 投影若以 sidecar 保存，不能称为界面已经显示自定义证据卡片。边界扫描在 `packages/core` 尚未建立时明确返回 `BOUNDARY_SCAN_NOT_RUN`，不能称为 Core 依赖边界已实扫。

## 路径映射

U10 任务卡中的测试目录落在 `tests/integration/P01/`；根级 `package.json` 和 `tools/run-stage-tests.mjs` 只负责将执行书要求的 `test:eval`、`test:e2e` 从占位命令映射到实际 runner，不引入新测试框架。证据统一由 U10 最终清单绑定，冻结计划保持不变。
