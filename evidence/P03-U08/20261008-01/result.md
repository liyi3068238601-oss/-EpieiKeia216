# P03-U08：旧项目新鲜度与再开

作者状态：ready_for_review。独立验收：pending。基线：`5831ba60285536aaa9b8ef40770510f380cb6edf`。

新增固定用途的新鲜度观察：从已接受 registry 重新确认项目身份，实际读取 Git HEAD 与指定文件原始 SHA-256；采样结束重查身份、HEAD 和整组证据。三年未提及而 commit/hash 未变仍为 current，变化给出 needs_recheck 清单，缺失、不可读、证据不完整或路径不安全保持 unknown。current 只表示采样时引用匹配，不表示内容已成为工程事实；不推断 owner 或进度，不做时间衰减或删除。

正式笔记修订先由受信 Host 实际核验，回执绑定精确提案、完整历史摘要、旧 revision ID/hash、项目、HEAD、文件 hash、命令退出码与 stdout hash。模块核对回执字段并在核验前后及追加前重新观察；它不执行命令，也不能凭 JSON 自证真实核验。追加返回保留全部旧内容/hash/JSON元数据的深度冻结副本，只追加 experience-lead 版本。显式、已接受的 supersedesRevisionId 表达替代关系，旧版本不变。没有 Native writer 或第二知识数据库；落盘和跨进程原子 CAS 由 Host 负责。

最终固定 Node 构建通过；U08 9/9，另有外层文件完成 1/1，不相加。真实 Windows ACL 拒绝、DACL hash 精确恢复、hardlink、目录 junction，以及真实 registry 迁移均运行。采样期间变更通过窄 wrapper 故障注入触发真实 Git/文件操作，不冒充 OS 调度并发。U03/U07 相关回归通过：registry 14 pass/1 文件 symlink 权限 skip，U07 8 pass，外层两文件完成；U07 的另一个文件 symlink EPERM 探针实际未执行。一次 TS7006 构建失败及修复保留。

运行前后 173 项源码/编译输入完全一致；Native 当前 1181 源输入与 1163 编译 JS 匹配已接受 U02 绑定，没有重编 Native。正式命令、cwd、exit code、原始日志与 hash 见 result.json。没有运行实际应用、Desktop、真实 DSH、模型或正式笔记持久化；这些不作为本单元通过证据。全部 fixture 独立，生产数据、配置与参考树未动；回滚为独立提交 revert。
