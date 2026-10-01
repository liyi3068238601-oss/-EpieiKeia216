# 代码复用与第三方许可边界

状态：P00-U06 作者稿，`ready_for_review`。产品版本 `0.0.0` 仅用于本地研究，不发行第三方代码、运行时或角色资源。本单元没有复制任何参考仓库代码；基线候选源代码/资产路径扫描为 0 项。许可证记录是来源审查和工程发布门槛，不构成法律意见或权利人的额外授权。

## 代码来源台账

| 来源固定点 | 许可与核对材料 | 复用边界与当前决定 |
| --- | --- | --- |
| [ZCode](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e` | 仓库 `LICENSE` 为 Apache-2.0（`references/zcode-29628c9/LICENSE`，SHA-256 `fa36dc312bc4946b1c22dba3c726ad8d3052b353f81424e7b997dbb3d9b40a49`）；`THIRD-PARTY-NOTICES.md` SHA-256 `874bf7c10bdcadd0df0b50fc782f39f077669c6e41bbdbccd868409cd714dec3`；`third-party/inventory.json` SHA-256 `e41227056f7bf82854335bf70c0ea70c160d2692a89e995cd30662415bbd6349`。 | 仅源代码可按 Apache-2.0 条件评估复用。分发复制件须附许可证，标明修改过的文件，保留适用版权、专利、商标及归属声明，并提供适用的 NOTICE 归属内容；该许可证不授予商标权（`LICENSE`:90–122、139–142）。未复制代码。第三方清单是跨工作区生产依赖并集，不是本项目或单个安装包的 SBOM，也不是完整许可认证（`THIRD-PARTY-NOTICES.md`:3–5、2421–2489）。 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84)，commit `639ed015397290b3745d163aafe02ffee4aa3f84` | 仓库源码 `LICENSE` 为 MIT（`references/dsh-639ed015/LICENSE`，SHA-256 `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be`）；`THIRD_PARTY_NOTICES.md` SHA-256 `c120aadac50ca6679ec5abe51eb94178fd038b29a1237d7a748dd0095a110670`。 | MIT 仅覆盖仓库中相应源码，不覆盖随应用分发的所有依赖。没有复制 DSH 代码。 |
| [Herta](https://github.com/PersonaCLI/Herta/tree/4623df120adf99340ce5f7e25ed829466975e3ae)，commit `4623df120adf99340ce5f7e25ed829466975e3ae` | 仓库 `LICENSE` 的 MIT 授权范围明确限于项目源代码（`references/herta-4623df12/LICENSE`，SHA-256 `bb1f011bb44b82acdcb078fdfcc2f7b6185c930b69a1ee275b518e79e32aea82`）；`THIRD-PARTY-NOTICES.md` SHA-256 `db21d2e69aef53aee3969b91e7d82e55319eb4fb62b2d0c50bf1d1cbcde14fd6`。 | Herta 源码许可不能作为角色、游戏文本、图像或声音的分发许可。仅评估可与源代码分离的 MIT 代码；本项目未复制 Herta 代码或资源。 |

ZCode 固定清单列出 1,206 个生产包记录、8 个 copied-source 记录、3 个 patch 记录、2 个 embedded 组件和 19 个 `reviewRequired` 项。19 项为：React Best Practices skill；`unsafe-pointer@0.2.0`、`react-remove-scroll-bar@2.3.8`、`quickjs-wasi@2.2.0`、`@hono/node-ws@1.3.0`、`strict-event-emitter@0.5.1`、`lazy-val@1.0.5`、`semaphore@1.1.0`、`boolbase@1.0.0`、`@open-draft/deferred-promise@2.2.0`、`is-node-process@1.2.0`、`ansi-to-react@6.2.6`、`keyv@4.5.4`、`@arms/rum-browser@0.1.8`、`@arms/rum-core@0.1.4`、`@arms/rum-electron@0.0.3`；Skia；QuickJS-NG；以及 `rust-standard-library@6a6eaca656978778f7c1c750ee0c3db87f8bffb2`。前 1 项缺完整原始许可/版权文本，后 15 个包缺版本对应的发布者许可材料，Skia 与 QuickJS-NG 的部分原生链接来源未完全确认，Rust 标准库缺原始 notice 快照。逐项原因以绑定的上游 inventory 为准；这些问题在任何拟采用相关 payload 前都须关闭。

DSH 有独立的非宽松许可边界：固定源码声明 `@anthropic-ai/claude-agent-sdk` 版本 `0.3.263`，以及 8 个对应平台包的许可字段为 `SEE LICENSE IN LICENSE.md`（`THIRD_PARTY_NOTICES.md`:35、152–165）。其上游许可证为 Anthropic 商业条款，且上游 README 将条款适用于面向客户的产品；DSH 自身对特定官方包的分发授权是身份和范围限定的，不会转移给本项目，也没有把条款变成宽松许可证。[固定版本许可证](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.263/LICENSE.md) · [固定版本 README](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.263/README.md)。若未来选用，必须先取得适用于本项目及产品场景的权利并审查实际平台 payload；当前未集成、未取得此项授权。

DSH 的 LibreOffice kit 六个 API/WASM/平台包声明 MPL-2.0，随包还需保留其源代码和 notices；向接收者提供相应源代码的义务不能由 DSH 根目录 MIT 许可替代（`THIRD_PARTY_NOTICES.md`:168–172；架构记录 `references/dsh-639ed015/.agents/notes/implemented/architecture/2026-09-14-independent-libreoffice-kit.md`，SHA-256 `414b970574b393f89b42ab247bd24f93ea99cd4ec7692ec3b283aea0da8ddedf`）。DSH 的 native/system 子项目另列 BSD-3-Clause（`native/system/LICENSE`，SHA-256 `fed2134d7f6af959ff9fbf2c0a35ea747db10e21d1b5d2d1ac58be88ce43ad90`）；它采用 Node-API v8，但 Linux glibc/musl 和 macOS 使用不同原生包，实际发行须按目标安装包盘点二进制、平台矩阵及通知（`native/system/AGENTS.md`:9–25，SHA-256 `ed6c16cdf91d87e8b66a154d3c63421716da7452177e490cd4d7d213e0d47805`）。

Herta 的语音音频是独立的角色资源排除项，当前没有取得其分发权。其第三方语音运行时包含静态链接的 eSpeak NG，声明 GPL-3.0-or-later；相关 voice model 下载还包含 `frontend/espeak-ng-data`。GPL 是已识别的源码许可，不表示必须另获版权许可；本项目未选择该组件。若未来纳入或分发，仍须按具体组合完成 GPL 对应源码、notice 和其他适用义务（`references/herta-4623df12/THIRD-PARTY-NOTICES.md`:64、1776–1796；`packages/gui/resources/licenses/espeak-ng-LICENSE.txt`:1–19，SHA-256 `bd9a0ebca85767af5420fd820343137c1a789dd4d05e9d6cafe75cae44997da5`）。不得把“上游存在源码许可证”误写成已闭合 GPL 分发义务。

## 角色与其他资产边界

独立资源清单在 [assets/manifest.json](../../assets/manifest.json)。当前 `approvedAssets` 为空。按 Herta 固定 commit 的 `LICENSE`:7–29，下列路径被明确排除于 MIT 授权之外，未经单独权利许可不得复制、改编或随包。本项目也将这些角色内容排除于训练/生成数据之外；这是本项目的使用边界，不是声称 Herta LICENSE 另行写有该条款：

- `packages/gui/build/**` 角色肖像图标，`packages/gui/resources/**` 角色美术资源；
- `packages/herta/prompts/**` 与 `packages/herta/prompts-en/**` 人格设定、设定语料和游戏对白；
- `website/src/assets/**` 网站图片与音频，`website/public/**` 网站图标与预览图；
- `data/voice/**` 语音文件（上游说明此目录不随其仓库分发）；以及上文单独列出的 GPL 语音运行时/词典数据。

Live2D SDK 与模型/角色资源的许可独立于上述源码许可。Live2D 官方许可页要求按实际产品用途与类别判断；AI/chatbot 和 Expandable 类别需在产品形态确定后分别核验。本项目目前未引入 Live2D SDK、模型或角色资产，亦未取得相关授权。来源：[Live2D SDK License](https://www.live2d.com/en/sdk/license/)（2026-10-01 由项目协调者核对）。

## 发行前关闭条件

当前版本只接受本地研究用途。任何对外发布前，至少要：

1. 锁定实际产品用途、分发方式和平台；按每个安装包实际 payload 生成 SBOM/notice 清单。ZCode 的跨工作区依赖并集不得冒充本项目安装包 SBOM。
2. 对确实采用的 ZCode 依赖关闭相应 `reviewRequired` 证据，并完成版本、版权/许可文本、补丁、复制源码、native/embedded 组件的逐包核查；无需采用的条目须从项目 payload 中排除。
3. 若采用 DSH Claude SDK 或平台 CLI，完成 Anthropic 商业条款和面向客户产品适用性的权利审查；若采用 LibreOffice kit，提供 MPL 对应源代码和 notices；按实际平台核对 DSH native ABI/二进制及 BSD 通知。
4. Herta 排除的角色资源/音频保持排除，除非取得独立权利许可；eSpeak GPL 运行时/数据在未选用前保持排除，若纳入则先完成适用的 GPL 义务；Live2D SDK/模型/角色资源在产品分类与许可确认前不得加入。
5. 对每个最终复制的源文件或资产记录来源固定点、SHA-256、修改情况、许可依据、授权状态和目标安装包；无证据或授权未知的项目保持 blocked，不进入构建产物。

本台账当前结论：代码可研究评估不代表资产可分发；代码许可与人物资源许可分账记录；目标产品候选源/资产文件 0，已批准资产 0。该计数仅指本项目候选/已跟踪路径，不包括隔离的 `references/`、`.runtime/` 副本或其依赖。
