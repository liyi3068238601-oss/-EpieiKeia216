# P02-U02 事件策略与既有原生路径试验

`events-poc.mjs` 首轮运行 9 个合成内存场景；根据原生 store 的实际重复 append 会重新赋号这一结果补上两例，最终运行 11 个场景全部通过。身份采用来源 namespace 与 event ID；观测时间及来源顺序观察不参与载荷事实 hash；同身份异载荷保留原事实并记录冲突。重复来源 ID 被重新赋号时不新增事实，保留首次序号并追加重新赋号的审计观察；不同 ID 的相同序号不互相去重。来源序号与实际串行接受次序分开：低来源序号不是丢弃终态的理由；首个接受终态不可由迟到结果覆盖，旧 attempt 不能完成当前 attempt。流式片段保持 draft。

这不是产品契约或 SQLite 持久化实现。PoC 不接受来源序号 0；P02-U03/U04 必须明确定义原生未赋值序号的规范化、writer commit sequence、operation_id 与重放边界。没有 operation receipt 不得自动重试外部副作用。采用 CloudEvents source+ID 的身份设计，并非实现 CloudEvents wire protocol；没有复制第三方实现。

`native-probe.mjs` 只在忽略的试验目录生成两个既有 P01 native test 的影子副本：将缺失的 Provider `dist/registry.js` 单个入口改为固定提交同树的 `src/registry.ts`，并把测试根目录/相对 projection import 绑定到 U02 作者树。断言和测试列表未更改。ZCode 仍是固定 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，所有用户资料和冻结的 P01 树不写入。

第一次直接运行两份既有测试因 Desktop 源码布局缺少该 Provider 编译文件失败（exit 1、0 pass / 2 fail）；第一次生成脚本也因两份入口的路径拼写不同而精确映射断言失败（exit 1），随后修正逐文件入口匹配。修正后运行 16 项原生 Loop/Hook/Read/cancel/resume/gate 测试全部通过；模型传输只访问测试创建的本机回环 HTTP 服务，使用系统分配端口，不调用真实模型。

测试创建的 profile 位于 U02 作者树下独立忽略目录 `.runtime/P01/`，沿用旧 fixture 的目录命名，完全不同于主项目历史 `.runtime/P01/`；fixture 自行清理其所有临时 profile。主项目输出位于 `.runtime/P02/experiments/u02/native/`，不修改上游或全局配置。工具链使用固定 Node 24.14.0 / 主项目现有 TypeScript 6.0.2，只借用只读 node_modules，没有安装。

最终另外运行相同 16 项断言并加只记录 listener 的 preload，以落实端口证据：启动前只读 Get-NetTCPConnection；每个测试 HTTP listener 的实际地址记录在 mapped-02/command.json，均为 127.0.0.1、请求 port=0、实际端口不在启动前监听集合。没有 Desktop/inspector 或固定 9229 启动。该 instrumentation 不替换 provider/runtime 或断言；第一次成功 16 项输出仍保留在 mapped-01/。

运行结果分层：事件策略为 synthetic policy；16 项为实际原生 Runtime/工具/Hook 与 loopback mock 模型；当前 P02 新产品、Desktop、安装包、真实模型、物理断电全部 NOT_RUN。SQLite 事务/进程 kill 和恢复由另一独立 PoC 给证据，不能由这些内存结果推断。

回滚采用独立提交 revert；试验失败输出、源 hash 和隔离目录保留。作者提交 ready_for_review，尚不自行接受整个 U02。
