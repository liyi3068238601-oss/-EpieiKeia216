# P02-U10 独立阶段复核

日期：2026-10-03（Asia/Shanghai）  
性质：中期只读复核；不是最终验收或发布许可。

## 范围与来源

只读检查 `tests/integration/P02/durable-host.mjs` 的 scope/hook correlation/durable receipt/close 生命周期关键路径，及候选构建映射、许可和 Desktop/SQLite 验证边界。应用来源为 P02 worktree HEAD `7f947b3abc172aa2e8dc3614abec0679b0b8d24d`，Native 固定源码提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。此前构建的 candidate-01 descriptor SHA-256 为 `d81b38fca21bebc2b19d4615d3635110c493dc83c9a3f4e783963cadd50479bd`，绑定应用提交 `52a7f9427e6866263a159fb5a63ed20b28529bff`；它不包含当前新增的 P02 UI driver 修正，不能替代 candidate-02 的精确构建验证。

## 发现

在本次限定的 durable-host 范围内，没有发现新的 critical scope、hook/attempt 关联、receipt/readback 或 close 顺序缺陷。P02 wrapper 自己 abort 并等待 Native completion 后再 close，符合 Native.close 不等待前台 operation 的已知语义；关闭路径复用 promise 避免重复收尾。Native host 仍由只读 workspace FS 和 `Read` allowlist 限制，MCP、memory、dynamic workflow 均关闭；hook 关联到单一安装点/attempt，并将 commit receipt 与 readback 结果分开验证。

candidate-01 的 descriptor 把应用与固定 Native 源提交、构建图和输出树哈希绑定；上游 `UPSTREAM-LICENSE` 与固定源码 Apache-2.0 LICENSE 哈希一致。该构建借用仓库 `node_modules` junction，属于本机候选验证，不能据此声称独立可移植/完整依赖封存。角色素材声明仅覆盖本机获准适配，未声明公共分发权；根资产清单仍为 `research_only` 且无 approved assets，所以本结论不授权外部分发。

SQLite verifier 以只读方式回读 facts/observations 和 receipt，检查 scope、attempt、transcript redaction、终止事件及诊断；这证明测试数据库中确有对应持久化事实。它不证明用户界面显示“Saved”，也不证明业务成功。Desktop runner 启动固定 Electron 并通过 Playwright 与真实 renderer 页面交互；其验收是 DOM locator/文本断言，明确 `visual_acceptance` 与 `human_visual_review` 为 NOT_RUN。测试使用 synthetic loopback relay，没有真实凭据或外部模型调用；进程 egress canary 不是全面 OS 网络沙箱。

## 当前阻断与 UI 修正审查

candidate-01 的 Desktop full summary 为 6/6 通过、execution/production unchanged、外部模型请求为 0。两个 degradation 运行的 no-DSH 与 offline 通过；no-key 均因 Settings back button 在点击等待中从 DOM 卸载而失败。失败场景仍记录 0 请求、0 admitted turns/facts，独立 SQLite verifier 通过 `not_admitted`，因此这是测试验收失败，不是通过伪造或 no-key 被意外放行。

当前 P02 新 driver 相对冻结 P01 driver 的实质差异限于 `inspectSettings`：只捕获 `back.click()` 自身的 `TimeoutError`，随后仍必须满足 Settings page detached（若窗口仍开）与 workspace composer visible 两项真实后置条件；其他异常仍抛出。P02 runner 将此 driver 作为 `UI_DRIVER` 注入冻结 harness，runner 记录其 SHA-256。该修正没有放松 no-key 的 admission/ledger 断言，本次代码审查未发现阻断。注意其 `snapshot()` 写出的是 `body.innerText()` 文本，不是 HTML/完整 DOM；因此“返回页文本快照+locator 后置状态”是准确证据描述。

## 结论

当前代码审查没有发现 critical 缺陷；candidate-01 的 degradation 验收仍未通过。UI driver 修正从逻辑上合理，但 candidate-02 正在构建/重跑，须基于最终冻结提交、精确 descriptor/manifest、full 与 degradation 新证据再作最终 U10 判断。本报告不授予最终 pass。
