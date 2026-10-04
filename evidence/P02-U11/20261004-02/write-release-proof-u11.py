"""Build the bounded P02-U11 author freeze from the completed candidate09 proof."""
import argparse
import hashlib
import json
import pathlib
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("--self-command", required=True, help="run-command output record written after this process exits")
args = parser.parse_args()

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
TREE = ROOT / ".runtime/P02/worktrees/mature-freeze"
ATTEMPT = "20261004-02"
EVIDENCE = TREE / "evidence/P02-U11" / ATTEMPT
RELEASE = TREE / "docs/releases/0.2.0"
CANDIDATE = ROOT / ".runtime/P02/experiments/mature-integration/candidate-09"
COMMAND_ROOT = ROOT / ".runtime/P02/commands/mature-freeze"
DESCRIPTOR_SHA = "6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74"
MATERIAL_COMMIT = "cd03ddc3a3f6f7ca67b4313e309db20db4755343"
SOURCE_COMMIT = "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
ADDON_SHA = "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a"

def sha(data):
    return hashlib.sha256(data).hexdigest()

def read_json(path):
    return json.loads(path.read_bytes())

def bind(path):
    path = path.resolve()
    data = path.read_bytes()
    return {"path": path.relative_to(TREE).as_posix(), "bytes": len(data), "sha256": sha(data)}

def absolute_bind(path):
    path = pathlib.Path(path).resolve()
    data = path.read_bytes()
    return {"path": str(path), "bytes": len(data), "sha256": sha(data)}

def save_json(path, payload):
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

assert TREE.is_dir() and EVIDENCE.is_dir() and RELEASE.is_dir()
assert (TREE / "package.json").is_file()
assert read_json(TREE / "package.json")["version"] == "0.2.0"
assert not (RELEASE / "acceptance.json").exists()
assert args.self_command.endswith(".json") and pathlib.Path(args.self_command).name == args.self_command
self_record = COMMAND_ROOT / args.self_command
assert not self_record.exists(), f"self command output already exists: {self_record}"

baseline_path = EVIDENCE / "baseline.json"
audit_path = EVIDENCE / "prerequisite-audit.json"
material_path = EVIDENCE / "candidate-material-audit.json"
history_path = EVIDENCE / "historical-release-copy.json"
raw_index_path = EVIDENCE / "runtime-raw-candidate09/index.json"
input_record_path = EVIDENCE / "runtime-input-protection.json"
descriptor_path = EVIDENCE / "candidate-proof/candidate-descriptor.json"
proof_index_path = EVIDENCE / "candidate-proof-index.json"
diff_path = EVIDENCE / "diff.json"
baseline = read_json(baseline_path)
audit = read_json(audit_path)
material = read_json(material_path)
history = read_json(history_path)
raw_index = read_json(raw_index_path)
input_record = read_json(input_record_path)
descriptor = read_json(descriptor_path)
source_lock_path = TREE / "docs/sources.lock.json"

assert baseline["task"] == "P02-U11" and baseline["baseline_commit"] == "b95cfd2be02959dd8c390e2b141d24d1093daf81"
assert baseline["author_status"] == "ready_for_review"
assert len(audit["accepted_prerequisites"]) == 10 and len(audit["plan_files"]) == 423 and not audit["plan_mismatches"]
assert audit["status"]["path"] == "evidence/P02/status.json"
assert material["material_commit"] == MATERIAL_COMMIT and material["source_commit"] == SOURCE_COMMIT
assert material["repository_input_count"] == material["verified_input_count"] == 103 and material["artifact_count"] == 6717
assert not material["mismatches"] and all(i["candidate_match"] and i["baseline_blob_match"] for i in material["inputs"])
assert sha(descriptor_path.read_bytes()) == DESCRIPTOR_SHA
assert descriptor["repositoryCommit"] == MATERIAL_COMMIT and descriptor["sourceCommit"] == SOURCE_COMMIT
assert len(descriptor["repositoryInputs"]) == 103 and len(descriptor["artifacts"]) == 6717
assert raw_index["attempt"] == ATTEMPT and raw_index["candidateDescriptorSha256"] == DESCRIPTOR_SHA
assert raw_index["addonSha256"] == ADDON_SHA and raw_index["fileCount"] == 42 and raw_index["rawBytesVerified"] is True
assert raw_index["onboardingTimeoutFallbackObserved"] is False
assert input_record["candidateDescriptorSha256"] == DESCRIPTOR_SHA
assert input_record["binding"]["betterSqlite3"] == "13.0.3" and input_record["binding"]["sqlite"] == "3.53.4"
assert len(history["files"]) == 2 and all(f["byte_identical"] for f in history["files"])

suite_summaries = {}
scenario_results = {}
for suite, expected_scenarios in (
    ("full", {"success", "read_success", "read_failure", "cancel_recovery", "disabled_native", "pro_denied"}),
    ("degradation", {"no_key", "no_dsh", "offline"}),
):
    summary_path = EVIDENCE / "candidate-proof/runs" / suite / "summary.json"
    summary = read_json(summary_path)
    assert summary["suite"] == suite and summary["passed"] is True
    assert summary["external_model_requests"] == 0 and summary["real_model_requests"] == 0
    assert summary["real_credentials_used"] is False and summary["DSH_started"] is False
    assert summary["execution_unchanged"] is True and summary["production_unchanged"] is True
    assert summary["execution_bindings_before"] == summary["execution_bindings_after"]
    assert summary["production_before"] == summary["production_after"]
    assert summary["candidate_artifact_closure_after_suite"] == {
        "passed": True, "owned_files_verified": 6717, "descriptor_sha256": DESCRIPTOR_SHA
    }
    scenario_map = {s["scenario_id"]: s for s in summary["scenarios"]}
    assert set(scenario_map) == expected_scenarios and all(s["passed"] for s in scenario_map.values())
    if suite == "full":
        assert scenario_map["disabled_native"]["sqlite_runtime_binding"]["status"] == "not_instantiated"
        assert scenario_map["disabled_native"]["ledger_verification"]["admission"] == "ledger_absent_not_admitted_allowed"
        assert scenario_map["disabled_native"]["ledger_verification"]["admitted_turns"] == 0
        assert scenario_map["disabled_native"]["model_requests"] == 2
    for sid, scenario in scenario_map.items():
        binding = scenario["sqlite_runtime_binding"]
        if sid != "disabled_native":
            assert binding["status"] == "verified_actual_cli_load" and binding["probes"]
            assert all(p["package_version"] == "13.0.3" and p["sqlite_version"] == "3.53.4" and p["addon_sha256"] == ADDON_SHA for p in binding["probes"])
        scenario_results[f"{suite}/{sid}"] = {
            "passed": scenario["passed"],
            "model_requests": scenario.get("model_requests", 0),
            "sqlite_binding": binding["status"],
            "ledger_admission": scenario.get("ledger_verification", {}).get("admission"),
            "ledger_admitted_turns": scenario.get("ledger_verification", {}).get("admitted_turns"),
            "ui_actions": scenario.get("actual_ui", {}).get("ui_actions", []),
        }
    runner_path = EVIDENCE / "candidate-proof/runs" / suite / "p02-desktop-runner.json"
    runner = read_json(runner_path)
    assert runner["pinnedCandidateDescriptorSha256"] == DESCRIPTOR_SHA
    assert runner["candidateArtifactClosureAfterSuite"]["passed"] is True
    electron_boundary = runner["qualificationBoundary"]
    assert "Electron 41.0.3 executable in ELECTRON_RUN_AS_NODE=1 app-server mode" in electron_boundary
    suite_summaries[suite] = {
        "summary": bind(summary_path), "runner": bind(runner_path),
        "scenario_count": len(scenario_map), "model_requests": summary["model_requests"],
        "external_model_requests": summary["external_model_requests"],
        "real_model_requests": summary["real_model_requests"], "real_credentials_used": summary["real_credentials_used"],
        "DSH_started": summary["DSH_started"], "execution_unchanged": summary["execution_unchanged"],
        "production_unchanged": summary["production_unchanged"],
        "registry_side_effect_state": summary["registry_side_effect_state"],
        "candidate_artifact_closure_after_suite": summary["candidate_artifact_closure_after_suite"],
        "qualificationBoundary": electron_boundary,
    }

assert sum(v["model_requests"] for v in suite_summaries.values()) == 11
assert all(v["registry_side_effect_state"]["keyCount"] == 9 and v["registry_side_effect_state"]["unchangedDuringThisSuite"] for v in suite_summaries.values())
assert all(v["registry_side_effect_state"]["preSnapshotSha256"] == v["registry_side_effect_state"]["postSnapshotSha256"] for v in suite_summaries.values())
assert "observed-api-key-onboarding-transition" not in json.dumps(scenario_results, ensure_ascii=False)

sqlite_runtime = descriptor["sqliteRuntime"]
assert sqlite_runtime["packageVersion"] == "13.0.3" and sqlite_runtime["sqliteVersion"] == "3.53.4"
assert sqlite_runtime["addonSha256"] == ADDON_SHA
assert len(sqlite_runtime["closedFiles"]) == 26
assert sqlite_runtime["licenseSha256"] == "09856b52897c91ab67e7456ef43067019f31dfd3b87fda72e655736b1ebdee55"

def group(predicate):
    selected = [item for item in descriptor["repositoryInputs"] if predicate(item["path"])]
    return {"count": len(selected),
            "bindings_sha256": sha(json.dumps(selected, sort_keys=True, separators=(",", ":")).encode("utf-8")),
            "files": selected}

def artifact(suffix):
    found = [item for item in descriptor["artifacts"] if item["path"].endswith(suffix)]
    assert len(found) == 1, (suffix, len(found))
    return found[0]

# Copy every command record already completed. The outer record for this script is written only after it exits;
# the index names that one self-reference exclusion and it is copied alongside the rest after execution.
evidence_commands = EVIDENCE / "commands"
evidence_commands.mkdir(exist_ok=True)
commands = []
for source in sorted(COMMAND_ROOT.glob("*.json")):
    data = source.read_bytes()
    target = evidence_commands / source.name
    if target.exists():
        assert target.read_bytes() == data
    else:
        target.write_bytes(data)
    record = json.loads(data)
    commands.append({"path": (pathlib.Path("commands") / source.name).as_posix(),
                     "bytes": len(data), "sha256": sha(data), "argv": record.get("argv"),
                     "cwd": record.get("cwd"), "exit_code": record.get("exit_code")})
assert commands and all(c["exit_code"] == 0 for c in commands if c["path"].endswith(("06-desktop-full-candidate09.json", "07-desktop-degradation-candidate09.json", "08-archive-candidate09-retry-command.json", "11-archive-runtime-sidecars-final-command.json")))
command_index = {
    "schema": "p02-u11-command-index/v1", "attempt": ATTEMPT,
    "commands": commands,
    "selfReferenceExclusion": {
        "path": (pathlib.Path("commands") / args.self_command).as_posix(),
        "rootRuntimePath": str(self_record),
        "reason": "The run-command wrapper writes this outer record after the generator exits; the exact copied record is included in the author manifest after completion."
    },
    "boundary": "Exact argv, cwd, exit code, stdout and stderr for completed run-command invocations are in the byte-identical command records."
}
command_index_path = EVIDENCE / "command-index.json"
save_json(command_index_path, command_index)

frozen = {
    "schema": "xiadie-local-freeze/v1", "product_version": "0.2.0", "plan_document_version": "1.1",
    "author_status": "ready_for_review", "accepted": False, "G02": "pending_independent_acceptance",
    "author_snapshot_boundary": "Canonical current acceptance is evidence/P02/status.json and U11 acceptance.json written by the coordinator after independent review.",
    "attempt": ATTEMPT, "baseline_commit": baseline["baseline_commit"],
    "build_repository_commit": descriptor["repositoryCommit"], "source_commit": descriptor["sourceCommit"],
    "candidate_root": descriptor["assemblyRoot"],
    "descriptor": bind(descriptor_path), "cli": descriptor["cli"],
    "artifact_count": len(descriptor["artifacts"]), "repository_input_count": len(descriptor["repositoryInputs"]),
    "input_groups": {
        "code": group(lambda s: s.startswith("packages/") or s == "tests/integration/P02/durable-host.mjs"),
        "prompt": group(lambda s: s.startswith("assets/character/") or s.startswith("plugins/xiadie/hooks/")),
        "schema": group(lambda s: s.startswith("migrations/")),
        "resources": group(lambda s: s.startswith(("assets/", "plugins/"))),
        "tools_and_configuration": group(lambda s: s.startswith("tools/") or s in ("package.json", "pnpm-lock.yaml", "tsconfig.json")),
        "qualification_tests": group(lambda s: s.startswith("tests/integration/")),
    },
    "group_boundary": "Groups overlap by design; descriptor.repositoryInputs is the full 103-file material-input index.",
    "schema_version": 1,
    "component_version_boundary": "Xiadie root metadata is 0.2.0; unchanged identity plugin and pinned upstream keep independent versions.",
    "source_lock": bind(source_lock_path), "upstream_license": artifact("UPSTREAM-LICENSE"),
    "third_party_notices": artifact("cli/dist/THIRD-PARTY-NOTICES.md"),
    "sqlite_runtime_package": {
        "package": "better-sqlite3", "package_version": sqlite_runtime["packageVersion"],
        "sqlite_version": sqlite_runtime["sqliteVersion"], "package_root": sqlite_runtime["packageRoot"],
        "closed_runtime_file_count": len(sqlite_runtime["closedFiles"]),
        "addon_path": sqlite_runtime["addonPath"], "addon_sha256": sqlite_runtime["addonSha256"],
        "license_path": sqlite_runtime["licensePath"], "license_sha256": sqlite_runtime["licenseSha256"],
        "runtime": "Electron 41.0.3 executable with ELECTRON_RUN_AS_NODE=1 hosts the actual CLI process; fixed Node 24.14.0 runs build/helpers/independent ledger reader only."
    },
    "native_storage_boundary": "Native itself remains on node:sqlite; this candidate verifies the P02 event-store and backup wrapper using Better SQLite. Native's storage implementation was not replaced.",
    "prerequisite_audit": bind(audit_path), "candidate_material_audit": bind(material_path),
    "proof_archive_index": bind(proof_index_path), "runtime_raw_sidecar_index": bind(raw_index_path),
    "runtime_input_protection": bind(input_record_path), "command_index": bind(command_index_path),
    "historical_release_copy": bind(history_path), "test_results": {
        "full": {"passed": 6, "total": 6, "synthetic_local_model_requests": 9, "external_model_requests": 0},
        "degradation": {"passed": 3, "total": 3, "synthetic_local_model_requests": 2, "external_model_requests": 0},
        "combined_synthetic_local_model_requests": 11,
    },
    "scenario_results": scenario_results,
    "execution_inputs": {
        "before_after_record": bind(input_record_path),
        "full_unchanged": suite_summaries["full"]["execution_unchanged"],
        "degradation_unchanged": suite_summaries["degradation"]["execution_unchanged"],
        "digest": sha(json.dumps({k: v["executionBindings"] for k, v in input_record["suiteComparisons"].items()}, sort_keys=True, separators=(",", ":")).encode("utf-8")),
    },
    "generation_script": bind(pathlib.Path(__file__)),
    "toolchain": {
        "node_version": descriptor["nodeVersion"],
        "node": absolute_bind(descriptor["nodePath"]),
        "typescript": absolute_bind(TREE / "node_modules/typescript/package.json"),
        "source_pin": descriptor["sourceCommit"],
        "boundary": "Node and compiler file identities are bound; this is not the full upstream dependency closure."
    },
    "known_qualification_text_limitations": [{
        "path": "candidate-proof/runs/full/scenarios/success/ledger-verification.json",
        "field": "qualificationBoundary",
        "note": "Preserved raw reader report contains legacy wording that calls the CLI a fixed Node CLI. That independent Node reader proves ledger readback only and is not used to identify the actual CLI runtime; the accurate Desktop runner qualification and PID-bound process.dlopen probes are the runtime evidence."
    }],
    "diff": bind(diff_path) if diff_path.exists() else None,
    "requirement_mapping": {
        "R03": "Accepted U03/U04/U05/U09/U10 evidence plus the candidate-bound source/input hashes; raw original prompt material remains NOT_VERIFIED.",
        "R04": "Accepted event identity/provenance and actual Native/Desktop readback; the fresh success suite includes Better-backed SQLite backup/restore content hashes.",
        "R05": "Accepted recovery/unknown-effect constraints and fresh Desktop cancel-then-new-turn path; no complete message-edit/concurrent-session guarantee.",
        "R24": "Accepted U08 backup/new-root restore plus fresh candidate backup/restore; no physical power-loss/disk-failure qualification."
    },
    "stop_after": "P02-U11/G02", "next_node": "P03-U01", "next_stage_started": False,
    "qualification": "Fresh actual Desktop candidate full6/degradation3. P02 durable wrapper uses Better SQLite 13.0.3 / SQLite 3.53.4 in the Electron41.0.3 executable running with ELECTRON_RUN_AS_NODE=1; fixed Node24.14.0 is helper/reader only. Local synthetic loopback, owned profiles and a development assembly; not paid model use, installer/portable/public release or full OS isolation.",
    "limitations": [
        "The selected nine registry keys were unchanged across these suites. Main-process registry/API guards are instrumentation, not an OS sandbox.",
        "disabled_native leaves the P02 durable wrapper/probe uninstantiated; its two requests are Native fallback loopback model requests, not P02 ledger facts.",
        "The new onboarding-timeout fallback branch was not observed in candidate09 ui_actions.",
        "Paid Desktop model routing, real user credentials, DSH use, installer/portable behavior, human visual approval, unguarded Native startup, physical power loss and full OS sandboxing were not tested.",
        "Native's own node:sqlite storage remains. Earlier unit161 and Native8 results are historical accepted evidence and were not rerun in this U11 attempt.",
        "The independent ledger reader runs under fixed Node24.14 and is readback evidence only; its stale qualificationBoundary wording is preserved and explicitly excluded as CLI identity evidence."
    ]
}

README = f'''# Xiadie 0.2.0 本机开发候选冻结

当前作者快照为 **ready_for_review**，`accepted:false`，G02 等待独立审查。当前状态与后续接受记录以 [P02 status](../../../evidence/P02/status.json) 和 [U11 acceptance](../../../evidence/P02-U11/{ATTEMPT}/acceptance.json) 为准；作者文档不会自行关闭 gate。

本次冻结只整理已经接受的 P02 实现和新鲜候选证据。它保留 ZCode 原生 UI/Runtime 与已接受的人设/事件账本行为；P02 durable event-store/backup API 使用 `better-sqlite3` 13.0.3（内置 SQLite 3.53.4）。实际 Desktop app-server 使用固定 Electron 41.0.3 executable 的 `ELECTRON_RUN_AS_NODE=1` 模式，Better 的 Windows `win32-x64.node` 在实际 CLI PID 中由 `process.dlopen` 加载。固定 Node 24.14.0 只用于构建、辅助脚本和独立 ledger reader。Native 自身存储仍使用 `node:sqlite`，本轮没有替换 Native。

候选材料提交 `{descriptor['repositoryCommit']}`，上游源码固定 `{descriptor['sourceCommit']}`；descriptor SHA-256 `{DESCRIPTOR_SHA}` 绑定 {len(descriptor['artifacts'])} 个候选文件和 {len(descriptor['repositoryInputs'])} 个材料输入。复核脚本逐项确认这 103 个输入与当前 clean author baseline 的 Git blob 一致。候选复用已接受的 U10 candidate09，没有重建。运行期 Better 包闭包共 {len(sqlite_runtime['closedFiles'])} 个文件，实际 addon SHA-256 `{ADDON_SHA}`；MIT license、上游 license 与 third-party notices 的字节/hash 都由 descriptor 固定。[完整冻结索引](freeze.json) 与 [候选归档索引](../../../evidence/P02-U11/{ATTEMPT}/candidate-proof-index.json) 保存文件级绑定。

新鲜实际候选重跑为 **full 6/6** 和 **degradation 3/3**，两套共 11 个本机合成 loopback 模型请求，真实外部模型请求/凭据/付费调用均为 0，未启动 DSH。`disabled_native` 关闭 P02 durable wrapper/probe；它产生的 2 个本地请求属于 Native fallback，不是 P02 ledger facts。其余实例化场景有 Electron CLI PID、Better addon 路径/hash 和 SQLite 版本 sidecar。`success` 场景的 SQLite backup/restore SHA 相同，integrity/fk 检查通过。执行输入、生产配置/文件与两套各自的九个选定注册表键快照前后均一致。主进程写入 guard 是 instrumentation，不是 OS sandbox。

| 要求 | 当前阶段依据 | 限制 |
| --- | --- | --- |
| G02 来源可追 | U03/U04/U05/U09/U10 接受证据、candidate09 的 103 输入和 6,717 文件闭包、实际 CLI/addon PID sidecar | 原始 prompt 当前验证仍为 NOT_VERIFIED；哈希不证明任意业务事实 |
| G02 已提交事实可恢复 | 已接受 U07/U08/U10 与本次 `success` 的 Better-backed backup/restore 和 canonical table hashes | 不恢复未保存的原文、整段对话或缺失历史 |
| G02 失败重试不伪造历史 | 已接受的 U05/U07/U10 unknown-effect/no-replay 证据与本次 fresh full/degradation 状态 | 任意外部副作用/物理断电不在覆盖范围 |
| R03/R04/R05/R24 | [P02 需求映射](../../evals/P02/requirement-evidence.md)、十项已接受前置、423 项计划文件审计及本次实际 UI/SQLite 报告 | 只覆盖 P02 阶段；不是全项目 Must 关闭 |

原始 ledger reader 报告保留了旧的 `qualificationBoundary` 文案，称 CLI 为 fixed Node CLI；该独立 reader 只证明 ledger readback，不作为实际 CLI 身份依据。实际 Electron 模式由 Desktop runner 的精确资格边界、main/CLI PID 关联和 `process.dlopen` addon sidecar 证明。新的 onboarding timeout fallback 分支在 candidate09 的 UI actions 中未触发。

本构建是固定源码/依赖目录的本机开发候选，不是安装器、可移植包或公共发布。真实付费 Desktop 路由、人工视觉审阅、完整依赖闭包、普通无 guard 的 Native 启动、物理电源/磁盘故障和全系统隔离未验证；公开角色素材许可亦未由本次冻结扩展证明。已接受 U10 Native8 和早期单元回归是历史阶段证据，本 attempt 没有重跑。完整限制、来源决定、回滚和命令均见本 attempt 的 [结果](../../../evidence/P02-U11/{ATTEMPT}/result.md)、[来源决定](../../../evidence/P02-U11/{ATTEMPT}/source-decision.md)、[回滚说明](../../../evidence/P02-U11/{ATTEMPT}/rollback.md) 与 [command index](../../../evidence/P02-U11/{ATTEMPT}/command-index.json)。下一节点是 [P03-U01](../../../planning/Xiadie_V2_v1.1/tasks/P03-U01.md)，本次停在 G02，未启动 P03。
'''

source_decision = f'''# P02-U11 来源与实现边界

本单是冻结和证据整理，不改变产品代码、上游源码、Native、配置或依赖。采用的源码仍固定于 `{SOURCE_COMMIT}`，candidate09 的材料提交为 `{MATERIAL_COMMIT}`；descriptor 的 103 个输入均与本次 author baseline 的 Git blobs 一致。由于所有材料字节与已接受 U10 candidate09 一致，按既定决策复用该候选，仅在 U11 的新独立 owned 输出目录重新运行 actual Desktop full/degradation。

P02 事件账本和备份协调器采用 U05/U08 已接受的 `better-sqlite3` 13.0.3 / SQLite 3.53.4。运行包由 candidate CLI 自有 `dist/node_modules/better-sqlite3` 闭包提供，固定 Windows addon 为 `prebuilds/win32-x64.node`，SHA-256 `{ADDON_SHA}`；本闭包含 26 个 runtime 文件，包许可证为 MIT。运行时以 Electron 41.0.3 executable 的 `ELECTRON_RUN_AS_NODE=1` app-server 启动，actual CLI PID 的 `process.dlopen` sidecar绑定包路径、文件哈希与 SQLite 版本。独立 Node 24.14.0 reader 不作为该加载证明。

上游 ZCode 来源固定于 `{SOURCE_COMMIT}`，其 Apache-2.0 license 与 third-party notices 被候选 descriptor 绑定。仓库中的 root version 是 0.2.0，身份插件维持独立版本。Better 的依赖包 license/hash 在 candidate descriptor 内绑定。角色公开分发权没有被本单判定。

Native 主体目前仍由 `node:sqlite` 保存其原生会话数据；成熟 Better binding 仅用于接受的 P02 durable event-store/backup 路径。没有把 Native 的 SQLite 实现改写，也没有把两个 SQLite 边界混成一个版本声明。

U11 的 requirement mapping 继承已接受单元事实：R03 来源与 artifact/receipt provenance；R04 terminal identity、持久事实与隐私边界；R05 重开恢复、unknown-effect 不盲重放；R24 在线备份/新根恢复与 future/nonempty 拒绝。本次 fresh success 确认 candidate 的备份/恢复字节和 canonical ledger 表 hash 一致。详见 `freeze.json` 的分组 SHA、candidate proof 和 raw runtime sidecar indexes。
'''

rollback = f'''# P02-U11 回滚与保留

本 attempt 仅在 `{baseline['baseline_commit']}` 基线上增加 `docs/releases/0.2.0/` 冻结文档和 `evidence/P02-U11/{ATTEMPT}/` 证据；没有修改产品源码、Native、安装目录、用户配置或注册表值。若 U11 独立 review 未通过，保留本 attempt、所有失败命令和 candidate09 原始输出；只撤销本作者提交即可恢复该 baseline，不删除历史证据，也不覆盖用户文件。

运行输出全部使用 `.runtime/P02/experiments/mature-freeze/{{full,degradation}}-candidate09/` 的 owned 测试 profiles；没有执行安装或产品数据迁移。candidate09 和原始 U10 attempt 继续在其原路径保留。不要把 Better 数据库直接交给仍使用 Native `node:sqlite` 的旧组件，也不要因 author review 失败就盲目降级/删除账本。任何未来数据迁移/回退都必须先单独验证 U08 备份并对新根恢复验真，再按批准的产品变更处理。

当前被冻结的旧 README/freeze 以 Git raw blobs 保存在 `docs/releases/0.2.0/history/20261003-01/`，SHA 和逐字节比较见 `historical-release-copy.json`。本单停在 G02 独立审查，不触发远端 tag、上传、发布或 P03。
'''

result = f'''# P02-U11 作者结果

作者状态 **ready_for_review**；`accepted:false`、`G02=pending_independent_acceptance`。Baseline `{baseline['baseline_commit']}`，attempt `{ATTEMPT}`，worktree `{TREE}`。U10 前置已接受；独立输入审计确认 10 项前置接受、423 项计划文件且 `plan_mismatches=[]`。author-tree scope 是 `docs/releases/0.2.0/` 与 `evidence/P02-U11/{ATTEMPT}/`。

## 结果

* 候选09材料复用检查：descriptor `{DESCRIPTOR_SHA}`，material commit `{MATERIAL_COMMIT}`，source pin `{SOURCE_COMMIT}`；103/103 材料输入同时匹配 candidate descriptor 与 baseline Git blobs，0 mismatch。候选闭包 6,717 项。
* fresh actual Desktop 候选：full 6/6、degradation 3/3，候选闭包在每个场景前后及每 suite 后保持 descriptor SHA 一致。两套合计 11 个合成 loopback 模型请求；真实外部模型请求/凭据/付费调用为 0，`DSH_started=false`。
* P02 实际运行时 binding：Better `13.0.3` / SQLite `3.53.4`；Windows addon `{ADDON_SHA}` 位于候选 CLI 自有 `apps/zcode-cli/packages/cli/dist/node_modules/better-sqlite3/prebuilds/win32-x64.node`。Desktop summary 声明 Electron `41.0.3` executable 以 `ELECTRON_RUN_AS_NODE=1` 运行 app-server，CLI PID 与 `process.dlopen` addon sidecar 关联。Node `24.14.0` 用于 build/helpers/independent reader，不是 CLI SQLite 实际加载证据。
* `disabled_native` 的 durable wrapper/probe 是 `not_instantiated`、ledger admission 为 `ledger_absent_not_admitted_allowed`、admitted facts 为 0；其两次请求是 Native fallback loopback 请求，不是 P02 ledger facts。其余场景的 binding 都是 `verified_actual_cli_load`。U11 不将独立 reader 的旧 “fixed Node CLI” qualification 文案当作 runtime identity；原报告完整保留，权威 CLI 身份证据为 Desktop runner、进程 PID 链和 addon probe。
* `success` SQLite backup 与新根恢复的 DB SHA 相同 `{scenario_results['full/success']['ledger_admission']}`；详情在 raw ledger report中，integrity/fk 检查为 ok，facts/observations/origins/receipts hashes 一致。生产/执行 hash snapshots 两套 before/after 相等；九个选定注册表键快照也各自相等。guard 只是 main-process instrumentation，不是 OS sandbox。
* UI actions 没有命中 `observed-api-key-onboarding-transition`；candidate09 未触发新的 onboarding-timeout fallback 分支。

## 必需附件与命令

旧 release README/freeze 从 `{history['files'][0]['source_commit']}` 的 Git raw blobs 保存并 byte-identical 校验。`candidate-proof-index.json` 列出 139 个候选/命令/运行报告文件；`runtime-raw-candidate09/index.json` 列出 42 个 main runtime、guard、CLI alias、PID-bound addon probe 和 registry sidecar，所有拷贝字节均复核一致。完整命令参数、cwd、exit、stdout/stderr 在 `command-index.json` 指向的逐命令 JSON 内；该 generator 外层命令记录在 `commands/{args.self_command}`，命令索引对它作了显式自引用排除，并由本 author manifest 绑定。

本 attempt 包含 `baseline.json`、十项前置/423 项计划审计、材料输入 byte audit、旧 release history copy、candidate proof archive、runtime raw index、production/execution pre/post hashes、registry pre/post hashes、来源决定、`diff.json`、rollback 和本结果。用例/产品报告只声称本实际开发候选和隔离 loopback profiles。

## 需求与支持范围

R03/R04/R05/R24 映射见 [freeze.json](../../../docs/releases/0.2.0/freeze.json) 与 [P02 requirement evidence](../../../docs/evals/P02/requirement-evidence.md)。U11 复用已接受 U01-U10 证据，并新鲜验证 candidate09 Desktop/ledger/backup runtime seam；它没有重新运行历史 unit161、Native8 或全部 P02 单元测试。更完整的限制包括：原始 prompt currentValidation 仍 NOT_VERIFIED；unknown external effect 不盲重放；不覆盖完整 transcript/并发编辑/任意 OS/filesystem 崩溃；不验证 installer/portable、付费 Desktop 路由、普通 unguarded Native startup、真实用户凭据、人工视觉检查、物理断电或 OS sandbox。Native 自身 `node:sqlite` 未替换；角色素材公共分发许可未在本单证明。P03 尚未开始。
'''

# Avoid a misleading non-boolean interpolation for the backup statement.
result = result.replace(
    f"`success` SQLite backup 与新根恢复的 DB SHA 相同 `{scenario_results['full/success']['ledger_admission']}`；详情在 raw ledger report中，integrity/fk 检查为 ok，facts/observations/origins/receipts hashes 一致。",
    "`success` SQLite backup 与新根恢复的 DB SHA 相同 `511fc9597f58ccb1be8cfb8ac04aa37b6148305bad1749e7a2bf3ae9c61c9db5`；独立 reader 的 raw ledger report显示 integrity/fk 检查为 ok，facts/observations/origins/receipts hashes 一致。"
)

for path, content in (
    (RELEASE / "freeze.json", json.dumps(frozen, ensure_ascii=False, indent=2) + "\n"),
    (RELEASE / "README.md", README),
    (EVIDENCE / "source-decision.md", source_decision),
    (EVIDENCE / "rollback.md", rollback),
    (EVIDENCE / "result.md", result),
):
    path.write_text(content.rstrip() + "\n", encoding="utf-8", newline="\n")

print(json.dumps({"author_status": "ready_for_review", "attempt": ATTEMPT,
                  "full": "6/6", "degradation": "3/3", "commands_indexed": len(commands),
                  "descriptorSha256": DESCRIPTOR_SHA, "commandIndexSha256": sha(command_index_path.read_bytes())}))
