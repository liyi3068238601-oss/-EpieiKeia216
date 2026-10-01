# P00-U02 ZCode 最小运行路径

状态：ready_for_review。固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e` 的独立源码 checkout，经 pnpm 10.33.2、Node 24.16.0 构建得到 CLI；没有修改上游源文件、生产 ZCode 或全局配置。安装使用 frozen lockfile 和 ignore-scripts；完整命令、cwd、exit、下载 integrity、输出 SHA 见 `zcode-preparation.json`、`zcode-tool-download.json`。

## 已执行

- `python spikes/P00/prepare-zcode.py install`、`build`、`version`：均 exit 0。官方 CLI 与其依赖的过滤构建成功；不是完整桌面构建或 Windows 安装包验收。
- `python spikes/P00/zcode-runtime.py mock`：固定 CLI 执行 SessionStart/UserPromptSubmit，正常 HTTP200、注入 HTTP400 故障、故障后的全新 CLI 运行恢复，最终退出分别 0/1/0。恢复是新的进程和 fixture，不是同会话恢复。
- `python spikes/P00/zcode-runtime.py real`：7877 的 `[基元]deepseek-flash` 实际调用 1 次，HTTP200，CLI exit 0，最终 assistant `response` 精确为 `P00_ZCODE_OK`。实际 usage 为输入 2469、输出 5、总计 2474 token；隐藏推理与缓存 token 均为 0。网关没有返回金额，不能把未报告费用写成免费。

以上外层命令 cwd 均为 `E:\Xiadie\Xiadie`；CLI 子进程 cwd、argv、exit、事件与请求正文见各 summary/request/log。请求实际含两个以 `<system-reminder>` 包裹的 hook additional context，位置在最终用户 prompt 前；wire tools 字段缺席，工具数为 0。mock peer 与实际模型结果分开保存。

## 隔离与门槛

每个用例独立 USERPROFILE、数据根、temp、fixture Git 根；HOME 和所有真实凭据不传给 CLI。配置只含本地 relay 地址和假 key；7877 凭据在 Python relay 内存中读取，通过 Authorization header 发往已配置网关，不落盘到配置、证据、日志或Git。真实运行检查固定源码 HEAD/clean、CLI、runner、hook SHA 与已通过 mock 绑定；每次请求重新核对模型、0 工具、两个 hook 独有上下文、路径与 max_tokens≤1024。动态配置 hash 有记录，未作为放行门槛。四份选定生产配置文件的运行前后 SHA 相同；这不是对整个生产目录的穷尽审计。

实际网关为 `http://47.108.250.118:15555/v1`，HTTPS 同端口无认证探测失败，HTTP 无认证返回401；HTTP 使用者指定的现有路由，凭据跨网络传输不加密是已知限制。没有修改网关设置。凭据只在内存中不等于网络加密。

## 已保留失败

首轮设 `supportsToolCall=false` 仍保留13个注册工具，运行在发请求前失败；已保留 `zcode-mock-initial-failure-*`。修正为 CLI 原生 disallowed-tools 后，wire tools 才真正为0。一次 relay hook wrapper 检查误用类型名称 `hook_context` 作为文本标签，正确 wire wrapper 是 `system-reminder`，该失败也保留为 `zcode-mock-hook-wrapper-failure-*`。一次真实模式 preflight 因硬编码遗漏网关端口而退出，没有发送模型请求；已核对本机配置并修正端口。不得将这些失败计为成功或收费模型调用。

## 采用范围

支持继续验证“ZCode 原生 Loop + 外部上下文 Hook”的默认路线；本轮用隔离 user hook 配置验证最低成本接缝，官方插件布局、新会话/恢复/compact/工具失败及执行端权限矩阵仍属于 U07/U08。没有重写 Loop、增加人格二次模型改写或启动 P01。

测试映射：计划目标 `tests/units/P00-U02.test.ts` 对应此单元的 Python driver、Node hook、Herta纯函数与DSH transport PoC。回滚用独立提交 revert；忽略目录保留失败工作树和合成数据，不删除生产资料。
