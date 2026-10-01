# P00-U02 隔离试验与复用决定

状态：ready_for_review。前置 U01 已 accepted，基线提交 `4eb4fbee15645d8d7c74239813f7da759983eb89`；源码提交未改变。本单元尚不开放 P01。

默认继续采用 v1.1 的 ZCode 主Runtime、Core上下文、独立DSH工作包、Herta合规记忆机制路线。采用范围和最小自研差额原则见 `docs/adr/P00-reuse.md`。本轮没有证据支持重写Loop、双模型人格改写或源码硬融合。

## 执行与证据

| 层次 | 实际结果 | 证据 |
|---|---|---|
| 固定 Herta 纯函数 | 分段/选择/保留分数正常、无效时间戳/system膨胀反例、尾段/再激活恢复；root独立重跑exit0 | herta-result/run/sources；review-pure-components.json |
| 固定 DSH transport + mock peer | receipt形状、handler error、notification、坏JSON后恢复、分块UTF8、close pending rejection；root独立重跑exit0 | protocol-report/run；review-pure-components.json |
| 固定 DSH SDK 实进程 | source fallback正常initialize、无adapter的失败、fresh client修正恢复与close；root独立重跑三个用例exit0，错误用例按预期捕获错误 | dsh-runtime-report/config；review-dsh-runtime.json |
| 固定 ZCode CLI 实运行 + mock模型 | 来源过滤构建成功，SessionStart/UserPromptSubmit到实际wire正文；正常/HTTP400故障/新运行恢复分别exit0/1/0 | zcode-preparation、zcode-mock-summary/requests；review-zcode-spike.json |
| 固定 ZCode CLI + 付费模型路径 | 用户指定7877，现有默认 `[基元]deepseek-flash`，1次HTTP200、CLI exit0、最终marker精确，2469输入+5输出=2474token | zcode-real-summary/requests/response；model-call-ledger；review-zcode-spike.json |
| Windows发行包/完整产品 | NOT_RUN；P00仍是接缝验证，未创建P01框架 | 由U11/U12按阶段候选产物复核；不得将本行算产品测试通过 |

外层工作目录为 `E:\Xiadie\Xiadie`；SDK parent实际cwd为 `.runtime/P00/dsh/source`，CLI和SDK child cwd为各自合成fixture。命令/exit/stdout/source/产物SHA各自见对应JSON。mock费用0；DSH initialize不发prompt且只用假key；ZCode真实模型金额未由网关报告，不能写成免费或按官方DeepSeek价格代算。

## 隔离、失败与限制

安装依赖只在忽略的 `.runtime/P00` 独立Git checkout，参考树保持只读干净。生产配置/凭据/旧项目未改；ZCode对四份选定全局配置前后SHA核对一致。环境和配置隔离不等于Windows OS沙箱。真实模型请求中tools字段缺席，两段Hook独有内容与选定模型/token参数由relay重新核对；凭据仅relay内存使用，不进入child或Git。

7877实际配置是 `http://47.108.250.118:15555/v1`；同端口HTTPS探测失败，HTTP明文传输是已知限制，在用户选定既有路由的授权范围内只做短样本调用。保留第一次model-capability配置失败、错误hook wrapper gate失败、遗漏端口的preflight失败，以及DSH初次TS模块类型错误；报告明示这些失败和修复，没有将失败冒充成功。

恢复范围分别为纯函数输入重算、mock transport同端点坏帧后恢复、SDK/CLI全新进程重新运行；本单元不声称会话持久化恢复。ZCode本轮是隔离user hook，官方plugin/compact/resume/工具失败及scope权限矩阵留在U07/U08；DSH只有initialize实测，prompt/业务结果/进程树取消/检查点在U09验证。Herta没有安装整工程、运行持久化/Dream产品或复制被排除角色素材。动态配置SHA是追溯证据，真实preflight绑定source/CLI/runner/hook，不绑定每个端口变化的配置文件。

## 测试映射与回滚

计划 `tests/units/P00-U02.test.ts` 映射到 `spikes/P00/herta-pure/poc.mjs`、`dsh-protocol/protocol-poc.mjs`、`dsh-runtime/init-only.ts`、`zcode-runtime.py`及独立replay。预期bad route返回异常而driver exit0，是测试正确捕获失败，不是SDK业务成功。

采用决定、raw-byte属性与当前证据需独立审查后才由协调者记accepted。回滚优先revert本单元独立提交；保留忽略目录中的失败fixture，不删除源ZIP、生产资料或旧路径文件。远程发布未授权且未执行。
