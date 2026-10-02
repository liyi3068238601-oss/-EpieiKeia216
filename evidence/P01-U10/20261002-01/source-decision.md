# U10 来源采用决定

前置调查和试验采用已接受的 U01/U02 结论，逐单元核验见 `prerequisite-audit.json`；本单元继续使用 ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的 Desktop、renderer、preload、CLI、Runtime、Read、配置和插件接口。没有另建聊天 UI 或 Agent Loop，没有把 Herta 的角色素材复制进来。

候选构建复用已接受的 `packages/config/desktop-build.mjs` 和固定上游 `apps/zcode-cli/packages/cli/scripts/build.mjs` 的 alias、external、Zod 去重与版本逻辑。新增的最小 overlay 只替换协议入口中唯一的 `createZCodeApp` 导入，将实际原生 Desktop 请求接入 U06 host；U07 投影保存到候选自己的 sidecar。原生主回复继续进入原生界面。此处没有实现自定义证据卡片。

`factory.mjs` 组合已接受的 U04 资产、U05 packet、U06 门禁和 U07 投影。模型调用沿用原生 adapter；候选只允许已评测的 Flash ID。测试使用本机动态 loopback mock 与固定假 Key，不读取或传递真实凭据。Pro 在推理前拒绝。关闭扩展的控制格使用新建 profile 和原生 factory，验证原生对话仍可完成。

只读文件 adapter 借鉴 U09 的范围限制，使用固定上游真实 `readTextFile` / `readBinaryFile` / `readTextFileRange` / `stat` 接口；实际原生 adapter 检查补充了 stub 不能发现的方法名差异。路径按 workspace 的词法和物理边界校验；不宣称 OS 文件沙箱或并发文件替换的绝对防护。

测试 runner 借鉴 U08 的 owned profile 桥和真实 Electron/Playwright 交互、U09 的动态 mock 与证据绑定。操作使用实际 DOM 输入框、发送和停止按钮；不以预加载 API 调用冒充 UI 操作。网络 guard 属于测试仪器，限制到当次拥有的 loopback 端点与 IPC 前缀，不宣称 OS 网络沙箱。

构建只写新候选目录，固定参考 checkout 保持只读。provider 采用上游 `scripts/builtin-provider-config.mjs`，显式指定 production 环境与 tracked 输入，并将输入逐字节对照固定 Git blob；不信任隐式环境或旧 dist/provider 文件。CLI 的 invocation-context 必须只有一个模块实例，防止 AsyncLocalStorage 分裂。最终 descriptor 绑定 overlay 后的文件；U08 基础 manifest 仅保留为 overlay 前的构建溯源。

本地候选借用固定源码的依赖目录，属于开发 assembly，不是可分发安装器。上游版权与第三方 notices 保留。人格素材沿用用户批准的 v3 游戏背景，旧版本保留；不声明原创角色或公开发行授权。

路径映射：任务卡 `tests/units/P01-U10.test.ts` 映射到 `tests/integration/P01/*.test.mjs` 和实际 Desktop runner。根 `package.json`、`tools/run-stage-tests.mjs`、`tools/run-tests.mjs` 仅将现有测试入口接入实际 runner，并让缺失的声明测试文件明确失败；不改冻结计划、不另换测试框架。
