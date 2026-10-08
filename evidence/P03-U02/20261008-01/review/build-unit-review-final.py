import datetime
import hashlib
import json
import pathlib
import subprocess
import time

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
REVIEW = ROOT / ".runtime/P03/reviews/u02-20261008"
AUTHOR = ROOT / ".runtime/P03/worktrees/u02"
PROBE = ROOT / ".runtime/P03/worktrees/u02-source-probe"
AUTHOR_COMMIT = "e9314207347d33dd61cab941a8dca549c9575ca8"
BASELINE = "c691a5b7a975ac4420f880c8233c7b0bb7893958"
NATIVE_PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
MANIFEST_SHA = "21dbe5f392b01c6ea1ad6100b5e32a118393425c397e338e34e08138b9f23ec5"
REPORT_PATH = REVIEW / "unit-review-final.json"
READBACK_PATH = REVIEW / "unit-review-readback.json"
COMMAND_PATH = REVIEW / "unit-review-readback-command.json"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def binding(path, root_name, base):
    path = path.resolve()
    raw = path.read_bytes()
    return {
        "path": path.relative_to(base.resolve()).as_posix(),
        "root": root_name,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def sha(path):
    raw = pathlib.Path(path).read_bytes()
    return len(raw), hashlib.sha256(raw).hexdigest()


def git(repo, *args):
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


started = time.monotonic()
assert git(ROOT, "rev-parse", "HEAD") == BASELINE
assert git(ROOT, "status", "--porcelain=v1") == ""
assert git(AUTHOR, "rev-parse", "HEAD") == AUTHOR_COMMIT
assert git(AUTHOR, "status", "--porcelain=v1") == ""
subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, AUTHOR_COMMIT], cwd=ROOT, check=True)
changed = git(ROOT, "diff", "--name-only", f"{BASELINE}...{AUTHOR_COMMIT}").splitlines()
allowed = lambda p: (
    p.startswith("spikes/P03/")
    or p == "docs/adr/P03-reuse.md"
    or p.startswith("evidence/P03-U02/20261008-01/")
)
assert len(changed) == 58, len(changed)
assert all(allowed(p) for p in changed), [p for p in changed if not allowed(p)]

manifest_path = AUTHOR / "evidence/P03-U02/20261008-01/manifest.json"
assert sha(manifest_path)[1] == MANIFEST_SHA
author_readback = read_json(REVIEW / "unit-author-manifest-readback.json")
assert author_readback["author_commit"] == AUTHOR_COMMIT
assert author_readback["baseline_commit"] == BASELINE
assert author_readback["worktree_clean"] is True
assert author_readback["files"] == 57 and author_readback["changed_paths"] == 58
assert author_readback["disk_and_git_mismatches"] == []

author_result_path = AUTHOR / "evidence/P03-U02/20261008-01/result.md"
author_result = author_result_path.read_text(encoding="utf-8")
assert "ready_for_review" in author_result and "not independently accepted" in author_result
adr_path = AUTHOR / "docs/adr/P03-reuse.md"
adr_text = adr_path.read_text(encoding="utf-8")
assert "selected.md" in adr_text and "2 KiB" in adr_text
assert "not production constants" in adr_text
assert "per-Host state" in adr_text
assert "present`, `absent`, `unreadable` and `corrupt" in adr_text
assert "Keep these authority decisions distinct from U04's four read states" in adr_text

runtime_path = AUTHOR / "evidence/P03-U02/20261008-01/native-runtime/run-08-runtime-result.json"
runtime = read_json(runtime_path)
assert runtime["unit"] == "P03-U02" and runtime["baseline"] == BASELINE
assert runtime["sourcePin"]["commit"] == NATIVE_PIN and runtime["sourcePin"]["clean"] is True
assert len(runtime["requests"]) == 20
assert len(runtime["hookRuns"]) == 10
assert all(row["status"] == "completed" and row["exitCode"] == 0 for row in runtime["hookRuns"])
assert all(row["nonce"] == row["packetNonce"] for row in runtime["hookRuns"])
assert min(row["packetBytes"] for row in runtime["hookRuns"]) >= 5478
assert max(row["packetBytes"] for row in runtime["hookRuns"]) <= 5574
assert max(row["packetBytes"] for row in runtime["hookRuns"]) < 12000
assert runtime["realModel"] == "NOT_RUN"
assert runtime["installedZCodeApplication"] == "NOT_RUN"
assert runtime["realCredentials"] == "NOT_READ"
assert "NOT_RUN" in runtime["nativeProjectABRequestIsolation"]
assert runtime["writeProbe"]["filesystemWriteSandbox"].startswith("NOT_RUN")

review_command = read_json(REVIEW / "native-final-rerun-02-command.json")
review_result_path = REVIEW / "native-final-output-02/run-review-02-runtime-result.json"
review_result = read_json(review_result_path)
assert review_command["exit_code"] == 0
assert review_command["cwd"] == str(AUTHOR)
assert review_command["reviewTarget"]["authorCommit"] == AUTHOR_COMMIT
assert review_command["reviewTarget"]["authorTreeClean"] is True
assert review_command["reviewTarget"]["nativeSourceCommit"] == NATIVE_PIN
assert review_command["argv"][1] == "run-review-02"
assert pathlib.Path(review_command["argv"][2]).resolve() == (REVIEW / "native-final-output-02").resolve()
assert review_command["script"]["sha256"] == sha(AUTHOR / "spikes/P03/native-memory-runtime.mjs")[1]
assert review_command["runtimeResult"]["sha256"] == sha(review_result_path)[1]
assert review_result["sourcePin"]["commit"] == NATIVE_PIN
assert review_result["baseline"] == BASELINE and review_result["attemptId"] == "20261008-01"
assert review_result["nativeRuntime"].startswith("executed pinned ZCode source")
assert len(review_result["requests"]) == 20 and len(review_result["hookRuns"]) == 10
assert all(row["status"] == "completed" and row["nonce"] == row["packetNonce"] for row in review_result["hookRuns"])
assert min(row["packetBytes"] for row in review_result["hookRuns"]) >= 5478
assert max(row["packetBytes"] for row in review_result["hookRuns"]) <= 5574
assert len(review_result["nativeMemory"]["hostProviderSamples"]) == 12
assert review_result["nativeMemory"]["nativeBuiltinEnabled"] is False
assert any(row.get("code") == "P03_MEMORY_INVALID_UTF8" for row in review_result["nativeMemory"]["hostProviderSamples"])
assert any(row.get("code") == "P03_MEMORY_SOURCE_CHANGED" for row in review_result["filesystem"]["readFailures"])
assert review_result["acl"]["status"] == "pass"
assert all(command["exitCode"] == 0 for command in review_result["acl"]["commands"])
assert review_result["acl"]["selectedFileSha256Before"] == review_result["acl"]["selectedFileSha256AfterRestore"]
assert review_result["writeProbe"]["status"] == "native-unregistered-tool-rejected"
assert review_result["writeProbe"]["nativeToolError"]["errorCode"] == "TOOL_NOT_FOUND"
assert review_result["writeProbe"]["requestToolNames"] == ["Read"]
assert review_result["writeProbe"]["sourceSha256Before"] == review_result["writeProbe"]["sourceSha256After"]
assert review_result["writeProbe"]["memorySha256Before"] == review_result["writeProbe"]["memorySha256After"]
assert review_result["writeProbe"]["filesystemWriteSandbox"].startswith("NOT_RUN")

first_attempt = read_json(REVIEW / "native-final-rerun-failed-command.json")
assert first_attempt["exit_code"] == 1 and first_attempt["nativeAssertionsStarted"] is False
assert "Wrong cwd" in first_attempt["failureCause"]
assert first_attempt["cwd"] != str(AUTHOR)

topology_review = read_json(REVIEW / "review-final.json")
assert topology_review["task"] == "P03-U02-topology-service-subexperiment"
assert topology_review["decision"] == "pass" and topology_review["unit_acceptance"] == "not_decided"
topology_result = read_json(AUTHOR / "evidence/P03-U02/20261008-01/topology-service/run-02/service-results.json")
assert topology_result["status"] == "pass" and len(topology_result["cases"]) == 14
assert all(case["status"] == "pass" for case in topology_result["cases"])

parser_review = read_json(REVIEW / "parser-review-20261008-01.json")
parser_result = read_json(AUTHOR / "evidence/P03-U02/20261008-01/topology-service/parser-result.json")
assert parser_review["status"] == "pass" and len(parser_review["checks"]) == 8
assert all(check["status"] == "pass" for check in parser_review["checks"])
assert parser_review["xiadieDependencyAvailability"]["marked"]["available"] is False
assert parser_review["xiadieDependencyAvailability"]["yaml"]["available"] is False
assert parser_result["status"] == "pass" and len(parser_result["checks"]) == 8

dist_readback = read_json(REVIEW / "native-dist-readback-result.json")
binding_readback = read_json(REVIEW / "native-dist-sourcebinding-readback-result.json")
assert dist_readback["status"] == "pass" and dist_readback["mismatches"] == []
assert dist_readback["sourceCommit"] == NATIVE_PIN and dist_readback["sourceTreeClean"] is True
assert dist_readback["inputCount"] == 1181 and dist_readback["comparedJavaScriptOutputCount"] == 1163
assert binding_readback["status"] == "pass" and binding_readback["mismatches"] == []
assert binding_readback["probeCommit"] == "fd87e1050a5202218f8c5b2411e1d01c0bbc1a07"
assert binding_readback["probeTreeClean"] is True
assert binding_readback["inputCount"] == 1181
assert binding_readback["trackedSourceInputsMatchedToCommitBlobs"] == 1180
assert binding_readback["generatedInputsRegeneratedAndChecked"] == 1
assert binding_readback["TypeScriptStandardLibrariesChecked"] == 57
assert binding_readback["compiledJavaScriptOutputsMatched"] == 1163
assert binding_readback["loadedRuntimeEntrypointsMatched"] == 6

readback = {
    "schema": "p03-u02-unit-review-readback/v1",
    "status": "pass",
    "authorCommit": AUTHOR_COMMIT,
    "baselineCommit": BASELINE,
    "mainBaselineHead": git(ROOT, "rev-parse", "HEAD"),
    "mainBaselineClean": git(ROOT, "status", "--porcelain=v1") == "",
    "authorHead": git(AUTHOR, "rev-parse", "HEAD"),
    "authorTreeClean": git(AUTHOR, "status", "--porcelain=v1") == "",
    "baselineAncestor": True,
    "changedPaths": len(changed),
    "scopeAllowed": True,
    "manifest": {"sha256": sha(manifest_path)[1], "boundFiles": 57, "changedPaths": 58},
    "nativeIndependentRerun": {
        "command": "native-final-rerun-02-command.json",
        "exitCode": review_command["exit_code"],
        "nativeRequests": len(review_result["requests"]),
        "readCalls": 10,
        "hostProviderSamples": len(review_result["nativeMemory"]["hostProviderSamples"]),
        "hookRuns": len(review_result["hookRuns"]),
        "allHookNoncesMatched": True,
        "packetBytesMin": min(row["packetBytes"] for row in review_result["hookRuns"]),
        "packetBytesMax": max(row["packetBytes"] for row in review_result["hookRuns"]),
        "sourceRace": "P03_MEMORY_SOURCE_CHANGED",
        "invalidUtf8": "P03_MEMORY_INVALID_UTF8",
        "acl": "denied with EPERM; icacls restore exited 0; content SHA-256 unchanged",
        "write": "Native TOOL_NOT_FOUND for unregistered Write; filesystem sandbox NOT_RUN",
    },
    "nativeSourceBinding": {
        "nativeCommit": NATIVE_PIN,
        "probeCommit": binding_readback["probeCommit"],
        "inputs": binding_readback["inputCount"],
        "trackedBlobs": binding_readback["trackedSourceInputsMatchedToCommitBlobs"],
        "generatedInputs": binding_readback["generatedInputsRegeneratedAndChecked"],
        "compiledOutputs": binding_readback["compiledJavaScriptOutputsMatched"],
        "runtimeEntrypoints": binding_readback["loadedRuntimeEntrypointsMatched"],
        "mismatches": 0,
    },
    "topologySubexperiment": {"status": "pass", "serviceAssertions": 14},
    "parserProbe": {"status": "pass", "checks": 8, "dependenciesAvailableInXiadie": False},
    "reviewerHarnessCorrection": {
        "firstAttempt": "failed before Native assertions due to repository-root cwd",
        "correctedAttempt": "run-review-02 passed from exact author worktree cwd",
        "firstFailureRetained": True,
    },
}
READBACK_PATH.write_text(json.dumps(readback, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def author_artifact(rel):
    return binding(AUTHOR / pathlib.Path(rel), "author_worktree", AUTHOR)


def root_artifact(rel):
    return binding(ROOT / pathlib.Path(rel), "baseline_repository", ROOT)


def probe_artifact(rel):
    return binding(PROBE / pathlib.Path(rel), "baseline_repository", ROOT)


def review_artifact(rel):
    return binding(REVIEW / pathlib.Path(rel), "review_directory", REVIEW)


author_paths = [
    "docs/adr/P03-reuse.md",
    "evidence/P03-U02/20261008-01/baseline.json",
    "evidence/P03-U02/20261008-01/diff-02.json",
    "evidence/P03-U02/20261008-01/manifest.json",
    "evidence/P03-U02/20261008-01/result.md",
    "evidence/P03-U02/20261008-01/native-runtime/run-08-command.json",
    "evidence/P03-U02/20261008-01/native-runtime/run-08-runtime-result.json",
    "evidence/P03-U02/20261008-01/native-runtime/run-08-host-variant-manifest.json",
    "evidence/P03-U02/20261008-01/native-runtime/run-08-write-probe.json",
    "evidence/P03-U02/20261008-01/native-runtime/run-08-acl-commands.json",
    "evidence/P03-U02/20261008-01/native-runtime/run-08-tsc-build-command.json",
    "evidence/P03-U02/20261008-01/topology-service/result.md",
    "evidence/P03-U02/20261008-01/topology-service/run-02/service-results.json",
    "evidence/P03-U02/20261008-01/topology-service/run-02/summary.json",
    "evidence/P03-U02/20261008-01/topology-service/parser-result.json",
    "evidence/P03-U02/20261008-01/topology-service/parser-run-01-command.json",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-compile-result.json",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-source-bindings-02.json",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-compile-01-command.json",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-bind-02-command.json",
    "spikes/P03/native-memory-runtime.mjs",
    "spikes/P03/native-memory-reader.mjs",
    "spikes/P03/topology-service.mjs",
    "spikes/P03/parser-contract.mjs",
    "spikes/P03/make-host-variant.mjs",
    "spikes/P03/verify-native-dist.mjs",
    "spikes/P03/bind-native-dist-source.mjs",
]
review_paths = [
    "unit-author-manifest-readback.json",
    "unit-author-manifest-readback-command.json",
    "unit-author-manifest-readback.stderr.txt",
    "native-final-output-02/run-review-02-runtime-result.json",
    "native-final-output-02/run-review-02-host-variant-manifest.json",
    "native-final-output-02/run-review-02-write-probe.json",
    "native-final-output-02/run-review-02-acl-commands.json",
    "native-final-rerun-02-command.json",
    "native-final-rerun-02.stderr.txt",
    "native-final-rerun-failed-command.json",
    "native-final-rerun.stderr.txt",
    "native-dist-readback.ps1",
    "native-dist-readback-result.json",
    "native-dist-readback-command.json",
    "native-dist-readback.stderr.txt",
    "native-dist-sourcebinding-readback.ps1",
    "native-dist-sourcebinding-readback-result.json",
    "native-dist-sourcebinding-readback-command.json",
    "native-dist-sourcebinding-readback.stderr.txt",
    "parser-review-20261008-01.json",
    "parser-review-20261008-01-command.json",
    "parser-review-20261008-01.stderr.txt",
    "review-final.json",
    "topology-rerun-command.json",
    "unit-review-readback.json",
    "build-unit-review-final.py",
]
probe_paths = [
    "spikes/P03/verify-native-dist.mjs",
    "spikes/P03/bind-native-dist-source.mjs",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-compile-result.json",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-source-bindings-02.json",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-compile-01-command.json",
    "evidence/P03-U02/20261008-01/topology-service/native-dist-bind-02-command.json",
]

artifacts = (
    [author_artifact(p) for p in author_paths]
    + [root_artifact(p) for p in [
        ".runtime/P03/experiments/u02-native-dist-20261008-01/result.json",
        ".runtime/P03/preparation/parser-source-review/source-manifest.json",
    ]]
    + [probe_artifact(p) for p in probe_paths]
    + [review_artifact(p) for p in review_paths]
)
immutable_inputs = [
    root_artifact("AGENTS.md"),
    root_artifact("planning/Xiadie_V2_v1.1/tasks/P03-U02.md"),
    root_artifact("planning/Xiadie_V2_v1.1/02_计划执行书.md"),
    root_artifact("evidence/P03/status.json"),
]

report = {
    "schema": "p03-independent-review/v1",
    "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "task": "P03-U02",
    "decision": "pass",
    "unit_acceptance": "not_decided",
    "review_target": {
        "author_commit": AUTHOR_COMMIT,
        "baseline_commit": BASELINE,
        "author_worktree": str(AUTHOR),
        "attempt": "20261008-01; independent Native run-review-02; exact final commit review",
        "changed_paths": len(changed),
    },
    "reviewer": "Codex independent readback",
    "scope": "Independent review of the complete P03-U02 research/spike commit against its exact baseline. This report records a review pass only; unit acceptance and coordinator state remain undecided.",
    "checks": [
        {
            "id": "exact-commit-baseline-manifest-and-scope",
            "status": "pass",
            "detail": f"Exact author commit {AUTHOR_COMMIT} descends from baseline {BASELINE}. The main checkout remains clean at the baseline, the author checkout is clean at the reviewed commit, and all {len(changed)} changed paths are within the task's spikes/P03, ADR, and evidence scope. Independent verify-author readback checked all 57 manifest-bound disk files and Git blobs with zero mismatches; manifest SHA-256 is {MANIFEST_SHA}.",
        },
        {
            "id": "native-dist-source-and-runtime-identity",
            "status": "pass",
            "detail": f"The pinned Native source is {NATIVE_PIN}, clean. Independent readback rehashed all 1,181 build inputs and 1,163 generated/existing JavaScript outputs; 1,180 tracked inputs match Git blobs, the one generated input was regenerated and checked against 57 TypeScript libraries, and all six Native entrypoints loaded by the author run match compiled outputs. No mismatch was found. This supports the tested Native dist identity; it is not a full Electron rebuild or dependency reinstall.",
        },
        {
            "id": "native-seam-nonce-packet-and-failure-recovery",
            "status": "pass",
            "detail": "Fresh independent run-review-02 passed from the exact author worktree cwd and produced 20 Native loopback requests, 10 Read-bridge filesystem read records, 12 Host provider samples, and 10 successful Hook runs. Each Hook packet's nonce equals the admitted nonce; packet sizes were 5,478–5,574 UTF-8 bytes under the 12,000-byte limit. The changed V2 topic hash reached the current packet and a subsequent Native Read result. Source mutation failed with P03_MEMORY_SOURCE_CHANGED; invalid UTF-8 failed with P03_MEMORY_INVALID_UTF8 before a successful empty packet; ACL denial produced EPERM, ACL restore commands succeeded, and file SHA-256 remained unchanged. Outside-allowlist Read was rejected and cancellation aborted once. The Write probe proves Native's unregistered-tool TOOL_NOT_FOUND rejection only; low-level filesystem write sandboxing is NOT_RUN.",
        },
        {
            "id": "native-memoryservice-topology-and-relocation",
            "status": "pass",
            "detail": "The separately reviewed topology-service subexperiment passes 14 assertions against the pinned actual Native MemoryService route. It distinguishes same-name A/B repositories, linked worktrees, same-volume move, standalone copy, and cross-volume copy plus git worktree repair; it also covers ACL denial/recovery and demonstrates replacement-tolerant UTF-8 output and absent topic-frontmatter validation. These last two are contract gaps supporting the decision not to use that service result as raw-byte authority. Its prior review is explicitly topology-only, not U02 acceptance.",
        },
        {
            "id": "parser-api-contract-and-dependency-boundary",
            "status": "pass",
            "detail": "The independent parser rerun passes all eight Marked 16.4.2 and yaml 2.9.0 API checks, including Markdown token boundaries, YAML errors/aliases, and fatal UTF-8 ordering. Neither package resolves in Xiadie; the report correctly assigns exact direct dependency, lockfile, and license work to U04 rather than importing from the reference checkout.",
        },
        {
            "id": "adr-scope-and-not-run-boundaries",
            "status": "pass",
            "detail": "The ADR treats selected.md and 2 KiB as PoC fixture limits, maps the four read states to U04, and separates U05 source authority/provenance. It labels the globalThis snapshot as single-Host and requires per-Host/ticket-local state before production reuse. Model, installed application, credentials, Native A/B request isolation, and low-level write sandbox remain NOT_RUN/NOT_READ as appropriate; this research unit does not claim them.",
        },
        {
            "id": "review-harness-cwd-correction",
            "status": "pass",
            "detail": "The first independent runtime invocation failed before Native assertions because it ran from the repository root, doubling the author-worktree prefix in the esbuild input path. That command and stderr are retained. The reviewer corrected cwd to the exact author worktree and reran unchanged script bytes as run-review-02; it exited 0 and passed. The first failure is a reviewer harness invocation error, not a Native product failure.",
        },
    ],
    "reviewer_readback": {
        "readback_record": "unit-review-readback.json",
        "author_manifest": {
            "record": "unit-author-manifest-readback.json",
            "bound_files": 57,
            "changed_paths": 58,
            "mismatches": 0,
        },
        "native_rerun": {
            "command_record": "native-final-rerun-02-command.json",
            "exit_code": 0,
            "attempt_id": "run-review-02",
            "native_requests": 20,
            "read_bridge_reads": 10,
            "host_provider_samples": 12,
            "hook_runs": 10,
            "packet_bytes_min": 5478,
            "packet_bytes_max": 5574,
            "max_packet_budget": 12000,
        },
        "native_source_binding": {
            "record": "native-dist-sourcebinding-readback-result.json",
            "probe_commit": binding_readback["probeCommit"],
            "inputs": 1181,
            "tracked_git_blobs": 1180,
            "regenerated_ignored_input": 1,
            "typescript_libraries": 57,
            "compiled_outputs": 1163,
            "runtime_entrypoints": 6,
            "mismatches": 0,
        },
        "topology_service_assertions": 14,
        "parser_checks": 8,
        "first_harness_failure": "native-final-rerun-failed-command.json; wrong cwd, before assertions; retained",
    },
    "limitations": [
        "This is a research/spike review on synthetic data and a local loopback provider. No production implementation or user memory/profile was changed.",
        "The PoC uses a globalThis snapshot slot and is limited to a single Host. Production must bind snapshot state per Host/admission or use another proven ticket-local mechanism.",
        "The Write probe demonstrates rejection of an unregistered Native tool only. Low-level filesystem write sandboxing is NOT_RUN.",
        "Real-model behavior, installed ZCode/Desktop integration, Native A/B request isolation, credentials, and product tests are NOT_RUN or NOT_READ. This is expected for the research unit and does not block this review.",
        "The independent source-to-dist check covers nine Native CLI packages and their actual loaded entrypoints. It does not claim a full Electron package rebuild or dependency reinstall.",
        "Marked/yaml parser APIs were probed from the pinned source packages; those dependencies are absent from Xiadie's current dependency graph and remain U04 work.",
        "The first reviewer runtime command used the wrong cwd and failed before any Native assertion. Its evidence is preserved alongside the successful corrected-cwd rerun.",
    ],
    "artifacts": artifacts,
    "immutable_inputs": immutable_inputs,
}
REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

ended = time.monotonic()
script_binding = binding(pathlib.Path(__file__), "review_directory", REVIEW)
command_record = {
    "schema": "p03-review-command/v1",
    "executable": str(pathlib.Path(subprocess.check_output(["where", "python"], text=True).splitlines()[0]).resolve()),
    "argv": [str(pathlib.Path(__file__).resolve())],
    "cwd": str(pathlib.Path.cwd()),
    "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "completed_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "exit_code": 0,
    "elapsed_seconds": round(ended - started, 6),
    "script": script_binding,
    "result": binding(READBACK_PATH, "review_directory", REVIEW),
    "report": binding(REPORT_PATH, "review_directory", REVIEW),
}
COMMAND_PATH.write_text(json.dumps(command_record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": "pass", "report": str(REPORT_PATH), "changed_paths": len(changed), "checks": len(report["checks"])}))
