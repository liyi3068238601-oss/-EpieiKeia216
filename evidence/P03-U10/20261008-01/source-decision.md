# P03-U10 来源采用决定

采用固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的 Native ZCode。实际 Native checkout、候选 descriptor 和 U01 source manifest 均在 `freeze.json` 中绑定。复用范围包括 memory context/prompt、project-memory adapter、event/store 集成及 Desktop CLI 路径。Native 存储实现使用 `node:sqlite`；Xiadie 自有 CLI 使用另一套 `better-sqlite3` 13.0.3，带独立 MIT license 和 addon。

固定提交的源码位置：

- https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/context/sections/memory.ts
- https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts
- https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/memory/index-content.ts
- https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/memory/memoryService.ts
- https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts

`repositoryInputs` 分组沿用 0.2.0 freeze 的结构。`freeze.json` 按实际 tracked path 记录每项 bytes 与 raw SHA-256，分组允许重叠。tracked project-note 模板另行绑定：`templates/project-note.md`，729 bytes，raw SHA-256 `e3bf45a10958f296e39769ac216ba6993265cf71fc13eb0ae31edc67514e742d`。U10 full/degradation 命令记录按原始字节复制，并在 command index 中记录精确 SHA-256。

许可证据逐字节绑定 Native LICENSE、NOTICE、CLI THIRD-PARTY-NOTICES 的来源文件和候选副本。原始角色素材与原始 prompt 的来源及许可仍为 NOT_VERIFIED。

M2 依据已接受的 U03/U06 迁移 API 实际验证证据和 U09 回归；迁移后 App 端到端仍是 NOT_RUN。输入字节保持一致不等于内容为语义真相，也不能证明模型行为符合记忆策略。本轮项目记忆组合未启用 Native writer，也未建立第二个事实数据库。更多运行边界见 README，回退方式见 rollback。
