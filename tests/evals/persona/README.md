# P01 原生人格基线评测

本机 Windows 开发入口。先按仓库固定的 Node 24.14 / pnpm 10.33.2 安装并构建 Xiadie；固定 ZCode 源码及其依赖必须已存在于主项目 `.runtime/P00/zcode/source`。本阶段沿用已有 Python 3.12 + httpx 环境，不安装全局工具。

在当前 Xiadie checkout 执行：

```powershell
python -X utf8 -m unittest discover -s tests/evals/persona -p test_relay_guards.py -v
node tools/run-tests.mjs unit P01-U09
python -X utf8 tests/evals/persona/relay.py mock
```

`mock` 用真实原生 ZCode Runtime、已接受的角色 Hook 和实际 Read 工具，只替换模型响应；新建隔离 profile 和动态 loopback 端口。它不读取真实 Key、不发起付费请求。运行输出最后给出 `summary.json` 路径。

真实评测显式执行：

```powershell
python -X utf8 tests/evals/persona/relay.py real --mock-evidence '<刚通过且代码绑定一致的 summary.json 绝对路径>'
```

真实入口校验现有 P01 授权、官方 TLS 路由、当前 mock 代码绑定、共享互斥锁和剩余次数。固定两条获授权 model ID，各跑日常、分歧、技术、拒绝和失败五类场景，共最多 14 次生成请求；含工具续答，且发出前记账。18 次初始额度耗尽后拒绝执行，不能靠重新运行或删账绕过。传输失败或未知结果保留证据并停止，不自动重试。

凭据只在父进程内存中按需读取；子进程只使用本机中继的合成占位值。评测发送的是已批准的精简角色资产及合成文件，没有原始 Mofox 配置。模型输出和原生回执分别保存，隐藏推理字段不保存。`rubric.md` 给出人审标准；未发生真人评阅时保持 `human_review=not_reviewed`，独立代理审查另列。两个模型 ID 不代表已证实两个独立后端。

默认绝对路径绑定本次开发环境；这是阶段评测入口，不是可分发安装器。所有旧失败尝试保留在相同证据目录的不同 run ID 下，最终报告明确选择用于验收的那一轮。
