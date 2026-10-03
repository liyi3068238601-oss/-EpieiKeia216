import hashlib
import json
import pathlib

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
WT = ROOT / ".runtime/P02/worktrees/u06"
REVIEW = ROOT / ".runtime/P02/reviews/u06-final"


def binding(label, base, relative):
    base = base.resolve()
    path = (base / relative).resolve()
    assert path.is_relative_to(base), str(path)
    raw = path.read_bytes()
    return {"root": label, "path": path.relative_to(base).as_posix(), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


author_artifacts = [
    "evidence/P02-U06/20261003-01/baseline.json",
    "evidence/P02-U06/20261003-01/manifest.json",
    "evidence/P02-U06/20261003-01/command-index.json",
    "evidence/P02-U06/20261003-01/result.md",
    "evidence/P02-U06/20261003-01/source-decision.md",
    "evidence/P02-U06/20261003-01/inputs-final-pre.json",
    "evidence/P02-U06/20261003-01/inputs-final-post.json",
    "packages/application/evidence/src/index.ts",
    "packages/application/evidence/test/evidence.test.mjs",
    "tools/run-tests.mjs",
]
review_artifacts = [
    "author-verification.json",
    "audit-results.json",
    "audit-u06.py",
    "build-review-final.py",
    "review-summary.md",
    "inputs-pre.json",
    "inputs-post-final.json",
    "inputs-bind-recheck-pre.json",
    "inputs-bind-recheck-post.json",
    "negative-fixtures/independent-probes.mjs",
    "negative-fixtures/probe-results.json",
]
review_artifacts += [f"commands/{p.name}" for p in sorted((REVIEW / "commands").glob("*.json"))]

immutable = [
    (ROOT, "AGENTS.md"),
    (ROOT, "planning/Xiadie_V2_v1.1/tasks/P02-U06.md"),
    (ROOT, "docs/sources.lock.json"),
    (ROOT, "evidence/P02-U05/20261003-01/acceptance.json"),
    (ROOT, "evidence/P02-U03/20261003-01/acceptance.json"),
    (ROOT, "evidence/P02-U02/20261003-01/acceptance.json"),
    (ROOT, "docs/adr/P02-reuse.md"),
    (ROOT, "spikes/P02/sqlite-notes.md"),
    (ROOT, "packages/contracts/src/events.ts"),
    (ROOT, "packages/storage/events/src/index.ts"),
    (ROOT, "packages/adapters/zcode/src/transcript.ts"),
    (ROOT, "packages/application/turn-projection.ts"),
]

report = {
    "schema": "p02-independent-review/v1",
    "decision": "pass",
    "task": "P02-U06",
    "review_target": {
        "author_commit": "f716a444d1889ba33991ca05c36611d7bef2a096",
        "baseline_commit": "a1b611dadafdcf2337d80d62b9d68da485a0a3a2",
        "author_worktree": str(WT),
    },
    "reviewer": "p02_u04_review",
    "scope": "U06 冻结精确提交的独立单元审查：验证 EvidenceReport 的进程/收据/来源/artifact 接受逻辑及其 U05 EventStore 读口。不构成 U10、原生 Desktop 或整个产品集成验收。",
    "checks": [
        {
            "id": "exact-target-prerequisite-and-manifest",
            "status": "pass",
            "detail": "author WT 精确位于 f716a444d1889ba33991ca05c36611d7bef2a096，baseline a1b611dadafdcf2337d80d62b9d68da485a0a3a2 是祖先且 WT clean。独立 verify-author 核实 30 个 manifest 条目/31 条 changed path，raw Git blob 与磁盘逐项一致、0 mismatch；manifest SHA-256 8a240cf787f10b711197ff78df2752edbecea8c9cc68d90664e212e8cb00ff05。冻结卡/source lock 与 U05 accepted prerequisite、U02/U03 accepted 输入均核对。",
        },
        {
            "id": "scope-and-command-index",
            "status": "pass",
            "detail": "31 条变更全部位于 packages/application/evidence、tools/run-tests.mjs、evidence/P02-U06/20261003-01 登记范围内。18/18 command-index entries 的 bytes/SHA 与 author evidence 副本及 .runtime/P02/runs/u06 原始归档相同。作者最终 build/unit 均 exit 0；历史 build 01、unit 08、diff helper 16 的失败及修正记录均保留，16 是错误工作目录的记账命令失败，不是产品测试失败。",
        },
        {
            "id": "independent-input-bindings",
            "status": "pass",
            "detail": "固定 Node v24.14.0 / TypeScript 6.0.2。独立 build 前与 U06 suite/反例后绑定各 112 项（显式含 migrations/001-event-store.ts），与作者 inputs-final-pre/post 的逐项 bindings 完全相同；digest 均为 88bc92d32c60fcf95339e76ce54d59faeed39e2ed43121f9b9144018e1592be4，前后无漂移。另有 run-command 留存的 bind recheck 前后均相同。",
        },
        {
            "id": "independent-build-and-u06-suite",
            "status": "pass",
            "detail": "固定 Node 24 独立运行 tsc --project tsconfig.json：exit 0；tools/run-tests.mjs unit P02-U06：exit 0，8 passed / 0 failed。真实 argv、cwd、stdout/stderr 与 exit 记录在 review commands。Node node:sqlite ExperimentalWarning 按原样保留。",
        },
        {
            "id": "independent-fault-counterexamples",
            "status": "pass",
            "detail": "独立反例 2/2：同一 (source,eventId) 的 conflicting redelivery 返回 conflict，reader 保留 first receipt，但 builder 将 toolReceipt 标为 invalid/profile failed；8193 条真实 EventStore observation 超过 32 页×256 行上限，分页读抛出 page-limit error，builder 捕获后拒绝 profile pass。两条均使用冻结版本 builder、真实 U05 SQLite EventStore，并由冻结仓库内真实 tracked Node script 的 U06 launcher 产生 owned run。首轮 probe 的 queue_full、复用旧 DB 与未捕获预期 page-limit throw 等 reviewer harness 失败均留档；修正后最终 2/2 通过。",
        },
        {
            "id": "source-choice-and-evidence-boundaries",
            "status": "pass",
            "detail": "U05 accepted 且 U02/U03 接受记录可核对；D02/H14 仅为 sources.lock 固定版本参考，未复制第三方代码或安装依赖。实现审查确认 report 只接纳与精确 scope/attempt/toolCall/source 匹配的 committed operation_receipt，writer receipt first sequence/canonical hash 回查，conflict/read-limit fail closed；process execution 与机械 profileResult 分开，raw log/回复文本不进入报告，artifact 读取受 8 MiB 与路径/链接边界约束。",
        },
    ],
    "limitations": [
        "NOT_RUN：U10 Host/native Desktop composition、已安装 ZCode/Electron、production databases、native effects、real models/network、Windows package behavior、physical disk exhaustion/power loss、complete runtime dependency closure。",
        "本审查的 SQLite 数据库、artifact 与 child Node process 均为 review 夹具；不代表产品 DB、原生 Hook 集成或完整运行时/依赖隔离。作者 rollback 仅回退冻结 U06 commit；U06 未触碰持久产品数据库或外部副作用。",
        "审查工具调用的首个 verify-author 参数顺序错误已被后续 exact invocation 修正；相关失败命令记录保留且不影响最终验证。",
    ],
    "artifacts": [binding("author_worktree", WT, p) for p in author_artifacts]
        + [binding("review_directory", REVIEW, p) for p in review_artifacts],
    "immutable_inputs": [binding("baseline_repository", base, rel) for base, rel in immutable],
}

out = REVIEW / "review-final.json"
out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
raw = out.read_bytes()
print(json.dumps({"path": str(out), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "artifacts": len(report["artifacts"]), "immutable_inputs": len(report["immutable_inputs"])}))
