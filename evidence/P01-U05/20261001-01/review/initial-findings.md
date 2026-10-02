# U05 初始审查发现（修复前候选）

状态：修复前审查记录；对应作者分支 p01-u05 的未提交候选，不是 author_commit，不代表接受。候选基线 HEAD：01f3f8700ada91ef6756a184fe5ea029d432f530。
修复前 manifest 原件另存为 manifest-pre-repair.json，SHA-256：7a189eeb4b1d196bfe4f931c31180f88e4af84fbb638afe24743fb543ae7a051；随附原始 sidecar：7a189eeb4b1d196bfe4f931c31180f88e4af84fbb638afe24743fb543ae7a051  manifest.json。
修复前代码差异另存为 implementation-pre-repair.diff，SHA-256：4bdf2dcfc92c6f21e9b09f59d6e54355d534fa1e9cfdc9597e6f48f55fde6e23。

独立审查在修复前构建输出上执行只读 probe，复现三个入口缺陷：

- max_tokens Proxy get trap 在描述符校验后返回序列 32768、1、2、1048577，renderer 最终输出 1048577，超出 MAX_BUDGET=1048576。
- source_refs Proxy get trap 让校验读取一条引用、后续 map 读取 17 条，绕过每记录最多 16 条的限制。
- nested Proxy 的 get trap 在 JSON 校验后被 snapshotJson 再次读取时运行。

原始 probe 位于只读复核目录 E:\Xiadie\Xiadie\.runtime\P01\u05-review。proxy-probe.mjs SHA-256：fc0c387a256959b67cf9ef1c6fbdbe291b531223e3bf2dc352689a98eb19145c；stdout SHA-256：2bba671da7c5f720784024a9a1124182ecee03ecb85e082bf70a87f131962e5a；stderr SHA-256：e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855。日志记录 Node v24.14.0。

修复采用单次描述符快照后再验证副本，不读取输入对象的普通属性、不执行 accessor；拒绝非 JSON 原型、accessor、hidden/symbol 字段、稀疏数组和 non-finite number。Proxy 的 getPrototypeOf、ownKeys、getOwnPropertyDescriptor 等反射 traps 仍可能运行，因此实现不声称拒绝全部 Proxy 或提供进程内沙箱；捕获后的快照内容仍严格验证并只能进入调用方 data 分区。修复后的复测另记 attempt-4。
