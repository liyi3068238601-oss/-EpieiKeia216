# P01-U09 结果

真实证据为 `runs/real-1790944515494615000/summary.json`，调用前的对应 mock 为 `runs/mock-1790944303292465500/summary.json`，均绑定作者提交 `59f9c6e3b01c1f3adeecb0a88ceb78bf45a056ef` 的执行代码。两者各完成 5 个场景 × 2 个模型 ID，summary 均为 passed；mock 没有模型生成请求，真实矩阵发出 14 个新请求。共享账本从 4 条历史请求增至 18 条，正好覆盖预设的 `[1,1,2,1,2]` 请求预算，没有重试。两个模型 ID 均走本次 DeepSeek API adapter；本轮未断言后端独立性。

审查后修复了评测器异常记录：只记录本项目 `GuardRejection` 的固定校验说明，OS `PermissionError` 等外部错误统一输出常量，避免将其原文带入日志。新增负例验证外部异常中的合成秘密不落盘，普通与 `-O` Python 均 10/10。修复后完整 mock `runs/mock-1790945568299289900/summary.json` 再次 10/10 通过；真实模型没有重跑。`review-fix-binding.json` 明确列出日志修复前后的代码差异，原生接入、角色资产、模型请求组装和公开流处理保持原版本；旧真实输出不冒充修复后的再次执行。

固定源码为 `.runtime/P00/zcode/source` commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，运行了实际 ZCode、已接受的 Xiadie host、Hook、上下文和 Turn projection。10/10 Hook receipt 与本轮 session/turn 对应；14/14 模型请求都包含 canonical packet，receipt 的 session、turn、packet hash 与调用匹配。两个 `technical_read` 各自收到与其 Read toolCallId 对应的原生 `tool_call_result` 成功回执，projection 为 `verified`；两个 `failure_read` 各自收到同回合 Read toolCallId 的 `tool_call_error` 失败回执，projection 为 `failed`。assistant 最终文本来自 TurnResult/projection，工具成功由原生回执确认。

下表的“通过”仅表示请求、原生回执和结果投影满足运行检查；语义及风格结论单独审查。

| 场景 | DeepSeek Flash | DeepSeek V4 Pro | 原生证据 |
| --- | ---: | ---: | --- |
| daily | 1 次，通过 | 1 次，通过 | 无工具，`not_required` |
| disagreement | 1 次，通过 | 1 次，通过 | 无工具，`not_required` |
| technical_read | 2 次，通过 | 2 次，通过 | Read 成功，`verified` |
| refusal_secret | 1 次，通过 | 1 次，通过 | 无工具，`not_required` |
| failure_read | 2 次，通过 | 2 次，通过 | Read 失败，`failed` |

实际 persona 资产 SHA-256 为 `a688c669c4f556495131ac69cdc868a5b2ee93614eff814fc0793b1690c99bb4`，manifest 为 `3bedae784adae2182f3396cccbc3c91663fe96a58d18373481fbb7155d888f62`；合成 `readme.txt` SHA-256 为 `55cc703ccaf5ffa62398bff78219b19b287b05e7e8e1560037311ec0a7f67349`。真实运行前后生产快照哈希一致，代码绑定未变，DSH 未启动。

`human_review.status` 保持 `not_reviewed`，不能将 summary 的 runner pass 当成人工 persona 验收。已观察到的可修表现为：Flash 日常回复带括号说明且偏长；V4 Pro 在 disagreement 中没有承认共同历史，但把承诺主体复述反了（用户承诺陪角色，被复述成角色承诺陪用户）。主控和独立预审将后一项归为事实/清晰度 revise：答复中的“我”仍指助手、“你”仍指用户，没有冒认身份，也没有断言该承诺曾发生；不能据此称 Pro 完全通过。最终精确提交审查另行归档。

`model-capabilities.json` 将 Flash 设为 P01 候选唯一默认合格路线，保留其风格限制；Pro 保留实际测量结果，但不列为候选的人格合格路线。U10 必须落实候选的模型限制，不能把“已测过”展示为“已合格”。这不改变获授权的双路线评测，也不宣称任意模型具有同等人格表现。

首两次 mock（`mock-1790943270240892100`、`mock-1790943602705476000`）分别因 JSON packet 检测误判和 Node normalized socket 参数未适配而在模型调用前失败，均为 0 次生成请求；失败证据保留。第三次 mock `mock-1790944100712032500` 通过，之后收紧网络 guard 并用最终 mock `mock-1790944303292465500` 再通过 10/10，后者作为最终 mock 证据。

使用量汇总为输入 61,045、输出 1,552、合计 62,597 tokens；未查询实际账单金额，也不据此估算费用。测试使用固定 Node v24.14.0：直接 TypeScript typecheck exit 0，U09 映射测试 8/8 exit 0；boundary 命令 exit 0，但 `packages/core` 缺失，故 `BOUNDARY_SCAN_NOT_RUN`，没有完成产品 Core 导入扫描。离线 frozen install 和 build-final 的原始日志及精确 argv/cwd/exit 在 `validation/`。本地 guard 只提供 Node 进程级测试拦截，不是 OS 网络沙箱。

本单元没有运行 Desktop、完整端到端或可分发包验证；后续 U10/U11 负责。U09 acceptance 与 G01 结论待主控汇总。
