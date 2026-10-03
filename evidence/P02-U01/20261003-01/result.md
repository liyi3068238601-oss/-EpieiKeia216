# P02-U01 调查交付

作者状态：ready_for_review；研究基线 2d02355bcc6453d8e54e78fde17a86676e82c932。前置 P01-U11 接受记录的实际 SHA 与索引一致，G01 通过。

产物为 docs/research/P02/ 下的总览、Runtime/SQLite 调查和来源索引；检索记录保存日期、URL、固定 commit、文件 SHA、实际命令/输出、依赖、权限与差额。原生日志/Hook/SQLite 候选比较已经完成，但只是交给 U02 的试验选择，不构成 U02 采用决定或生产能力通过。

本单元没有生产实现、业务 DB、模型请求、安装或服务启动。关联源码/测试/许可/安装配置的检查是静态研究；真实 Runtime、SQLite 故障和恢复验证留在 U02，未运行项均不冒充 pass。

映射：计划允许 docs/research/P02/；任务要求的 evidence/P02-U01/20261003-01/ 为证据范围。Python/JSON SHA 核查代替研究单元目标 tests/units/P02-U01.test.ts；不新增没有意义的产品单测。

风险：固定内部 Runtime 接缝需维护，Hook 短期单消息不能当全历史，native sink 报错不终止 turn，Node24.14 SQLite 实验性/同步执行，备份须覆盖活跃 WAL，未知效果需回执核查。完整 Desktop、安装包、真实模型、物理断电等均未在研究单元运行。

回滚：revert 本单元独立提交；保留 P00/P01 已接受记录、所有角色版本、只读来源和用户生产配置。作者不自行签 accepted；独立审查后由协调者合入。
