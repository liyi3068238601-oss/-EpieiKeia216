# 已安装 CLI 的只读入口调查

2026-10-01 在 `E:/Xiadie/Xiadie` 执行，环境 `ZCODE_DATA_BASE_DIR=E:/Xiadie/Xiadie/.runtime/P00/discovery`：

- `node D:/ZCode/resources/glm/zcode.cjs --version`：exit 0，实际输出 `0.16.9`。
- `node D:/ZCode/resources/glm/zcode.cjs --help`：exit 0；提供 app-server、单次 --prompt、--cwd、--mode、--resume、--continue、--disallowed-tools 等入口。

这两次是 CLI 元数据调查，不是模型试验、权限验收或固定源码构建。版本号与固定源码 CLI workspace 的 0.16.9 一致，也不证明二进制来自相同提交；U02 默认仍使用固定源码的隔离副本。没有打开 UI、修改安装目录或加载生产会话。
