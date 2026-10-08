# P03-U09 阶段集成与独立回归

作者状态：ready_for_review。独立验收：pending。最终实际执行信息和精确 raw hash 见 result.json；准备性 source-adoption.json 保留开工时快照。

最小产品修正是 capture 最后一次重验时保留 unreadable/PERMISSION_DENIED，并清空未验证内容和元数据。最终 Native/Windows ACL selector 13 pass、0 fail/skip：八个真实 Native 场景、三个真实 ACL 场景和两个父检查。ACL 恢复后 DACL 原始哈希一致；denied capture resolve=2，恢复后总计=4。U03–U08 相关回归通过，U03 一项文件 symlink 权限 skip 和 U07 的 EPERM 探针仍未执行；子流与外层计数不相加。

实际新候选完成 Electron UI → Native CLI → Host → 选中 Native raw memory Read，验证成功、未选主题拒绝和取消/恢复。父进程在应用启动前保存 receipt 原始字节与副本，结束时核对五份源文件、精确文件集、Reader audit、SQLite ledger 和既有 profile/registry 保护。候选保留 Apache LICENSE、原始 NOTICE 和 CLI 第三方 notices，绑定 owned SQLite 完整 lib/addon 及全部 owned 文件。

三项 G03 Must 分别结合 U08 无自然衰减、U03/U06 真实迁移/回滚与原始 hash 追踪、U04/U05 读写权威及本次实际 Native/应用 Read 证据；这里只提交作者材料，不关闭 G03。U10 将对实际候选重跑冒烟及无 Key/无 DSH/离线降级。

模型是合成 loopback mock。未运行付费模型、实际 DSH、安装态应用或 portable installer；依赖 junction 使产物仍是本地开发候选。Native reopen 是同进程 close/create，不能声称进程重启。Desktop 取消路径证明新 capture/回复，恢复后的实际 Read 在 Native worker 覆盖。动态监听器在启动前实测；CDP 请求 0，未独立记录最终 CDP 端口。Native mock 的 inbound socket 计数不证明 OS 全局 egress，Desktop instrumentation 也不是 OS sandbox。

失败/被替代记录和 fixture 保留；详情见 result.json。回滚只 revert U09 独立提交，历史阶段、原始计划、Native 参考和生产数据保持原位。
