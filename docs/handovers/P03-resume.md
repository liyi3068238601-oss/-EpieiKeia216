# P03 接续入口

更新日期：2026-10-08。实际仓库为 `E:/Xiadie/Xiadie`，上层 `E:/Xiadie` 不是 Git 仓库。

唯一计划基线是原始 v1.1 ZIP 与 `planning/Xiadie_V2_v1.1/`。计划卡的初始 `not_started` 不随执行改写；当前状态统一查看 `evidence/P03/status.json`，再读它指向的 acceptance/review 和当前卡片。

P02 的 11 个单元已接受，G02 已通过。P03-U01 研究已完成独立审查和主线集成，作者提交 `bb923d6197a40199e9b4b95d00235a5cb4355594`；接受记录在 `evidence/P03-U01/20261004-01/acceptance.json`。本次接续从 U02 隔离试验继续；后续状态以状态文件为准。

执行顺序为 U02 试验和采用决定 → U03 项目身份 → U04 索引/主题读取 → U05 工程事实优先 → U06 移动导出 → U07 最小交接 → U08 新鲜度 → U09 集成回归 → U10/G03。作者独立提交 `ready_for_review`，独立 reviewer 绑定精确提交后，协调者才归档并更新 `accepted`。

已有资料位于 `.runtime/P03/preparation/`；它们是调查导航，不是实现或验收证据。固定 ZCode 源为 `.runtime/P01/desktop-source`，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。工作树与协调脚本位于 `.runtime/P03/worktrees/`、`.runtime/P03/coord/`。这些忽略目录依赖本机，正式结果须归档到 `evidence/<task>/<attempt>/`。

关键待验证差额：原生索引存在初始化缓存；新 UUID 与旧路径 key 不能自动等同；MemoryService 不提供原始字节/hash且容忍坏 UTF-8；持久子代理 memory 可自动增加 Write/Edit。采用路线须依据 U02 的实际运行结果，不能用准备笔记替代试验。

所有试验使用独立合成数据和 loopback 动态端口；桌面禁用固定 9229。固定工具链 Node 24.14 与实际 Desktop CLI 的 Electron Node 模式分别记录。生产资料、凭据、P00/P01 历史证据和固定上游保留。P03/G03 后停止，P04 与正式发布另行处理。

本次接续保留原 U01 的失败命令和未提交修改，核对后完成清单与提交。旧 baseline helper 的 `author_status` 曾硬编码为 `ready_for_review`，独立审查已注明其仅是历史 marker；实际接受状态不能据此推断。新单元 baseline 将记录 `running`。
