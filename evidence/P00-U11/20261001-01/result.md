# P00-U11 阶段集成与独立回归

作者状态：`ready_for_review`。基线为已接受 U10 提交 `1ea91865318b020629535ba572c88440731797f4`。只新增 `tests/integration/P00/`、`docs/evals/P00/` 与本 attempt 证据；未改计划、acceptance/status、参考源码、生产配置或用户工程，未提交。

集成入口 `tests/integration/P00/run.py` 在本地锁定来源上串行运行 U07 mock-only 副本、U08 Memory/executor probe、U09 owned Job A/B、detached leaf 与原生 SDK probe under Job，以及 Herta 纯函数。命令为：

```powershell
python tests/integration/P00/run.py --root E:\Xiadie\Xiadie --output-dir E:\Xiadie\Xiadie\evidence\P00-U11\20261001-01\replay-02
```

cwd 是 `E:\Xiadie\Xiadie`。六条命令均 exit 0，全部 runner 断言通过，固定 ZCode/DSH/Herta 来源在执行前均为指定 pin 且 clean；实际命令、cwd、exit、stdout/stderr SHA 和测试输出见 `replay-02/runner-summary.json`。根另以 fresh replay 独立复跑，核验 55 项输入/源码/输出绑定并确认三个固定来源执行后仍 clean，报告为 `root-review.json`。总 paid calls 为 0；模型形状请求只发往 127.0.0.1 合成服务；DSH 使用替换子进程环境、合成 home 和假凭据。

U07 副本 `tests/integration/P00/u07_mock_probe.py` 绑定 accepted U07 harness 与 host/plugin 文件，只接受 `--mode mock`，删除真实网关与全局凭据读取分支，并把 runtime-data 和结果输出重定向到本 attempt。其合成 `personal.json` 仍含 fake `p00-fixture-key` 字段，不能与真实密钥混淆。`globals_snapshot()` 固定返回空列表，因此本次没有读取该副本所列的全局密钥路径，但也没有枚举或前后哈希全局配置。相对原 probe 的完整 diff 为 `u07-copy.diff`。fresh mock 执行新会话、compact/postcompact、Read 失败后继续、Plan Write 被原生拒绝和同 session 冷恢复。已知新会话/恢复首轮可能重复 system-reminder 包，保留为低风险 follow-up，没有在 U11 扩大修复。

U08 fresh probe 的 18 项断言全部通过，6 次 synthetic Memory 写入成功，Plan 越权与显式 Write/Edit 拒绝负例保留。U09 的 A/B Job 独立关闭、父进程退出后 detached leaf 的对照均通过；原生 SDK 在 Job 分配后才导入，driver exit 0、关闭前 Job member 数回到 0。SDK loopback receipt/idle/业务结果通过，包含重复 receipt、空 final、脏 stdout、强制 whole-runtime close 和 detached-child 故障。completed spike-owned checkpoint 在 close 后读回成功；unknown checkpoint 原样保留且没有自动重发。它不证明 native session resume、per-prompt cancel、crash consistency 或 OS 沙箱。Herta 纯函数在新输入上正常重算，未运行持久化产品。

U11 核对 P00 七项 Must：见 `docs/evals/P00/integration-evaluation.md`。R03 在 immutable `requirements.json` 是 Must，任务映射为 U01/U02/U12，但 U11 卡片只列六项；本文记录该差异，U12 和 G00 仍 pending。R24 的本阶段证据仅限旧工程保护/隔离、迁移来源记录和 spike 完成结果读回；不声称最终备份恢复。U06/U10 的许可与资产边界继续适用；未复制角色素材或上游实现。正式安装器/Windows package、产品层权限隔离及发行权利均为 `NOT_RUN`。

首次 runner 预检因任务卡 R27 行末标点处理错误而 exit 1，且在 probe 启动前停止；失败回执保留在 `replay-01/preflight-failure.json`。`verification.json` 绑定作者 runner/copy/diff、最终评估与结果、author runner summary、根独立 review 及关键来源。生成运行目录仍保留在本地 attempt；`.gitignore` 忽略 runner environment、U07 runtime-data 下的 fixture/home/temp/data，以及 U09 synthetic-dsh-home、child-env、workspace、temp/data 等生成目录，避免将临时 profile、子进程环境和缓存纳入提交，没有删除这些数据。U07 自有的 packet.json、personal.json、hooks 与 spec 记录仍可见；personal.json 中的 `p00-fixture-key` 是合成字段，不是真实凭据。原始命令输出、probe、checkpoint 和独立 review 仍保留。

回滚只涉及本单元三处允许路径下新增文件；不删除本 attempt 原始证据，不操作任何用户数据或固定参考树。U11 仅待独立接受，不开放 P01；必须完成 U12 实际候选 smoke 和 G00 复核后才能进入后续施工。
