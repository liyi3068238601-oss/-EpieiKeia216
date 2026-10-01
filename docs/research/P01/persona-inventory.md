# P01 人格材料盘点

日期：2026-10-01。只读调查范围：当前工作区及 P00 既有授权清单；没有搜索用户全机或生产 profile 内的会话、数据库和凭据。

结论：现有可访问资料不足以成为 P01-U04 的“已审核人格素材”。本报告不把计划目标、示例 Hook 或模板当作已经存在的人设资产。

| 来源 | 实际状态 | 决定 |
| --- | --- | --- |
| `docs/baseline/local-inventory.md`、P00-U03 接受记录 | 授权历史目录 `E:\Xiadie\Xiadie-next` 在该次盘点中不存在，未扩大搜索范围 | 原有人格材料未知；不能推断全机不存在 |
| v1.1 计划、角色与 narrative 操作模板 | 描述目标和待输入角色规则；没有 identity/voice/values/boundaries/canon/examples 正文 | 作为需求，不作为运行资产 |
| 旧 Library 的产品需求说明与 foundation design | P00-U05 已记录 Unverified / Source unavailable | 不补写成“已读”或恢复原文 |
| `assets/manifest.json` | `approvedAssets=[]`，没有目标 `assets/character/` | 等待可审阅的原创材料或用户给定资料路径 |
| Herta persona/prompts/对白/图像/声音 | 明确排除于此次源码复用范围 | 不移植或替换成遐蝶资产 |

主控复核时，上述材料哈希和接受记录将写入 U01 verification。两种可行输入路线：审核本项目新撰写的最小原创草案；或按用户指定的本地资料路径只读审核现有材料。草案见 [persona-proposal.md](persona-proposal.md)，当前不属于已审核资产。

## 用户提供的新来源

本轮用户指定 Neo-MoFox 的 `core.toml` 并要求简化。现已只读解析其中的人格字段；生产文件的读取前后 SHA-256 一致，未复制其余运行配置。原稿是游戏角色遐蝶的人设材料，包含重复性格描写、较长剧情、QQ 专属规则及与项目真实性要求冲突的身份否认规则。

整理结果见 [persona-from-mofox.md](persona-from-mofox.md)，统计及源哈希见 [persona-source.json](persona-source.json)。先前 [persona-proposal.md](persona-proposal.md) 是未获采用的通用原创提案；新稿保留用户提供的角色背景，等待具体正文审核。用户拥有本地配置不等于取得角色公开发行权；不把本稿标为已审核、原创角色或可公开发行资产。

随后用户决定“本次使用精简版，但所有版本都保留”。审核时文件原样冻结为 v2；当前 v3 仅澄清状态、背景资料来源和实际运行状态。采用记录见 [persona-decision.md](persona-decision.md)，各版哈希见 [persona-versions.json](persona-versions.json)。本地采用已获批准，尚未进入 U04 运行资产；先前的待审核记录保留为调查过程，当前状态以采用记录为准。
