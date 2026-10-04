# P02-U11 来源与实现边界

本单是冻结和证据整理，不改变产品代码、上游源码、Native、配置或依赖。采用的源码仍固定于 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，candidate09 的材料提交为 `cd03ddc3a3f6f7ca67b4313e309db20db4755343`；descriptor 的 103 个输入均与本次 author baseline 的 Git blobs 一致。由于所有材料字节与已接受 U10 candidate09 一致，按既定决策复用该候选，仅在 U11 的新独立 owned 输出目录重新运行 actual Desktop full/degradation。

P02 事件账本和备份协调器采用 U05/U08 已接受的 `better-sqlite3` 13.0.3 / SQLite 3.53.4。运行包由 candidate CLI 自有 `dist/node_modules/better-sqlite3` 闭包提供，固定 Windows addon 为 `prebuilds/win32-x64.node`，SHA-256 `e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a`；本闭包含 26 个 runtime 文件，包许可证为 MIT。运行时以 Electron 41.0.3 executable 的 `ELECTRON_RUN_AS_NODE=1` app-server 启动，actual CLI PID 的 `process.dlopen` sidecar绑定包路径、文件哈希与 SQLite 版本。独立 Node 24.14.0 reader 不作为该加载证明。

上游 ZCode 来源固定于 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，其 Apache-2.0 license 与 third-party notices 被候选 descriptor 绑定。仓库中的 root version 是 0.2.0，身份插件维持独立版本。Better 的依赖包 license/hash 在 candidate descriptor 内绑定。角色公开分发权没有被本单判定。

Native 主体目前仍由 `node:sqlite` 保存其原生会话数据；成熟 Better binding 仅用于接受的 P02 durable event-store/backup 路径。没有把 Native 的 SQLite 实现改写，也没有把两个 SQLite 边界混成一个版本声明。

U11 的 requirement mapping 继承已接受单元事实：R03 来源与 artifact/receipt provenance；R04 terminal identity、持久事实与隐私边界；R05 重开恢复、unknown-effect 不盲重放；R24 在线备份/新根恢复与 future/nonempty 拒绝。本次 fresh success 确认 candidate 的备份/恢复字节和 canonical ledger 表 hash 一致。详见 `freeze.json` 的分组 SHA、candidate proof 和 raw runtime sidecar indexes。
