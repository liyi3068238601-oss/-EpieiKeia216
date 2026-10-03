# P02-U04 transcript 摄取实现

作者状态：`ready_for_review`；基线 `d9f5912b093e16ec6c335a74ab99ca842eb8937d`。任务设计路径 `packages/adapters/zcode/transcript.ts` 映射至 `src/transcript.ts`；同时映射最小现有 Host 调用接线、生命周期和 index 导出，使 helper 实际可达。测试映射见 baseline.json。未修改计划、P00/P01 证据、上游或全局配置。

在自有 TEMP 中，通过独立匹配的 session/turn/Hook trace 读取当前消息，限制 512 KiB，检查链接、普通文件、UTF-8、完整单行 JSONL、内容与当前 Hook 输入、读取前后文件状态。文件不存在、半写、过大、不可读或读时变化均返回固定原因码。原始内容只在调用内存中出现；留下 `full-mask-v1`、角色、字节数、文本/原始字节 SHA-256、固定来源 pin 和 canonical snapshot 哈希。`temporaryLocator` 仅作历史定位，`rawRetained=false`；恢复不依赖已删除临时文件，也不声称能恢复原文或完整历史。

有界单写入队列不等待 sink 才返回；active+waiting 计入容量。只有 receiptId 非空且 snapshot 哈希匹配的 sink 回执报告 saved，异常/无效回执为 unknown，显式未提交失败为 failed。没有 sink 为 unavailable，排队成功不是保存。drain 等待调用时已接受任务，close 拒绝新任务并等待既有任务。Host 在已识别的 UserPromptSubmit Hook 执行前摄取，原身份回执校验仍运行；只接线当前插件实际使用的 UserPromptSubmit。Stop 格式由 helper 合成测试覆盖，未声称真实 Host Stop 接线。

固定 Node v24.14.0 与 TypeScript 6.0.2。最终 build 和 U04 unit suite 均 exit 0。全部实际命令/cwd/exit/stdout/stderr 及前后执行输入绑定保存在 commands、command-index.json、inputs-final-pre/post.json；前后源码、编译输出、工具链、实际 Hook 和 v3 资源字节一致。首次编译中的类型诊断及修复后命令全部保留。此前一次修改测试选择器的 PowerShell/Python 引号错误在修改文件前退出；改用 apply_patch 后完成，未伪造完整命令输出。

Helper 使用真实自有文件，EACCES/读时变化是测试注入，不是 NTFS ACL/物理故障实测。Host 测试运行真实已批准 context Hook Node 子进程，但原生 app 与临时清理为 fixture，sink 为 mock receipt。验证前台 Hook 返回不等待受阻 sink、临时文件删除后仍有脱敏材料、unknown/无 sink、不重复 close 和关闭等待。既有 Host 回归同时运行。SQLite 原子保存、完整原生 Runtime 摄取、Electron 宿主、真实模型、安装包、原文恢复均 NOT_RUN，由后续单元验证。

来源采用：沿用已接受 U02 的固定 ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e` Hook 生命周期和 U03 canonical JSON；借鉴已登记 Herta 有界材料/确定性证据设计。自编薄适配，无整段第三方复制或排除角色素材移植，不运行 Dream。官方 Hook 与 Node API 调查证据沿用 U01/U02。

风险：同步有界读取仍占用一次 Hook 处理时间；保存结果取决于下游 sink 的真实 COMMIT 凭证，U04 只验证协议。全掩码不提供正文恢复；最近状态仅保留 64 条，持久审计由 U05 承担。回滚优先 revert 本单元提交；本次不迁移数据库，失败记录及独立工作树保留，不触碰生产资料。

最终提交检查发现 helper 测试末尾空行（diff-check-01 exit 2）；只删去空行，重新 build-final-02、unit-final-02 均 exit 0（20/20，0 skip）。权威执行绑定更新为 inputs-final-pre/post-02.json：103 项字节前后一致；初次命令/绑定保留。command-index-02.json 汇总全部命令，旧 command-index.json 为首次快照。
