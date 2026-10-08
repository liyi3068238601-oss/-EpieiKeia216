# U04 Native Read / FileSystemPort 只读预查

本文件是 U04 API 与 Native 调用链预查，不是 unit final review，也不改变作者代码、计划状态或验收状态。检查基于冻结 Native 源 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`（desktop-source 工作树 clean）及主控指定的 U02 review runtime 记录。

## 结论

普通 Native turn 会生成非空 `turnId` 并放进 `turnTraceContext`；普通 Native Read 调用因此能把 `sessionId` 和 `turnId` 传到文件系统请求。通用 `Read`/文件系统契约没有保证每一种执行入口都有 `turnId`，所以 U04 Host bridge 必须从请求本身取得两个字段，并在缺字段或当前 Hook receipt 不精确匹配时 fail closed；不得借全局“当前 turn”补值。

`FileSystemPort` 没有内建 Host/trace 桥。Native `Read` 把 `TraceContext` 放在 `stat` 与 `readTextFileRange` 的请求对象 `trace` 字段中，传入的 Node adapter 只做本地 stat/read。U04 最小接线点是 Host/desktop 注入的 `FileSystemPort` 装饰器，只拦截准确选中的 project-memory 路径；range 分支调用 `host.readProjectMemory(filename,{sessionId,turnId})`，不可用 Node adapter 返回的解码文本/Revision 替代 raw-byte reader 及其 source hash。

还有一个 Read cache 旁路需要处理：`Read` 先执行 stat，再按规范化 path + offset + limit 找会话缓存；mtime（毫秒取整）和 size 相同会返回 `file_unchanged`，跳过 `readTextFileRange`。`AgentRuntime.readFileState` 是会话级 Map。若只在 range 方法接 Host，第二次/后续 Native Read 可能不运行 Host receipt/source recheck。一个窄桥方案是在确切 memory 路径的 `stat` 返回真实 size、无 mtime 的合成 `revision.id`（例如当前 Read spanId），令每次 Read 的 stat revision 与前次不同并进入 range；range 再调用 Host 每次核对 snapshot/映射/源 hash。Read handler优先以 stat.revision 更新缓存；普通工具 span 每次由 `createChildTraceContext` 新建。实现可选不同方法，但应证明同路径跨 turn 与同 turn 源变化时不会被 `file_unchanged` 遮住。

Native `stat` 结果形状是 `{path,kind,sizeBytes,mtimeMs?,revision?}`；`revision` 可有 `id,mtimeMs,sizeBytes,hash?`。range 请求有 `{path,encoding?,offsetLine?,limitLines?,maxBytes?,trace?}`；range 结果有 `{path,content,encoding,lineEndings?,bytesRead,sizeBytes,truncated,startLine,lineCount,totalLines,revision?}`。range 的 `content` 会按文本编码解码并归一 LF；它不保留原始字节权威。

## 固定源码锚点

- `apps/zcode-cli/packages/core/src/tool/handlers/read.ts:181-211`：构造 Read trace；stat 检查缓存；缓存未命中才调用 text range。
- `apps/zcode-cli/packages/core/src/tool/handlers/read.ts:312-319`：trace 取 `ToolExecutionContext` 中的 traceId/spanId/sessionId/turnId。
- `apps/zcode-cli/packages/core/src/tool/handlers/read.ts:335-379`：fresh 条件只比较 mtime/size 或 revision id，且缓存优先用 stat revision。
- `apps/zcode-cli/packages/core/src/tool/handlers/read-text.ts:42-50`：range request 形状及 `trace` 传递。
- `apps/zcode-cli/packages/core/src/tool/types.ts:196-197`：sessionId 必填，turnId 可选。
- `apps/zcode-cli/packages/contracts/src/tracing/tracer.ts:14-23`：TraceContext 的 sessionId/turnId 可选；`:212-234` 每次 child trace 创建新 spanId。
- `apps/zcode-cli/packages/contracts/src/interfaces/file-system.port.ts:61-73,125-160,275-300`：stat/range 请求、结果和 port API。
- `apps/zcode-cli/packages/adapters/src/fs/index.ts:131-153,262-289`：Node adapter 本地 stat/range 实现；未把 request.trace用于额外下游调用。
- `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts:408`：Host可以通过 `options.fileSystemPort` 注入 port；未验证当前产品注入路径是否已提供装饰器。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn.ts:107-119`：普通 turn 创建 turnId 并放进 turnTraceContext。
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts:159,278`：Read state 是 AgentRuntime 成员并初始化为会话级 Map。

U04 决议与契约已对照：`.runtime/P03/resume/u04-api-decision.md:31-43` 要求 per-reader brand、exact receipt correlation、原子性边界说明及再次校验；`docs/adr/P03-reuse.md:38-51` 和 `planning/Xiadie_V2_v1.1/tasks/P03-U04.md:39-43` 要求严格 raw source、四状态、失败保留旧记忆、A/B隔离及坏路径覆盖。

## 运行时观察

既有独立 Native run `run-review-02-runtime-result.json` 的 `filesystem.reads` 有 10 个 Read trace，另有 1 个 `P03_MEMORY_SOURCE_CHANGED` failure；观察到的全部条目都有 `sessionId` 和 `turnId`，采样覆盖 6 个不同 turn。它只证明该次正式运行样本，不提升为通用 Native 类型保证。

本预查没有运行 U04 formal tests，也不形成 U04 pass/fail 决策。作者 final冻结后按指定 exact commit 做正式独立 review。

## 证据 SHA-256

- `read.ts`: `D3CEBD63754AA4753832A1AB78D43EE3C8C00CE452972EBCE2E24E1B81FA3712`
- `read-text.ts`: `7604D873C456A6101C7D21C44597B912E2870D5BDE258DE977FEE18E21310F88`
- `file-system.port.ts`: `E0A511572634C5291FF9F86C27339DC4A4E71676E388147A22259C7C64FA2FE3`
- `tracer.ts`: `289402AA914DCD545718F92CCD90AEBFB78D2429C72829561C31685BD6BDB1A5`
- `adapters/src/fs/index.ts`: `83292FA1B0AA694EBE411B11C06DDC541810E99F48CA6E72F04E27865524ACB9`
- U02 `run-review-02-runtime-result.json`: `94C54AFE5B3FB0C0C591CCE57A1DD356A0E356D601A3DF27EAFEC764F94809D5`
