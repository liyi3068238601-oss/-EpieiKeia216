# Xiadie V2

当前仅执行 P00 来源与可行性基线，尚未开始产品实现。

项目根：`E:/Xiadie/Xiadie`。权威计划为 `planning/Xiadie_V2_v1.1/`，从原始 v1.1 ZIP 解压并逐文件核验 SHA-256；计划副本保持不变。

- 当前任务：P00-U01 来源调查，执行状态见 `evidence/P00/status.json`。
- 研究产物：`docs/research/P00/`。
- 单元证据：`evidence/<task-id>/<attempt-id>/`。
- 固定源码参考：`references/`，不纳入 Git，禁止修改生产工程和配置。
- 试验随后在 `spikes/` 与独立 `.runtime/` 数据根进行；G00 通过后才开放 P01。

计划结构验证：`python planning/Xiadie_V2_v1.1/tools/validate_plan.py`。该命令不验证产品或 Runtime。
