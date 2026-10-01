# 隔离目录之外的读取边界

主控于 2026-10-01 沿固定 ZCode `apps/zcode-cli/packages/adapters/src/context/index.ts` 复读：用户指令使用 `env.HOME || env.USERPROFILE || os.homedir()` 定位 `.zcode/AGENTS.md`（约 229–247 行），不跟随 ZCODE_DATA_BASE_DIR。项目指令沿 cwd 上溯到识别出的 project root；仅更改 --cwd 和数据基目录不足以保证不会读到真实用户指令或父项目。

U02/U07 的子进程使用受控完整环境：不继承 HOME、模型密钥或插件变量；USERPROFILE 指向试验用用户目录，ZCODE_DATA_BASE_DIR 另指向试验数据根；fixture 建立独立 Git 根。只改变子进程环境，不修改用户系统变量。请求先通过本地 mock/capture 端点核对合成上下文，再允许同一端点通过内存持有的授权凭据转发 7877；真实密钥不会写入 ZCode 配置或请求快照。

DSH SDK 的 env 同样是替换而非自动脱敏，调用方必须给完整受控环境和显式 DSH_HOME。sdk/base 的默认工具很宽；“不要调用工具”的 prompt 不构成权限边界。先裁剪实际 profile 工具，再观察最终模型工具 schema，未裁剪成功不得开始真实调用。U08 的负例还须在执行端拒绝写入，不能仅在模型可见工具名上做文章。

以上是从源码得出的试验前置要求，尚未作为实际隔离、模型调用或权限测试通过。最终仍记录读写路径、真实 request body、工具结果和生产配置前后哈希。
