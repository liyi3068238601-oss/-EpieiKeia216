# P03-U07：子任务最小知识包

作者状态：ready_for_review。独立验收：pending。基线：`abc0bad7ed38b3f9ef442b2278e744d80bd03b3b`。

新增项目知识包：逐项绑定 UUID、实际 Git HEAD、原始文件 SHA-256、取样时间、来源行范围与独立适用 paths。只采集宿主批准的项目清单；不连接 Life provider，不读取其它项目。局部记忆始终是 experience-lead，损坏/不可读来源明确报错。来源哈希不代表其内容已经独立事实核验。

只读审查 profile 关闭持久记忆、MCP 和 skills，只开放明示快照文件的 Read。创建后及调用前后核对最终工具投影、注册表、Read handler 与 executor 身份；真实 Native AgentRuntime/ToolExecutor/Core Read 在合成快照端口执行，Write/Edit、Shell、插件绕行及扩权负例均拒绝。结果输出走单独宿主授权的 exclusive sink，保留哈希日志；审计失败保留文件并报告不确定，不自动重试。

同任务经两路独立 ZCode/DSH mock receiver 实际投递，核对必要事实、版本、项目与完整数据哈希一致。这里的 ZCode 接收端与 DSH 接收端都是 mock；真实 Native 只运行了上面的执行器与 Read 组合，没有运行模型、应用或 Desktop。

最终固定 Node 构建通过；U07 8/8、外层文件完成 1/1，不相加。U04/U05 回归顶层 22 通过，另含 reader 43/43 和 policy 1/1 子报告。两次失败及修复完整保留，未删除或放宽权限断言；第二次只修正测试误写的 Native 错误码大小写。文件 symlink 创建遭 EPERM，该项实际未执行；整体 skip 0 不代表此探针通过。

最终运行前后 172 项源码/编译输入一致。当前 Native 1181 个源输入与 1163 个编译 JS 输出匹配被接受的 U02 编译绑定；它不是本单元重新编译 Native 的证据。正式命令、cwd、退出码、输出与哈希见 result.json 引用的工件。

受信 factory 必须将 Read 接到提供的精确快照，不能换成任意 OS 文件系统；本模块不是通用系统 sandbox。常规 Native 子代理可能另加 coordinator 工具，需由受信组合裁剪才能通过严格检查。全部 fixture 独立，生产项目、记忆、配置和参考树未动；回滚使用独立提交 revert，保留原件与不确定结果核对。
