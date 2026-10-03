# P01-U11 来源与采用决定

本次冻结沿用已接受的 P01 采用路线，没有新增来源下载、网络调用或模型请求。

- **Runtime 与 UI：** 采用 zai-org/ZCode 固定提交 29628c9acdb81b703bbd4080c207a0e7ce5e276e。候选继续使用 ZCode 原生 UI、provider registry、model adapter、Runtime 和 CLI；U10 factory 替换固定 bootstrap 接缝，不另造 renderer。按 Apache-2.0 使用并保留上游 LICENSE/NOTICE；来源锁在 [docs/sources.lock.json](../../../docs/sources.lock.json)。
- **角色身份：** 采用 P01-U04 已接受的 Xiadie persona v3 和资产 manifest，hash 见 [baseline.json](baseline.json)。保留原游戏背景和已有版本；本项目不主张遐蝶为原创 IP，也没有据此取得公开发行、素材再分发或商业授权。
- **模型资格：** U09 获批真实请求额度为 18 次（U02 4 次生成、U09 14 次评测）。deepseek-flash 是唯一合格候选；deepseek-v4-pro 已测但未合格；人工审阅为 not_reviewed。U10/U11 没有额外官方请求，U11 Desktop 模型路径均为隔离 loopback mock。
- **资源与锁：** 冻结绑定 candidate descriptor 的 66 个项目输入、6,673 个产物和 CLI bundle。persona、schema/manifest、插件资源、实现与测试、lock/config 的分组 SHA-256 见 [baseline.json](baseline.json)；50 个冻结输入的独立清单见 [freeze-inputs.json](coordinator/freeze-inputs.json)。
- **采用边界：** 这是本地开发 assembly。sidecar 用于宿主核验，不是 UI 证据面板；网络 guard 仅为进程 instrumentation。DSH 产品集成、安装器/portable 交付和 P02 持久层均未进入本单元范围。