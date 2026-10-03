import hashlib
import json
import pathlib

root = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
review = root / ".runtime/P02/reviews/u08-final"
worktree = root / ".runtime/P02/worktrees/u08"
author = "066125b86ad01ed811ed88c1da4fb3d91aa884e3"
baseline = "6198ddcf963c7ee594b983f3b1c1fe33f692fb15"
audit = json.loads((review / "audit-results.json").read_bytes())
author_evidence = worktree / "evidence/P02-U08/20261003-01"
command_index = json.loads((author_evidence / "command-index.json").read_bytes())

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def bind(path, base, base_name):
    full = (base / path).resolve()
    raw = full.read_bytes()
    return {"root": base_name, "path": full.relative_to(base).as_posix(),
            "bytes": len(raw), "sha256": sha(raw)}

artifacts = []
for relative in audit["scope"]["in_scope"]:
    artifacts.append(bind(pathlib.Path(relative), worktree, "author_worktree"))
for relative in (
    "packages/storage/events/src/index.ts",
    "packages/contracts/src/events.ts",
    "migrations/001-event-store.ts",
):
    artifacts.append(bind(pathlib.Path(relative), worktree, "author_worktree"))
for item in command_index:
    path = pathlib.Path(item["original"]).resolve()
    raw = path.read_bytes()
    artifacts.append({"root": "baseline_repository", "path": path.relative_to(root).as_posix(),
                      "bytes": len(raw), "sha256": sha(raw)})

for relative in (
    "author-verification.json", "audit-evidence.py", "audit-results.json",
    "inputs-pre.json", "inputs-post.json", "build-review-final.py",
    "review-summary.md", "negative-fixtures/u08-counterexamples.mjs",
    "negative-fixtures/counterexample-results.json",
):
    artifacts.append(bind(pathlib.Path(relative), review, "review_directory"))
for file in sorted((review / "commands").glob("*.json"), key=lambda item: item.name):
    artifacts.append(bind(file.relative_to(review), review, "review_directory"))
fixture_dirs = list((review / "negative-fixtures").glob("fixtures-*"))
assert len(fixture_dirs) == 1
fixtures = fixture_dirs[0]
for file in sorted(fixtures.rglob("*"), key=lambda item: str(item).lower()):
    if file.is_file():
        artifacts.append(bind(file.relative_to(review), review, "review_directory"))

immutable_inputs = []
for relative in (
    "AGENTS.md",
    "planning/Xiadie_V2_v1.1/tasks/P02-U08.md",
    "docs/sources.lock.json",
    "migrations/001-event-store.ts",
    "packages/storage/events/src/index.ts",
    "evidence/P02-U05/20261003-01/acceptance.json",
    "evidence/P02-U07/20261003-01/acceptance.json",
):
    immutable_inputs.append(bind(pathlib.Path(relative), root, "baseline_repository"))

report = {
    "schema": "p02-independent-review/v1",
    "decision": "pass",
    "task": "P02-U08",
    "review_target": {
        "author_commit": author,
        "baseline_commit": baseline,
        "author_worktree": str(worktree),
    },
    "reviewer": "p02_u04_review",
    "scope": "U08 冻结精确提交的一致性备份/迁移独立复审。核对固定空 v0→v1 DDL、SQLite 在线 WAL 快照、完整内容验证、future/nonempty-v0 拒绝、BUSY/FULL/COMMIT/close 边界与新根恢复；不涵盖 U10 原生集成。",
    "checks": [
        {
            "id": "exact-target-prerequisite-and-manifest",
            "status": "pass",
            "detail": "独立 verify-author 对精确 author commit/baseline/worktree 执行校验：worktree clean，25 个 manifest 文件覆盖 26 条 changed paths，raw Git blob 与磁盘 0 mismatch，manifest SHA-256 6de478d11cedcee1883fddcb77371493896d6a2ec64822cff5007194aca2ca9e。U07 acceptance 为 accepted；卡片、source lock 与 baseline 记录一致。",
        },
        {
            "id": "scope-and-command-history",
            "status": "pass",
            "detail": "所有变更都在登记的 packages/storage/backup、tsconfig、tools/run-tests 与 U08 evidence 范围内；静态 migrations/001-event-store.ts 与 baseline 字节相同。13/13 command-index 项均与归档原件逐字节匹配并核对 SHA/exit；保留初始 build exit 2、两次测试 exit 1，最终 author build/unit 均 exit 0。",
        },
        {
            "id": "independent-input-bindings",
            "status": "pass",
            "detail": "固定 Node v24.14.0 / TypeScript 6.0.2。独立 build 前与 unit/反例之后各绑定 122 项，显式含 migrations/001-event-store.ts；pre/post 与作者 pre/post 的 bindings 完全一致，digest 均为 3fdfbd02b2343f10428900836e93ba2c6fc8dd7ea6c90e638e601e7e2e878648，无执行期间漂移。",
        },
        {
            "id": "independent-build-and-unit",
            "status": "pass",
            "detail": "固定 Node 执行 tsc --project tsconfig.json exit 0；实际 selector tools/run-tests.mjs unit P02-U08 exit 0，15 passed / 0 failed / 0 skipped。argv、cwd、输出和 exit 均保存在 review commands。",
        },
        {
            "id": "independent-close-and-corruption-counterexamples",
            "status": "pass",
            "detail": "两条独立 owned-fixture 反例均通过：仅对 BEGIN IMMEDIATE 捕获的维护 RW coordinator 注入真实 close 后 ACK throw，返回 UNRESOLVED_TRANSACTION/migrate，源 v1 与发布 v0 备份均 integrity ok；为含 1 个真实 capture 的 v1 backup 改写 material BLOB 而保留旧 snapshot SHA，restore 返回 CORRUPT_DATABASE/restore-source，目标目录未创建。",
        },
        {
            "id": "backup-migration-and-restore-logic",
            "status": "pass",
            "detail": "实现使用 SQLite online backup、锁内复查、migration 前发布并验证的 no-clobber 快照；固定 DDL 在单事务将空 v0 初始化至 v1；future schema/nonempty v0 在写操作前拒绝。源/快照/恢复库均验证 integrity/FK/精确 schema，分页核对 facts、observations、origins、receipts、captures 与材料摘要，并比较 SHA/count。lost COMMIT ACK 仅在完整状态读回后决定成功、保留 v0 失败或 UNRESOLVED；真实协调连接 close 失败不返回成功且保留失败 stage。",
        },
        {
            "id": "source-choice-and-evidence-boundaries",
            "status": "pass",
            "detail": "来源决定复用 Node 24.14 SQLite backup API 与已接受 U05 EventStore/静态 v1 schema；无复制上游代码、无新依赖。结论限于本地 unit 与 owned SQLite fixtures，不声称完整原生/桌面或生产环境验证。",
        },
    ],
    "limitations": [
        "NOT_RUN：U10 Native/Desktop composition、完整 P01 回归、生产数据库/数据、已安装 ZCode、外部付费模型、installer/portable package、完整原生依赖闭包。",
        "controlled SQLITE_FULL 使用 SQLite max_page_count，验证真实 SQLite 页数上限失败和事务回滚；它不代表实际磁盘耗尽。进程强杀覆盖 COMMIT 前/后状态，不代表断电、内核崩溃或文件系统故障。",
        "独立 close ACK 与 material 篡改均为 review-owned fixture；不触碰作者 tracked 源文件或用户数据。WAL/SHM 可能被 SQLite 读连接创建/使用，审查不声称所有旁路文件字节保持不变。",
        "SQLite API 当前带 ExperimentalWarning。维护 API 假定可信协调器先暂停 producer、drain/reconcile 并关闭旧 writer；不声称对抗恶意文件系统竞争或任意多进程写入。",
    ],
    "artifacts": artifacts,
    "immutable_inputs": immutable_inputs,
}
(review / "review-final.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"report": str(review / "review-final.json"), "artifacts": len(artifacts),
                  "immutable_inputs": len(immutable_inputs)}))
