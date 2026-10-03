# P02-U02 隔离试验交付

作者状态 ready_for_review；基线 e809d5c7e9969cbf2f5efd68df326e115cf6f1e6；前置 U01 accepted。提交采用决定为 `docs/adr/P02-reuse.md`，独立接受后再开始产品实现。

已运行最终 11 个合成事件策略场景、16 项既有原生 Loop/Hook/Read/cancel/resume 断言，以及最终 10 个真实 SQLite 隔离场景，全部通过。Runtime 另实测 Hook 正常/block/nonzero 的材料有效期与清理、超大/半写/缺失材料不保存、native memory store 重复/乱序/淘汰及 native writeFile 故障清理缺口。这些层级不能混称 P02 完整产品已通过。

Native 两份原测试缺 Provider 编译入口时首次失败，隔离副本只映射同 pin 源码并绑定作者树，全部断言不改。映射构造曾因两份路径拼写不同失败，修复为逐文件精确匹配。SQLite 首轮两例迁移 fixture 的 SQL 列数错误修复后通过，最终又核查 child 清理；所有失败 command/stdout/stderr/summary 保留。原事件 9 例成功记录保存命令输出；根据 native resequence 实测补为最终 11 例，最终 summary 对应补测后的脚本。

命令、cwd、exit、真实 stdout/stderr 与 hash 在 runs/ 与 output-index.json，后者只哈希原始合成 fixture/DB，不导出它们。材料副本为合成全掩码 JSON，明确 rawRetained=false、source locator/bytes/hash、redactedSnapshot/hash。工具链固定 Node 24.14.0（SQLite 3.51.2）和现有 TypeScript 6.0.2，未安装依赖；实际源码/编译输入另有 hash。U01 99 个源观察和 4 个固定干净树复查通过。

端口证据在 native/mapped-02/command.json：增加仅记录 listener 的 preload 后，相同 16 项断言再通过；启动前监听快照和所有实际 mock 地址均记录，127.0.0.1/请求端口 0、没有与既有 listener 碰撞，没有 Desktop/inspector/固定 9229。第一次成功原生输出仍保留；后续无需为同一候选反复跑套件。

允许路径映射：spikes/P02/、docs/adr/P02-reuse.md，任务必需证据 evidence/P02-U02/20261003-01/。目标 tests/units/P02-U02.test.ts 映射为 Node assert PoCs 和既有 native assertions 的隔离运行；无空壳产品测试。没有修改产品、计划、上游或生产配置。

限制：所有事件策略只是 synthetic in-memory；SQLite 与进程 kill 是真实本地路径，外部 effect 是合成文件；既有原生 Loop 使用 loopback mock 模型。真实模型、P02 Desktop、Windows 包、物理断电、OS ACL 拒绝 NOT_RUN。原生 Hook 与 store 差额不得隐去；未摄取/未提交/未知 effect 不声称保存、成功或自动可重试。

回滚 revert 本单元独立提交；保留历史 P00/P01 和隔离失败证据，未知外部效果先核查。本单元通过也不等于 G02：下一节点 U03 事件 ID/互斥终态/operation_id/seq0 合约。
