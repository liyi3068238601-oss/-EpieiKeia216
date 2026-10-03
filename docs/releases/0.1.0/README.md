# Xiadie 0.1.0 冻结候选

**作者提交时状态快照：ready_for_review；独立接受尚未记录。** 这是 P01 阶段的 Windows 本地开发 assembly 冻结记录，不是安装器、可移植发行包或公开发布物。当前权威状态见 [evidence/P01/status.json](../../../evidence/P01/status.json)；后续 acceptance.json 写入后，当前接受结果以该记录和 status.json 为准。本文中的 accepted:false 是作者快照。机器冻结索引见 [freeze.json](freeze.json)；作者材料见 [result](../../../evidence/P01-U11/20261002-01/result.md)、[baseline](../../../evidence/P01-U11/20261002-01/baseline.json)、[source decision](../../../evidence/P01-U11/20261002-01/source-decision.md) 和 [rollback](../../../evidence/P01-U11/20261002-01/rollback.md)。

本候选沿用 ZCode 原生 UI 和 Runtime。用户看到 ZCode 原生对话；Xiadie 提供已验收的遐蝶身份资产和上下文接缝。宿主侧 sidecar 保存 turn/tool 核验证据，不是 renderer 回复面板。固定上游为 ZCode commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e，candidate-06 源码为 82298c735dfbc4f278b5e920d79be7a83f979b55。

角色资产采用 P01-U04 已接受的 v3 版本，保留游戏背景和已有版本记录。此采用不表示遐蝶是本项目原创 IP，也不构成公开发行、素材再分发或商业授权证明。外部上游源码按 Apache-2.0 固定版本使用并保留其许可与 NOTICE。

## 已验证范围

candidate-06 descriptor SHA-256 为 25f92e7604b41479fdcdd9dcc089afe0ce6441db4586a7f7e7614805632a8907，绑定 6,673 个产物和 66 个项目输入；CLI bundle SHA-256 为 56bc58a658d938b9090e6004b1ab3cc4ab4ec32ed1c1b6e2138aeb2676cce44d。

U11 final-01 的 Desktop full suite 为 6/6、exit 0。final-02 只重跑 degradation suite：no-key、no-DSH、offline 为 3/3、exit 0。Desktop 使用实际界面与隔离 profile，模型请求由 loopback mock 接管；本轮外部模型调用为 0。no-key 为 0 请求，no-DSH 为 1 次本地请求且未启动 DSH，offline 收到本地 503 并显示失败提示，不显示成功回复。

P01 累计使用 18 次获批官方请求（U02 4 次生成、U09 14 次评测）。只有 deepseek-flash 获得当前候选资格；deepseek-v4-pro 已测但未合格；人工角色审阅为 not_reviewed。这些评测不是 U11 Desktop 的真实凭据或付费链路证明。

## 运行复核

作者 worktree 为 E:\Xiadie\Xiadie\.runtime\P01\worktrees\u11，工具链为 Node v24.14.0 与 pnpm 10.33.2。以下命令的精确 argv、cwd、耗时、退出码及日志 SHA-256 见对应 commands.json。

    pnpm run test:e2e -- --candidate E:\Xiadie\Xiadie\.runtime\P01\u10-candidate-06 --suite full --output E:\Xiadie\Xiadie\.runtime\P01\validation\u11-final-01\full
    pnpm run test:e2e -- --candidate E:\Xiadie\Xiadie\.runtime\P01\u10-candidate-06 --suite degradation --output E:\Xiadie\Xiadie\.runtime\P01\validation\u11-final-02\degradation

final-01 degradation 的 offline 检查确实收到 503、打开 Settings 并读取历史；该 run 因第二次历史快照复用同名输出而以 EEXIST 失败。作者只在测试文件中为前后快照指定不同 checkpoint 文件名，final-02 随后仅重跑三项 degradation 并全部通过。该修正不改变 candidate、产品代码、prompt、schema、资源、配置或锁文件。旧失败及新结果均保留。

## 限制与后续

此范围不证明完整多会话编辑/并发/重启恢复、应用级持久化、DSH 集成、完整无凭据 UI 状态、真实 Desktop provider 调用、可安装/可移植交付或生产网络隔离。网络 guard 是进程 instrumentation，不是 OS sandbox。视觉审查和 Core boundary scan 均为 NOT_RUN。P01 的 R01/R02/R03/R05/R06/R13 仍只是阶段范围证据，不代表全项目 Must 已完成。

U11 作者材料待独立核验，G01 尚未被判为 pass，根状态仍为 running。下一节点为 P02-U01 的 Runtime event/transcript/SQLite 迁移备份调查；本轮未启动 P02，也未发布或上传任何产物。