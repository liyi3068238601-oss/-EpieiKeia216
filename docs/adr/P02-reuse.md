# P02 复用决定

作者状态：ready_for_review。前置 U01 已独立接受；本决定以 U02 隔离实跑为依据，待本单元独立审查接受后放行产品实现。这里不代表 G02 或 0.2.0 通过。

继续采用固定 ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 作为唯一主 Runtime/Loop，使用既有事件订阅、Hook、原生工具和会话日志。Xiadie 通过薄适配维护自己的规范化事实与衍生证据，原生日志仍是其原始来源。默认 SQLite 路线采用固定 Node 24.14.0 的 `node:sqlite`，复用 SQLite 的事务、WAL、在线备份与恢复；不增加 native addon 或另写数据库。所有实际 PoC 使用独立合成资料。

| 采用内容 | 本次实际证据 | 最小差额 |
|---|---|---|
| ZCode 原生 Loop / Hook / Read / cancellation / resume | 两份既有测试的 16 项断言全部通过；Provider 编译入口缺失只在隔离副本映射到同 pin 源码 | 内部入口固定版本维护；不重写 Loop 或 renderer |
| Hook 有效期内有界材料摄取 | 原生 callback 正常、exit 2 block、exit 7 failure 实际进程；有效期内读/hash/全掩码副本，返回或拒绝前临时目录已删除；超大/半写/缺失材料均不报保存 | U04 实现版本化脱敏材料副本及来源 locator/hash；全掩码试验不宣称能恢复原始正文，单条当前消息不当全历史 |
| 原生事件作为来源，source+ID 作为身份设计 | 原生 memory store 重复 ID 实际留下两条并重新赋号；输入顺序 20/5/21 原样保留；下一轮淘汰旧 stream，fresh store 为空 | 来源顺序观察与 writer commit sequence 分离；不可把原生 memory store 当 durable dedup ledger。重新赋号记录审计，载荷相同不新增事实；相同 ID 异载荷拒绝覆盖 |
| 事实状态策略 | 最终 11 个合成场景通过：重复、冲突、source namespace、序号 ties/resequence、乱序 terminal、取消竞争、旧 attempt、草稿等 | U03 定义 operation_id、原生未赋号 0 的边界、提交/重放契约；首个提交终态互斥，迟到仅审计，半句不作正式回复 |
| `node:sqlite` / SQLite 自带事务和在线 backup | 最终 10 个真实 SQLite 场景通过：原始/规范化/receipt 同事务、commit 两侧 owned worker kill、lost ACK 重查、BUSY/FULL/READONLY、active WAL backup/fresh restore、迁移回滚、备份失败/未来 schema 拒写 | 薄事实表、source+ID unique 与 canonical payload hash、单写入者/有界队列，迁移前备份与 future-schema preflight，backup no-clobber publication |
| 已有恢复/未知效果原则 | 合成外部文件 effect 已发生但 receipt 前 kill；保留一次 effect 并明确 unknown，不自动执行第二次 | U07 实现 operation receipt 查询及 interrupted/needs_review，恢复事实而不重放副作用 |

SQLite 10 场景第二轮修复后通过，另做一次清理核查后的最终同矩阵运行；首轮迁移 fixture 的列数构造错误及完整失败输出保留。Provider 入口不匹配和第一版精确映射断言失败也保留。所有产品通过结论仍须经过 U03–U11 的真实实现、集成与独立验收，不能由这些 spike 推断。

拒用整套 Herta/DSH Runtime 或其安装图：U01 已验证词汇/接口不匹配和安装副作用；没有证据支持更换已接受的 ZCode 路线。只借鉴 Herta 严格材料读取与确定性序列化、不损坏原件的原则，以及 DSH append-only 事件和 Hook/工具/终态凭证分离的语义。Herta 受排除的角色 prompt/媒体没有复制，DSH 没有安装、启动或模型调用。`better-sqlite3` 只保留静态比较，不新增安装；固定 ZCode 本身使用 `node:sqlite`。

原生 Hook 的 `mkdtemp` 后 `writeFile` 故障已在 owned child 注入并实测留下临时目录，probe 只清理该子进程实际新建目录。不要把 callback 的 finally 夸大为全路径清理保证；产品若未摄取到材料要显式记录失败，不报告已保存。不得扫除全局 ZCode 或其他用户临时目录。

约束：Node 24.14 的 SQLite 为实验性/同步 API；采用有界工作与串行写入，不能让任意大查询阻塞宿主。SQLite `SQLITE_FULL` 为受控页容量限制，不是物理填满磁盘；owned worker kill 不是物理断电。Hook missing/ENOENT 与半写覆盖已运行，OS ACL 拒绝、物理断电、P02 新产品 Desktop、安装包、真实模型全部 NOT_RUN。现有原生测试只是同 pin 实际 Loop 和 loopback mock 模型；P02-U10 要另外证明新持久化链路。

来源：ZCode Apache-2.0；Herta/DSH MIT 代码设计（角色资产排除）；SQLite public-domain 与 Node MIT。固定源、官方 API/backup/WAL 文档、许可证/依赖索引沿用已接受 U01。CloudEvents 1.0.2 的 source+ID 用作身份设计参考，不宣称 wire protocol 实现。代码无整段第三方移植。

证据在 `evidence/P02-U02/20261003-01/`；spike 在 `spikes/P02/`；实际数据、worker、运行副本与失败目录在忽略的 `.runtime/P02/experiments/u02/`。现有 native fixture 在 U02 作者树内使用 `.runtime/P01/` 名称，不写主项目冻结 P01 目录。无真实 Key、生产资料、全局设置、固定端口、模型或 DSH 副作用。回滚为本单元独立提交 revert；已接受计划/证据和失败工作根保留，未知效果先核查。
