# P00-U04 版本与工具链锁定

作者状态：`ready_for_review`。前置 U03 的整体 `acceptance.json` 已通过；本单元没有开放 P01。

`docs/sources.lock.json` 锁定 ZCode、DSH、Herta 三个精确提交、Git tree、根包声明版本、Node/pnpm 约定、manifest 和 lockfile 的工作树与 Git blob SHA。三个任务卡固定官方 raw 链接实取 HTTP 200，与本地固定提交的 Git blob 逐字节一致。当前 remote HEAD 单列观察值，保持选定 pin，不跟随 latest。

本机实际 Node 为 `24.16.0`、Windows x64、模块 ABI `137`、N-API `10`。ZCode 上游工具链指定 Node `24.14.0`，本次试验采用 `24.16.0` 的差异保留。实际使用隔离 pnpm `10.33.2` / `11.7.0`，没有使用全局 pnpm，也没有重新安装依赖。Python 与 HTTP/YAML 库仅为试验驱动，实际版本与可执行文件哈希单列；不将 Python 选为产品运行时。

Herta 仅采用已复跑的纯函数参考；未安装其 pnpm/native/GUI 环境。DSH 只验证 SDK source fallback，没有完整 native/desktop build。Node ABI 不能用于推断 Electron、SQLite 或其他平台二进制兼容，更不能将三套依赖图强塞进同一进程。

实际命令 `python evidence/P00-U04/20261001-01/probe.py`，cwd `E:\Xiadie\Xiadie`，exit `0`。其内部 Git/Node/pnpm 命令、退出码及输出或输出哈希见 `commands.json`；固定 HTTP 来源和验证结论见 `verification.json`。大段 lockfile 输出保存在固定 Git 对象中，通过原始输出字节数和 SHA 核验，不在证据重复复制整个依赖树。

采用现有 pin 与各自 lockfile；未来升级须新建独立副本、用该源码指定 pnpm frozen install 并重新验收。回退入口为已锁提交的 detached checkout 或新建隔离 clone，禁止 reset 用户 checkout。历史全局安装版本不能替代固定提交的证据。

测试映射：任务卡目标 `tests/units/P00-U04.test.ts` 映射为本 attempt 的真实 `probe.py` 校验，不引入产品测试框架。此次没有模型请求、第三方资产复制或产品构建。修改仅包括来源锁和本单元证据；回滚本单元提交即可，保留旧工程、参考树和全局工具。
