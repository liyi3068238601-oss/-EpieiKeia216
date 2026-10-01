# P00-U02｜Herta 固定源纯函数最小 PoC

状态：ready_for_review（作者提交；未标 accepted）。

## 范围

直接通过 Node v24.16.0 原生 TypeScript type stripping 导入 Herta 固定提交 `4623df120adf99340ce5f7e25ed829466975e3ae` 的 `config.ts`、`retention.ts`、`select-episodes.ts`、`segment-session.ts`。四个源码文件和四个关联测试的当前 SHA-256 均与已接受的 P00-U01 `herta-sources.json` 一致。上游关联测试已阅读，但未运行；本轮运行的是本隔离目录中的单文件 PoC。

PoC 只用内存中的合成通用消息与合成记录，不读写 manifest/数据库，不装依赖，不调用模型或联网。它直接 import 上游纯函数；没有复制上游实现、角色 prompt、角色语料、图像、网站资源或语音。此结果是纯函数执行证据，不是 Herta 产品、Xiadie 产品或存储恢复验证。

## 实际结果

命令：`node --experimental-strip-types spikes/P00/herta-pure/poc.mjs`

工作目录：`E:\Xiadie\Xiadie`；Node：`v24.16.0`；退出码：0。实际标准输出及完整来源哈希记录见 `evidence/P00-U02/20261001-01/herta-run.json` 与 `herta-sources.json`。

- 正常：20 分钟间隔将合成会话切为两个 settled episode；各有足够语音块/字符，两者都通过 `selectEpisodes`。
- 失败反例：无效时间戳不能证明尾段已静默，episode 保持 unsettled 且不会被选择；大量 system/chrome 文本也不能替代会话语音满足长度门。
- 恢复：在开放尾段之后追加间隔足够的新一轮，旧 episode hash 保持不变，新状态正常分段并可被选择。保留分数在 30 天半衰期后从 0.8 降至 0.4；无效日期锚点保持有限值；一次 reactivation 重置衰减锚点并使得分回升。
- 配置：固定源默认自动 Dream 为关闭；PoC 只覆盖本地选项，不启动自动流程。

## 证据边界与限制

未运行 Herta Vitest、完整工作区构建、manifest/损坏读写或任何产品流程；未安装 pnpm 依赖。这里的“恢复”只表示纯函数在新输入/再激活时间锚点下的确定性重算，不等于持久化 ledger 恢复。Herta half-life/episode schema 仍为参考行为，不是 Xiadie Life/Project 的冻结策略；本 PoC 不批准代码直接进入产品。

参考目录保持固定 commit 且干净。未修改总 status、总 result、ADR、计划、全局或用户设置，未提交 Git。回滚时只移除此单元新建的 `spikes/P00/herta-pure/poc.mjs` 及本目录下 `herta-*` 证据文件。
