# Xiadie执行规范片段（合并，不覆盖已有AGENTS）

每阶段先查本地和现成组件、在隔离环境试、再做最小差额。源码/许可/失败证据要登记。只做已领取单元，检查baseline、前置和scope。

Core管角色/记忆/Context，ZCode管主工作，DSH由ZCode委托。项目Memory不自然衰减。Prompt不授权，模型自述不是证据。

每写者独立工作树；read-only审查必须核执行端权限，注意子代理memory会投影写工具。取消、unknown effects、隐私epoch和恢复都要真实处理。

记录实际命令、退出码、产物hash、来源与回滚。没跑写NOT_RUN。作者ready_for_review，集成者复验accepted。不要将全套计划常驻上下文。
