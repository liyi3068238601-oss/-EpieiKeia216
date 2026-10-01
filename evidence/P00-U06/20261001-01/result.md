# P00-U06 结果

状态：`ready_for_review`。基于已接受的 P00-U05（`evidence/P00-U05/20261001-01/acceptance.json`，SHA-256 `4f59ab227d56e62bfe05ff22cc5244e7843e7b939911696d62cb78ec13008db6`），在基线 `1288e8545ab8d2f39a59de554b2546bb793ff305` 新增代码许可边界台账和独立资产 manifest。没有复制参考代码、角色 prompt、图像、音频、语音运行时或模型；未进行构建或产品分发测试。

代码与资源边界已分开：ZCode Apache-2.0、DSH MIT、Herta MIT 的范围仅按各自仓库文件和依赖声明记载；DSH 的 Claude SDK 商业条款、LibreOffice kit MPL-2.0、native/system BSD-3-Clause，以及 Herta 的 eSpeak GPL-3.0-or-later 作为独立条件列出。Herta 角色 prompt/对白/图像/声音与 Live2D SDK/模型均未批准。Herta 角色声音权利与 eSpeak GPL 运行时义务分开记录：前者未获许可，后者已识别 GPL 但项目未选用，实际 payload 的 GPL 义务未验证。ZCode 的 19 项 reviewRequired 已列明；其 1,206 项第三方清单是跨工作区依赖并集，不能替代本项目逐安装包 SBOM。

基线 Git 候选源代码/资产扫描结果为 0，七个候选目录也均不存在。`assets/manifest.json` 的 `approvedAssets` 保持空数组。产品 `0.0.0` 仅限本地研究；未来发行仍 blocked，需先完成台账中逐包、逐平台和资源权利关闭条件。没有结论声称第三方许可证已全部清除。

实际命令、cwd、退出码、来源固定点与输入/产物 SHA-256 见同目录 `verification.json`。回滚只需移除本单元新增的两个目标文件和本次证据目录；目前尚未提交，未涉及外部状态。

测试映射：目标 `tests/units/P00-U06.test.ts` 本次映射为 `verification.json` 中的 JSON 解析、来源 commit/SHA、候选路径计数及文本格式核验；未创建产品测试框架映射，产品构建/分发测试为 `NOT_RUN`。
