# P03-U10 回退

如需回退，应针对独立的 U10 提交创建一个普通 `git revert` 提交，不重写共享历史。保留原 U10 提交、此前所有已接受记录、失败证据和候选 proof；不得删除或改写这些 evidence。本作者材料不改变 canonical acceptance。helper 不执行 remote、tag 或 release 操作；按 root gate 已准备的普通分支备份进行审查和回退。
