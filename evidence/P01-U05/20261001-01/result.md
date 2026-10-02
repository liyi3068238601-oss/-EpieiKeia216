# P01-U05：ContextPacket 契约

作者状态：`ready_for_review`。工作树基线：`01f3f8700ada91ef6756a184fe5ea029d432f530`；前置 P01-U04 已 accepted，作者提交 `122d3028385469a3704249f8df17e013cf880456`。

实现把 `ContextPacket` 定义为 runtime-neutral、readonly JSON 契约，固定 `instruction → state → evidence → content` 的渲染顺序。instruction 只能从 `isApprovedCharacter(character)` 为真的 U04 加载快照生成，内容限 identity、voice、values、boundaries、examples；canon 作为 `fictional-character-canon` 放入 state。调用者只能传入 state、evidence、content，未知键（包括伪造 instruction）会拒绝。可信事实和 source_refs 仅保留在各自数据分区，不增加指令权限。

builder 先从属性描述符捕获有界的独立快照，再校验 plain JSON、精确对象形状、非空 bounded source_refs、scope/version、记录数量、深度和输入字节数，并深层冻结输出。原输入的 getter/accessor 不会被执行；Proxy 的普通 `get` trap 不参与读取。Proxy 反射 traps（如 `ownKeys`、`getPrototypeOf`、`getOwnPropertyDescriptor`）仍可能运行，因此这不是拒绝全部 Proxy 或提供进程内沙箱；其结果仍按数据快照严格验证并留在调用方 data 分区。builder 拒绝隐藏/符号字段、稀疏数组和 NaN/Infinity 等非 JSON 值。renderer 只接收本进程 builder 创建的 WeakSet packet；复制或反序列化的 packet 必须由批准角色和数据重新构建。JSON 字符串使用正确 escaping，嵌套对象键排序；预算以完整输出 UTF-8 字节数作为 `utf8-byte-upper-bound` 估计，超限整包抛错，不截断。预算只覆盖 ContextPacket JSON，不包括宿主原生 system/project 规则，也不是模型 tokenizer 的实测 token 数。

任务卡目标 `packages/contracts/context.ts` 映射至现有源码结构 `packages/contracts/src/context.ts`；新增实现位于 `packages/context/src/`。U05 单元、契约、集成映射分别登记在 `tools/run-tests.mjs`，未改锁文件、未加运行依赖。设计只参考固定 Herta 提交中稳定身份与动态记录分区和有序序列化测试；没有复制 Herta 源码或角色素材。来源、许可范围和各文件哈希见 `source-decision.json`。

固定工具链安装：`pnpm install --frozen-lockfile --ignore-scripts --store-dir E:\Xiadie\Xiadie\.runtime\P01\pnpm-store-u04`，Node `v24.14.0`、pnpm `10.33.2`、TypeScript `6.0.2`。修复后的 attempt-4：`pnpm run check`、`pnpm run build` 均 exit 0；U05 unit 10/10、contract 1/1、integration 2/2；合并 U03/U04/U05 选择器后 unit 19/19、contract 3/3、integration 25/25，均 0 failed、0 skipped。新增回归覆盖 accessor 不执行、Proxy `get` trap 不参与快照读取及 non-finite number 拒绝。原始 stdout、stderr、cwd、命令、exit code 与 UTC 时间见 `logs/attempt-4/`。Frozen install 和早期成功运行输出保存在 `logs/attempt-1/` 至 `logs/attempt-3/`，未覆盖；修复前审查反例和 manifest 快照见 `review/`。

边界扫描输出 `BOUNDARY_SCAN_NOT_RUN`：`packages/core` 当前不存在，因此没有 Core import 可扫描。没有启动 Desktop、Core 或模型，没有模型调用；真实 hook/runtime 行为和 tokenizer 预算仍未验证，属于后续集成范围。回滚方式是仅 revert 本单元作者提交；U04 批准素材和验收历史不变。

实现差异见 `implementation.diff`。交付状态保持 `ready_for_review`，待独立审查后再决定是否接受。
