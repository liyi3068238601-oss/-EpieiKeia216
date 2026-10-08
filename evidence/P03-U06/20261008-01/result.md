# P03-U06：完整项目记忆导出与迁移

作者状态：ready_for_review。独立验收：pending。基线：`e7e8ae028e9ed90b2b46ba2a990604c6e5c801f5`。

复用已接受的 UUID/物理 Git 登记与 SQLite 包装器，新增完整原始文件树导出、显式导入、工作区迁移确认及数据根迁移。mapping 快照、清单和每文件 SHA-256 可追溯；SQLite 只保存指针及迁移前后元数据，不保存知识正文。源机器路径不作为目标身份，普通复制与确认导入分开处理。

已有目标返回冲突 diff，不覆盖原件。完整复制及源/目标复核通过后才更新指针；事务内校验失败同时回滚指针和迁移记录，原文件和未激活的部分目标保留。metadata schema 1→2 先核对原表完整定义、索引及外键，拒绝不兼容或损坏库时原字节和版本保持不变。

固定 Node 构建通过；最终迁移子进程 24/24、外层文件完成 1/1，通过流不相加。U03–U05 回归顶层 23/23，另含 reader 43/43、registry 14 通过/1 个 Windows 目录 symlink 权限跳过及 policy 1/1 子报告。junction、hardlink、真实文件和 SQLite 故障分支已执行。第一次正式构建的四个编译错误及修复后的命令完整保留。

导出支持 1024 文件、4096 目录、16 层目录、每文件 5 MiB、总计 64 MiB。无效 UTF-8/frontmatter 按原始字节保留；空目录及 `__proto__` 合法目录名往返已测试。超限和不安全链接明确拒绝。

证据见 result.json、source-adoption.json、build-04.json、unit-02.json、regression-01.json。执行输入的首个快照取于源文件停止写入后的最终运行期间，与结束快照比较 163 项未变；不将其冒称运行前快照。

本单元验证真实 Node/Git/SQLite/文件系统及 Native 纯路径解析器。Native 应用的 Core Read、模型和实际 Desktop 组合仍待 U09/U10；不存在跨机器分布式锁或文件系统事务保证。所有操作均为独立合成 fixture，未移动生产项目或记忆、未修改计划或上游树。回滚代码用独立提交 revert；部分迁移目标保留核对，不自动删除或覆盖重试。

封存前 diff-check 拒绝了 export.ts 的多余末尾换行，已停止在提交之前；仅移除 1 个 LF 后重建通过，三份 JS 与声明产物哈希完全相同。原运行快照保留，格式修正证据另见 freeze-preflight-repair.json。
