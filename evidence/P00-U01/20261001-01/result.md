# P00-U01 调查提交

状态：ready_for_review。三个分项已到场，分别在 review-zcode.json、review-dsh.json、review-herta.json 通过独立研究审查；根文件在 review-root.json 与 review-root-supplement.json 通过分域审查。最终接受与冻结记录由协调回执给出，研究审查不代表 PoC 通过。

基线：本机最初仅两份压缩包；执行以 v1.1 ZIP 为准。迁移到 E:/Xiadie/Xiadie 后重验原 ZIP、423 个规划文件和三个固定源码树，全部吻合。未编写产品代码，未运行模型生成或产品测试。

采用候选见 `docs/research/P00/source-decision.md`；ZCode、DSH、Herta 的分项报告必须全部到场并通过各自复核，才能关闭整体 U01。参考树独立、只读且未安装依赖；不能把源码阅读记为兼容性通过。两份 Library 历史原文未取回，明确保留 Unverified / Source unavailable。

## 实际命令与可追溯证据

本目录 `baseline-verification.json` 是 `python docs/research/P00/verify-baseline.py` 在新根执行、exit 0 的实际结果；核验上游 HEAD、tree、clean，以及 ZIP 与 manifest 哈希。计划结构验证实际 stdout 保存在 `plan-validation.txt`。迁移前后每个文件的 SHA-256 保存在 `relocation.json`，其范围是迁移时刻，后续提交自然改变 Git 元数据。

只读模型配置调查脚本与元数据分别是 `inventory-runtime.py`、`model-inventory.json`。7877 元数据探针脚本与实际结果分别是 `probe-gateway.py`、`gateway-metadata.json`：GET /v1/models 返回 200，已配置默认模型存在；模型生成请求为 0。真实凭据未打印、未复制到 Git。授权记录见 `authorizations.json`；用户指定 7877 和预算无上限，使用已有默认 `[基元]deepseek-flash`。

命令回执和各来源完整 SHA-256 随本次提交一起冻结。新增调查文件是本单元差异；不可变 planning 原文没有改动。

## 限制和下一步

Hook 注入是有截断的补充上下文，不能作为权限机制；memory 工具集必须观察最后实际结果；DSH 协议无 cancel/session-close/审批回传。U02 要先 mock 再在独立数据根跑正常、失败、恢复；U07–U09 再扩大到规定矩阵。关键 PoC 未通过之前不批准 P01。

回滚：revert 本地调查提交；保存试验失败证据，不动现存 .zcode/.dsh、D:/ZCode 或 DSH 用户资料。未发布远程分支、tag 或包。
