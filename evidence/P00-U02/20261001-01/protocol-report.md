# P00-U02 DSH JsonRpcLineTransport mock PoC

状态：`ready_for_review`。范围只包含固定提交 `639ed015397290b3745d163aafe02ffee4aa3f84` 中的 `packages/sdk/protocol/src/transport.ts`，由 Node 24 直接导入并在 `PassThrough` 字节流上与内存 mock peer 交互。没有启动 DSH SDK client/server 或 DSH 产品进程；mock peer 不代表 SDK 或 DSH runtime。

先读了固定源 `transport.ts`、`types.ts` 和完整的 `transport.spec.ts`。脚本 [protocol-poc.mjs](E:\Xiadie\Xiadie\spikes\P00\dsh-protocol\protocol-poc.mjs) 通过 Node `--experimental-transform-types` 直接导入固定提交的 TypeScript transport，不安装依赖，也不改 references。

一次实际运行通过以下断言：

- 请求经 JSON-RPC newline 帧传到 mock peer，并取得 mock 的 `messageId` receipt shape；mock handler 抛错后，client 收到 `JsonRpcResponseError`，code 为 `-32603`。
- `notify` 到达 mock peer。输入流先收到非法 JSON、空行、JSON `null` 和无 method/id 的对象，之后仍能解析有效通知；另将 CJK 字符 `昔` 的 UTF-8 字节拆在两个 Buffer chunk 中发送，通知内容保持一致，缺省 params 规范化为空对象。
- transport 关闭时，待处理 request 以 `JSON-RPC transport closed` 拒绝；输入监听器被移除，但两个 caller-owned stream 未被销毁。

实际命令：

```powershell
node --experimental-transform-types 'E:\Xiadie\Xiadie\spikes\P00\dsh-protocol\protocol-poc.mjs'
```

工作目录：`E:\Xiadie\Xiadie`。Node 为 `v24.16.0`，退出码 `0`。Node 的 stderr 给出预期 `ExperimentalWarning: Transform Types is an experimental feature`。第一次 smoke run 与为分列 stdout/stderr 而做的第二次同命令捕获运行都通过；两次原始输出、退出码、来源 hash 与固定 commit 记录于 [protocol-run.json](E:\Xiadie\Xiadie\evidence\P00-U02\20261001-01\protocol-run.json)。

现有固定源测试也覆盖双向请求/通知、handler error、malformed frame、拆分 UTF-8 与 pending close（`transport.spec.ts:14-61,148-190,252-260`）；本 PoC 不是 Vitest 套件，没有运行固定源的测试文件，也没有把 mock 结果记作 SDK 或产品测试通过。

限制：未验证真实子进程 stdio、SDK client/server 集成、DSH profile、队列持久化、模型、approval、取消或恢复；没有安装包、依赖、构建或模型调用。该结果只证明固定 `JsonRpcLineTransport` 在这些内存字节流场景下的行为。