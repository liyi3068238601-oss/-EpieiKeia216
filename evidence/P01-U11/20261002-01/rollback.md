# P01-U11 回滚说明

U11 增加冻结/证据文档，并保留一项五行测试 harness 快照命名修正；candidate、用户数据、生产 Runtime 配置和数据库未修改，也没有生成可发布安装包。

若独立审查拒绝或发现冻结记录不准确，保留 runs/final-01 与 runs/final-02 原始证据，修正文档并按审查结论重跑受影响验证。不要删除 final-01 的 EEXIST 失败记录，不要将 runner 失败改写为通过。

若只需撤销本次文档提交，可在 p01-u11 worktree 对该提交执行 git revert <P01-U11-docs-commit>；不要回退 P01-U10 accepted baseline 或覆盖其他已接受单元。测试命名修正属于 U11 execution commit，应由独立审查决定是否保留；需要撤销时只撤该单元提交并保留失败 run。

本单元没有数据迁移。P02 尚未启动；未来涉及数据库时，须先独立验证备份和恢复，再实施回滚。