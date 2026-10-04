# P02-U11 回滚与保留

本 attempt 仅在 `b95cfd2be02959dd8c390e2b141d24d1093daf81` 基线上增加 `docs/releases/0.2.0/` 冻结文档和 `evidence/P02-U11/20261004-02/` 证据；没有修改产品源码、Native、安装目录、用户配置或注册表值。若 U11 独立 review 未通过，保留本 attempt、所有失败命令和 candidate09 原始输出；只撤销本作者提交即可恢复该 baseline，不删除历史证据，也不覆盖用户文件。

运行输出全部使用 `.runtime/P02/experiments/mature-freeze/{full,degradation}-candidate09/` 的 owned 测试 profiles；没有执行安装或产品数据迁移。candidate09 和原始 U10 attempt 继续在其原路径保留。不要把 Better 数据库直接交给仍使用 Native `node:sqlite` 的旧组件，也不要因 author review 失败就盲目降级/删除账本。任何未来数据迁移/回退都必须先单独验证 U08 备份并对新根恢复验真，再按批准的产品变更处理。

当前被冻结的旧 README/freeze 以 Git raw blobs 保存在 `docs/releases/0.2.0/history/20261003-01/`，SHA 和逐字节比较见 `historical-release-copy.json`。本单停在 G02 独立审查，不触发远端 tag、上传、发布或 P03。
