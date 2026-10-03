import hashlib
import json
from pathlib import Path


ROOT = Path(r"E:\Xiadie\Xiadie")
AUTHOR = ROOT / ".runtime/P02/worktrees/u07"
REVIEW = ROOT / ".runtime/P02/reviews/u07-final"
EVIDENCE = AUTHOR / "evidence/P02-U07/20261003-01"
AUTHOR_COMMIT = "bbabe95348b166332a072130fe4b394995c018d7"
BASELINE_COMMIT = "6f445086853126227396029cf973c2fd33f90229"
MANIFEST_SHA = "ae3d8d163dad24199943a55e2dd0161c7b08d4dde0a773d85f92f0c8b445bcb9"
INPUTS_SHA = "b33f5b52393427fb1738720333686f64eeceae0177704b0f90dfec3d46fae781"


def read_json(path):
    return json.loads(path.read_bytes())


def binding(root_name, base, rel):
    path = base / rel
    raw = path.read_bytes()
    return {
        "root": root_name,
        "path": Path(rel).as_posix(),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


audit = read_json(REVIEW / "audit-results.json")
pre = read_json(REVIEW / "inputs-pre.json")
post = read_json(REVIEW / "inputs-post-final.json")
probes = read_json(REVIEW / "negative-fixtures/counterexample-results.json")
assert audit["author_commit"] == AUTHOR_COMMIT
assert audit["baseline_commit"] == BASELINE_COMMIT
assert audit["author_worktree_clean"] and audit["baseline_is_ancestor"]
assert audit["manifest"]["sha256"] == MANIFEST_SHA
assert audit["manifest"]["files"] == 19 and audit["manifest"]["changed_paths"] == 20
assert audit["manifest"]["verify_author_mismatches"] == 0 and not audit["scope_violations"]
assert audit["command_index"]["entries"] == 8
assert audit["command_index"]["evidence_and_original_archives_match"]
assert audit["independent_bindings"]["entries"] == 117
assert audit["independent_bindings"]["digest"] == INPUTS_SHA
assert audit["independent_bindings"]["author_reviewer_match"]
assert audit["independent_bindings"]["pre_post_unchanged"]
assert pre["digest"] == post["digest"] == INPUTS_SHA and post["unchanged"]
assert len(probes["probes"]) == 2
assert all(p["inspect"].get("needsReview") is True for p in probes["probes"])

checks = [
    {
        "id": "exact-target-prerequisite-and-manifest",
        "status": "pass",
        "detail": (
            f"冻结 author WT 精确位于 {AUTHOR_COMMIT}，baseline {BASELINE_COMMIT} 是祖先且 worktree clean。"
            f"独立 verify-author 核对 19 个 manifest 条目/20 条 changed path，raw Git blob 与磁盘 0 mismatch；"
            f"manifest SHA-256 {MANIFEST_SHA}。U07 卡片、source lock 与已接受 U02-U06 前置记录均按 baseline 核对。"
        ),
    },
    {
        "id": "scope-and-command-index",
        "status": "pass",
        "detail": (
            "20 条变更均在登记范围 packages/application/recovery、tools/run-tests.mjs 与 U07 evidence 内；"
            "8/8 command-index 记录的 bytes/SHA 与 evidence 副本及原始归档相同。作者最终 build/unit exit 0。"
            "早期 9/11 失败以 exit 1 保留，之后修正断言/夹具并完成 12/12；历史记录时间字段为 null，未伪造。"
        ),
    },
    {
        "id": "independent-input-bindings",
        "status": "pass",
        "detail": (
            "固定 Node v24.14.0 / TypeScript 6.0.2。独立 build 前与 suite、两条反例后的绑定共 117 项，"
            "显式包含 migrations/001-event-store.ts；逐项匹配作者 pre/post，digest 均为 "
            f"{INPUTS_SHA}，执行前后无漂移。"
        ),
    },
    {
        "id": "independent-build-and-u07-suite",
        "status": "pass",
        "detail": (
            "独立运行固定 Node 的 tsc --project tsconfig.json：exit 0；"
            "tools/run-tests.mjs unit P02-U07：exit 0，12 passed / 0 failed / 0 skipped。"
            "实际 argv、cwd、输出及 exit 均保存在 review commands；SQLite ExperimentalWarning 原样保留。"
        ),
    },
    {
        "id": "independent-fault-counterexamples",
        "status": "pass",
        "detail": (
            "独立反例 2/2，使用冻结 U07 实现和真实本地 U05 SQLite event store。"
            "同一 receipt identity 被不同 operation/owner 重用时 append 返回 conflict、first receipt 保留，"
            "inspect 为 conflict/HISTORY_CONFLICT/needsReview；实际 8,193 条 observations 超过 32×256 完整扫描界限时，"
            "inspect 返回 unavailable/READ_UNAVAILABLE/needsReview，未声称 absence。"
        ),
    },
    {
        "id": "critical-recovery-logic-review",
        "status": "pass",
        "detail": (
            "实现检查与实际 suite 覆盖 complete bounded observation scan、owner/descriptor conflict、"
            "只有新提交 intent 且 ACK 后才 dispatch、receipt canonical aggregation/first receipt、"
            "unknown effect 不自动重放，以及 first terminal ordering。并发 recovery 使用首次 committed attempt event 的"
            "occurredAt 作为稳定事实时间基准、discovery 写入 observedAt；不会推测 crash instant 或产生 timestamp identity conflict。"
        ),
    },
    {
        "id": "source-choice-and-evidence-boundaries",
        "status": "pass",
        "detail": (
            "复用已接受 U03 immutable event/first-terminal projection 与 U05 EventStore；sources.lock 中协议版本仅作固定参考，"
            "未复制上游代码或安装依赖。结论限于 U07 coordinator-internal recovery unit，不宣称原生集成或任意外部效果的幂等性。"
        ),
    },
]

author_artifact_paths = [
    "evidence/P02-U07/20261003-01/baseline.json",
    "evidence/P02-U07/20261003-01/manifest.json",
    "evidence/P02-U07/20261003-01/command-index.json",
    "evidence/P02-U07/20261003-01/result.md",
    "evidence/P02-U07/20261003-01/source-decision.md",
    "evidence/P02-U07/20261003-01/inputs-final-pre.json",
    "evidence/P02-U07/20261003-01/inputs-final-post.json",
    "packages/application/recovery/src/index.ts",
    "packages/application/recovery/test/recovery.test.mjs",
    "tools/run-tests.mjs",
]
review_artifact_paths = [
    "author-verification.json",
    "audit-results.json",
    "audit-u07.py",
    "build-review-final.py",
    "review-summary.md",
    "inputs-pre.json",
    "inputs-post-final.json",
    "negative-fixtures/u07-counterexamples.mjs",
    "negative-fixtures/counterexample-results.json",
    "negative-fixtures/receipt-identity-conflict.sqlite",
    "negative-fixtures/global-observation-limit.sqlite",
]
review_artifact_paths.extend(
    p.relative_to(REVIEW).as_posix() for p in sorted((REVIEW / "commands").glob("*.json"))
)
artifacts = [
    *(binding("author_worktree", AUTHOR, rel) for rel in author_artifact_paths),
    *(binding("review_directory", REVIEW, rel) for rel in review_artifact_paths),
]

immutable_paths = [
    "AGENTS.md",
    "planning/Xiadie_V2_v1.1/tasks/P02-U07.md",
    "docs/sources.lock.json",
    "evidence/P02-U06/20261003-01/acceptance.json",
    "evidence/P02-U05/20261003-01/acceptance.json",
    "evidence/P02-U03/20261003-01/acceptance.json",
    "evidence/P02-U02/20261003-01/acceptance.json",
    "docs/adr/P02-reuse.md",
    "spikes/P02/sqlite-notes.md",
    "packages/contracts/src/events.ts",
    "packages/storage/events/src/index.ts",
    "packages/adapters/zcode/src/transcript.ts",
    "packages/application/turn-projection.ts",
]
immutable_inputs = [binding("baseline_repository", ROOT, rel) for rel in immutable_paths]

report = {
    "schema": "p02-independent-review/v1",
    "decision": "pass",
    "task": "P02-U07",
    "review_target": {
        "author_commit": AUTHOR_COMMIT,
        "baseline_commit": BASELINE_COMMIT,
        "author_worktree": str(AUTHOR),
    },
    "reviewer": "p02_u04_review",
    "scope": (
        "U07 冻结精确提交的独立逻辑、构建和单元验收：检查操作 intent/receipt、"
        "完整分页读、恢复与 first-terminal projection 的安全边界。不是 U10、Native/Desktop 或完整产品集成验收。"
    ),
    "checks": checks,
    "limitations": [
        "NOT_RUN：U10 Native/Desktop composition、生产数据库/数据、真实外部发送或生成、付费模型、已安装 ZCode、installer/portable package、physical power-loss/storage-exhaustion、complete runtime dependency closure。",
        "SQLite 数据库、owned files 与 child process 都是 review/test 夹具；child kill 仅验证进程故障路径，不代表断电或真实生产效果。调用方仍须提供稳定 operation ID 与可信 reconciliation evidence。",
        "U05 没有 source/event identity observation query；U07 完整扫描上限为 32×256 rows，超过 8,192 observations 返回 unavailable/needsReview。读操作是同步 single-writer call-time view，不构成跨多进程全局快照保证。",
        "作者最初测试为 9/11，失败命令及输出继续归档，时间戳未采集并保留 null；修正后的 final run 为 12/12。协调器有一次 verify-author 将 branch 名误作 commit SHA 的失败调用，随后 exact-SHA 验证通过且 author WT clean。",
    ],
    "artifacts": artifacts,
    "immutable_inputs": immutable_inputs,
}

target = REVIEW / "review-final.json"
target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
raw = target.read_bytes()
print(json.dumps({"report": str(target), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "artifacts": len(artifacts), "immutable_inputs": len(immutable_inputs)}))
