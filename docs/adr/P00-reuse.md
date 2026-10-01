# P00 复用路线决定

状态：P00-U02 ready_for_review；最终开工准入由 P00-U10/G00 决定。

依据压缩包 v1.1 的默认架构，选择 **ZCode 为唯一主 Runtime，Core 提供角色与记忆上下文，ZCode 按需委托独立 DSH 工作包；Herta 提供有限叙述记忆的设计与合规纯函数参考**。

## 本次实际试验与采用界限

| 候选 | 已运行证据 | U02 决定 | 尚需验证 |
|---|---|---|---|
| 固定 ZCode 原生 CLI + Hook | 源码过滤构建；mock正常/故障/新运行恢复；7877真实模型1次成功，实际请求有两段Hook上下文且0工具 | 默认继续采用原生Loop、公开配置/插件接缝 | U07官方插件、恢复/compact/工具失败；U08真实scope和执行端权限；薄桌面呈现尚未批准为已实现 |
| DSH 官方 SDK 独立工作包进程 | 固定JsonRpcLineTransport与mock peer已实跑；SDK source fallback启动由独立组件报告记录 | 优先复用官方SDK/协议，不硬融源码或虚构cancel/approval | U09 session/prompt、回执/idle/业务结果区别、进程树取消与检查点；审批不支持时退回主端 |
| Herta 分段、选择、保留分数 | 固定四个纯函数以Node原生TS直接运行；正常、坏时间戳、system文本反例及新输入恢复 | 借鉴机制与可验证纯函数；不整体fork或拷贝角色资产 | Xiadie自己的来源/版本/privacy epoch/proposal提交与持久化恢复在后续阶段实现 |

本轮足以继续 P00 接缝验证，不代表三套产品完整互通。历史 Library 原文未找到，按 v1.1 保留的需求执行，缺失原文明确标 Source unavailable。

## 差额原则

当前没有证据支持重写完整 Harness、独立双模型 Self Runtime、Core 路由 DSH 或三仓库硬融合。暂不批准这些扩大方案。若 U07/U08/U09 确认公开接口不能满足既定要求，先保留最小反例，再在 U10 决定薄适配或小范围下游 patch；权限和持久化提交仍需确定性代码，不能由提示词保证。

DSH 的 messageId 仅是入队回执，idle不构成工作包成功；专属工作包进程是初版隔离和取消边界。缺少单session取消/审批回传必须如实报告。Herta默认参数不作为Xiadie策略事实，许可证不涵盖被排除角色素材。

## 路径、版本、回滚

计划允许 `spikes/P00/` 的实测脚本映射到 `spikes/P00/{herta-pure,dsh-protocol,dsh-runtime}/` 与 ZCode driver；其安装依赖、独立checkout、合成home/fixture/temp在忽略的 `.runtime/P00/{zcode,dsh}/`，不得在只读 `references/` 安装。证据归 `evidence/P00-U02/20261001-01/`。测试目标映射为实际driver/PoC命令，未额外创建实现镜像测试。

源码提交固定为 ZCode `29628c9acdb81b703bbd4080c207a0e7ce5e276e`、DSH `639ed015397290b3745d163aafe02ffee4aa3f84`、Herta `4623df120adf99340ce5f7e25ed829466975e3ae`。真实运行目前使用 Node24.16.0；ZCode pnpm10.33.2、DSH pnpm11.7.0，正式锁定与原生ABI记入U04，不冒充上游所有环境均已测试。

回滚优先 revert 单元独立提交。不改生产配置，不删除旧工程/用户包/资产；失败fixture与未知云端结果保留。spikes/evidence保留原始字节，Git blob需与审查SHA一致。7877实际路由当前为HTTP，模型 usage与未返回金额分别记录，不能用DeepSeek官方价格推断网关费用。
