# P01-U02 隔离试验

这些脚本验证固定 ZCode 原生接缝，尚不是 Xiadie 产品实现。前置 P01-U01 已接受；本单元仍为 `running`，真实模型路线未运行，不能用于放行 P01-U03。

固定 ZCode 提交：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`。控制面与 Loop 使用已有 P00 隔离构建；Desktop 使用独立 `.runtime/P01/desktop-source`。Node 24.14.0、pnpm 10.33.2、Electron 41.0.3、Playwright Core 1.59.1。Desktop 全量产物与构建日志绑定在 `evidence/P01-U02/20261001-01/desktop-build/manifest.json`。

在 `E:\Xiadie\Xiadie` 执行：

```powershell
python -X utf8 spikes/P01/run-no-key.py
python -X utf8 spikes/P01/probe.py mock
python -X utf8 spikes/P01/run-desktop-ui.py
python -X utf8 spikes/P01/verify-ports.py
python -X utf8 spikes/P01/verify-continuation.py
python -X utf8 spikes/P01/verify-transport-gate.py
python -O -X utf8 spikes/P01/verify-transport-gate.py
```

| 实际入口 | 验证范围 | 当前结果 |
| --- | --- | --- |
| `run-no-key.py` / `no-key.mjs` | 原生无 Key Provider 设置、SQLite 合成会话的关闭与重读 | PASS，独立控制面，不是 Desktop 历史界面 |
| `probe.py mock` / `host.mjs` | 原生 Provider、Hook、Loop、只读工具；正常、失败、越界、junction、compact、恢复和禁用 | PASS，模型响应为本机 mock |
| `run-desktop-ui.py` / `desktop-ui.mjs` | 实际 Desktop 无 Key Skip、设置页、语言保存与第二次启动重读 | PASS，隐藏窗口实际 DOM；截图与视觉验收 NOT_RUN |
| `verify-ports.py` | 复核两次启动的监听端口、代码与证据 hash、Main/Host/Scheduler guard、生成包装入口 | PASS，只读已有运行证据，不启动应用 |
| `verify-continuation.py` | 分片 Read、未知工具、重复 ID、流未完成、伪造工具结果、错 phase/ID/事件等 13 个反例 | PASS，合成守卫验证，不是模型路线通过 |
| `verify-transport-gate.py`（普通及 `-O`） | 待确认传输状态在读取凭据、启动 Runtime 和访问网络前终止 | PASS，受监控操作均为 0，不是模型路线通过 |
| `probe.py real 0` / `probe.py real 1` | 获授权的两个 7877 模型完成原生 `Read` 和角色回复 | NOT_RUN，等待已提出的传输方式选择 |

启动端口遵循用户要求：Desktop 必须设置 `ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1`，由 Playwright 分配 inspector/CDP 的端口 `0`；试验 relay 和 offline HTTP endpoint 也绑定 `127.0.0.1:0`。启动前记录已有监听端口，实际监听后核对无重合。不得停止或修改已安装 ZCode 来让出端口。未来产品启动入口需要继续落实相同隔离要求。

Desktop 测试使用完整白名单环境及独立 home/userData/sessionData/dataRoot。Main 和实际 Host/Scheduler 入口先加载应用层网络 guard；本地 offline endpoint 固定返回 503，不转发请求。这不是 OS 网络沙箱。隐藏窗口截图会超时，保留 `NOT_RUN`，不以 DOM 结果冒充视觉验证。

真实模型凭据只允许父进程在传输方式明确后读取到内存；不写入子进程配置、环境、日志或 Git。全阶段初始请求上限 18 次，用跨进程锁、串行 relay 和持久化请求账本控制；未知请求结果不自动重试。网关费用以实际返回为准，不套用 DeepSeek 官方价格。当前生成请求为零。

授权与传输前置使用显式条件检查，不能被 Python 优化开关移除；实际 integration probe 要求开启断言验证。第二次模型请求必须与完整首响应中的 `Read` ID、native Loop 订阅得到的同 phase 终止回执、请求中的工具结果同时匹配。原生回执在同步事件回调写入独立 profile 内、fixture 外的 owned 文件，合成工具无权改写它。该约束也运行在 mock 路径中。

为证明未改变全局配置，父进程对约定的生产配置、凭据文件、数据库与原 Mofox TOML 读取字节计算前后 SHA；不解析凭据值、不输出或传给子进程。角色采用用户批准的精简版 v3，所有版本继续保留；原始完整档案只在忽略的私有目录。

每次执行生成独立 `.runtime/P01/<run-id>` 与 `evidence/P01-U02/20261001-01/runs/<run-id>`。失败记录保留，当前摘要仅指向最近结果。回滚以本单元独立提交的 revert 为准，保留失败工作树与原始证据，不删除或覆盖旧项目与用户资料。目标测试路径映射到上表的实际脚本，未额外建立重复实现的 TypeScript 镜像测试。
