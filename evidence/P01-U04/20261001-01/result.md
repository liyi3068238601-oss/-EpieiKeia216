# P01-U04：角色资产与加载器

作者状态：`ready_for_review`，前置 P01-U03 已独立验收。基线为 `11c0cbc`（完整值见 baseline.json）。本单元采用用户审核的精简人设 v3，继承 v2 的内容选择；不将游戏背景标成原创，不声明公开发行权利。所有先前版本与原生产配置保持原样，当前 hash 复查见 preservation.json。

六字段 identity/voice/values/boundaries/canon/examples 从已审核稿的对应标题直接提取，逐项记录来源路径、原稿 SHA-256、许可范围与虚构标记。examples 为新写的虚构风格样本，不能作为历史或执行记录；boundaries 是实际行为规则。角色剧情来自本地用户稿，未逐项核实官方剧情。

加载器固定角色、版本、文件名和已审核的 manifest/content SHA-256；同时修改资产及其自报 hash 也不能取得批准。读取前限制文件大小，拒绝路径越界和资产目录 junction；校验 schema、非空字段、UTF-8 单字段与总长度，返回深层冻结的数据快照。所有错误均抛出 CharacterAssetError，无通用身份 fallback，无资产写入 API。schema-only 验证不等于批准：只有经 loadCharacter 校验的快照进入私有 WeakSet，isApprovedCharacter 可供后续上下文层核对指令来源。

改动映射：任务卡的 `assets/character/`、`packages/character/`；必要支持文件为根 package.json/pnpm-lock.yaml/tsconfig.json、测试任务选择器 tools/run-tests.mjs，以及资产原始字节规则 .gitattributes。新增 @types/node 24.12.2 仅供类型检查（MIT，版本已有固定 ZCode lockfile 来源），没有运行时依赖。integration 命令先构建，保证干净安装后可直接测试。计划 tests/units/P01-U04.test.ts 映射到 packages/character/test/ 的 Node 内置 schema、type-contract、loader 测试。

借鉴固定 Herta 4623df120adf99340ce5f7e25ed829466975e3ae 的稳定身份前缀与动态记录分离方式，读取了 static-prefix.ts 与 LICENSE；没有移植代码或复制其角色文本、图像、声音。Node fs/crypto 文档用于核对标准只读文件与 SHA-256 API，实际运行固定 Node v24.14.0、pnpm 10.33.2、TypeScript 6.0.2。

最终 attempt-3：check 0；unit 9/9；contract 2/2；integration 23/23（含原 U03 15 项）。U04 选择器分别为 6/6、1/1、8/8，均 0 fail/0 skipped。build 在 unit/integration 命令中实际执行并通过。冻结 lockfile 的首次安装从没有 node_modules 的根目录开始，忽略安装脚本并使用隔离 store。原始命令、cwd、工具版本、exit code 和 stdout/stderr 见 logs/；代码差异见 implementation.diff。

attempt-1 失败与嵌套 pnpm 误用全局 Node 的问题见 initial-failure-note.json，原始日志完整保留。attempt-2 为首次修复后的验证；attempt-3 增加批准快照来源检查后重新验证。没有覆盖失败日志，也没有改全局工具。

限制：本单元是资产加载与只读接口验证，尚未接入产品 Hook 或给模型暴露工具；实际模型权限和无效身份阻断将在 U06 的真实运行时验收，U04 没有新增模型调用。文件路径检查是应用层边界，未证明能抵御恶意本机进程在文件读取期间并发替换目录；批准内容的 hash 仍是最终完整性条件。Core 不存在时边界扫描明确 NOT_RUN；eval/e2e 仍非产品通过。P01/G01 未验收。

回滚：revert 本单元独立作者提交，恢复其必要支持文件；先前角色版本、生产配置与 U03 验收历史不受影响。不能用只回滚资产而保留错误 approval pin 的半套版本启动。
