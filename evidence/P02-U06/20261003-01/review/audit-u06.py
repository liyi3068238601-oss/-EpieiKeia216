import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
WT = ROOT / ".runtime/P02/worktrees/u06"
REVIEW = ROOT / ".runtime/P02/reviews/u06-final"
AUTHOR = "f716a444d1889ba33991ca05c36611d7bef2a096"
BASELINE = "a1b611dadafdcf2337d80d62b9d68da485a0a3a2"
EXPECTED_MANIFEST_SHA = "8a240cf787f10b711197ff78df2752edbecea8c9cc68d90664e212e8cb00ff05"
EXPECTED_INPUT_DIGEST = "88bc92d32c60fcf95339e76ce54d59faeed39e2ed43121f9b9144018e1592be4"
ATTEMPT = "20261003-01"
EVIDENCE = pathlib.Path("evidence/P02-U06/20261003-01")


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.STDOUT).decode().strip()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_sha(path):
    raw = path.read_bytes()
    return len(raw), sha(raw)


def read_json(path):
    return json.loads(path.read_bytes())


head = git(WT, "rev-parse", "HEAD")
assert head == AUTHOR, ("author HEAD", head)
status = git(WT, "status", "--porcelain=v1")
assert not status, ("author tree not clean", status)
assert subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, AUTHOR], cwd=WT).returncode == 0

manifest_path = WT / EVIDENCE / "manifest.json"
manifest_bytes, manifest_sha = file_sha(manifest_path)
assert manifest_sha == EXPECTED_MANIFEST_SHA
manifest = read_json(manifest_path)
assert manifest["task_id"] == "P02-U06"
assert manifest["baseline_commit"] == BASELINE
assert len(manifest["files"]) == 30
manifest_mismatches = []
for item in manifest["files"]:
    raw = (WT / item["path"]).read_bytes()
    blob = subprocess.check_output(["git", "cat-file", "blob", f"{AUTHOR}:{item['path']}"], cwd=WT)
    oid = git(WT, "rev-parse", f"{AUTHOR}:{item['path']}")
    if len(raw) != item["bytes"] or sha(raw) != item["sha256"] or raw != blob or oid != item["git_blob"]:
        manifest_mismatches.append(item["path"])
assert not manifest_mismatches, manifest_mismatches
changed = set(git(WT, "diff", "--name-only", BASELINE, AUTHOR).splitlines())
declared = {item["path"] for item in manifest["files"]} | {EVIDENCE.as_posix() + "/manifest.json"}
assert changed == declared, {"undeclared": sorted(changed - declared), "missing": sorted(declared - changed)}
scope_violations = [path for path in changed if not (
    path.startswith("packages/application/evidence/") or
    path == "tools/run-tests.mjs" or
    path.startswith("evidence/P02-U06/20261003-01/")
)]
assert not scope_violations, scope_violations

command_index_path = WT / EVIDENCE / "command-index.json"
command_index = read_json(command_index_path)
assert command_index["count"] == 18
assert len(command_index["files"]) == 18
command_checks = []
archive_root = ROOT / ".runtime/P02/runs/u06"
for item in command_index["files"]:
    evidence_record = WT / EVIDENCE / item["path"]
    run_record = archive_root / pathlib.Path(item["path"]).name
    evidence_len, evidence_sha = file_sha(evidence_record)
    run_len, run_sha = file_sha(run_record)
    assert (evidence_len, evidence_sha) == (item["bytes"], item["sha256"]), item["path"]
    assert (run_len, run_sha) == (item["bytes"], item["sha256"]), item["path"]
    command_checks.append({"path": item["path"], "bytes": evidence_len, "sha256": evidence_sha, "archive_equal": True})

author_pre = read_json(WT / EVIDENCE / "inputs-final-pre.json")
author_post = read_json(WT / EVIDENCE / "inputs-final-post.json")
review_pre = read_json(REVIEW / "inputs-pre.json")
review_post = read_json(REVIEW / "inputs-post-final.json")
recheck_pre = read_json(REVIEW / "inputs-bind-recheck-pre.json")
recheck_post = read_json(REVIEW / "inputs-bind-recheck-post.json")
for label, record in (("author_pre", author_pre), ("author_post", author_post), ("review_pre", review_pre), ("review_post", review_post), ("recheck_pre", recheck_pre), ("recheck_post", recheck_post)):
    assert record["digest"] == EXPECTED_INPUT_DIGEST, (label, record.get("digest"))
    assert len(record["bindings"]) == 112, (label, len(record["bindings"]))
assert author_pre["bindings"] == author_post["bindings"]
assert review_pre["bindings"] == review_post["bindings"]
assert recheck_pre["bindings"] == recheck_post["bindings"]
assert author_pre["bindings"] == review_pre["bindings"] == review_post["bindings"] == recheck_pre["bindings"] == recheck_post["bindings"]
assert author_post.get("unchanged") is True and review_post.get("unchanged") is True
assert recheck_post.get("unchanged") is True
assert author_pre["node_version"] == review_pre["node_version"] == "v24.14.0"
assert author_pre["typescript_version"] == review_pre["typescript_version"] == "6.0.2"

def check_author_command(name, predicate):
    record = read_json(WT / EVIDENCE / "commands" / name)
    assert record["exit_code"] == 0, (name, record["exit_code"], record.get("stderr"))
    assert predicate(record), (name, record.get("argv"), record.get("cwd"))
    return {"record": name, "exit_code": record["exit_code"], "cwd": record["cwd"], "argv": record["argv"]}


author_commands = [
    check_author_command("12-final-build.json", lambda x: "tsc" in " ".join(x["argv"]) and "node-v24.14.0-win-x64" in " ".join(x["argv"])),
    check_author_command("14-final-u06-tests.json", lambda x: "P02-U06" in " ".join(x["argv"]) and "node-v24.14.0-win-x64" in " ".join(x["argv"])),
]
assert str(WT) in author_commands[0]["cwd"] and str(WT) in author_commands[1]["cwd"]

baseline = read_json(WT / EVIDENCE / "baseline.json")
assert baseline["prerequisites"] == [{
    "task": "P02-U05", "status": "accepted", "acceptance": {
        "path": "evidence/P02-U05/20261003-01/acceptance.json",
        "bytes": 6903,
        "sha256": "8f1f28f4a0b71768cec6300d4e0e554f0a51c26b08c8031cf01d72eca89bc357",
    },
}]
u05_acceptance_path = ROOT / "evidence/P02-U05/20261003-01/acceptance.json"
u05_len, u05_sha = file_sha(u05_acceptance_path)
assert (u05_len, u05_sha) == (6903, baseline["prerequisites"][0]["acceptance"]["sha256"])
u05_acceptance = read_json(u05_acceptance_path)
assert u05_acceptance["task"] == "P02-U05" and u05_acceptance["status"] == "accepted"

result_text = (WT / EVIDENCE / "result.md").read_text(encoding="utf-8")
assert "NOT_RUN:" in result_text and "Rollback" in result_text
assert all(term in result_text for term in ["P02-U10", "production databases", "real models/network", "complete runtime dependency closure"])
source_decision = (WT / EVIDENCE / "source-decision.md").read_text(encoding="utf-8")
assert "No third-party source code" in source_decision and "D02/H14 remain card references" in source_decision
source_lock = read_json(WT / "docs/sources.lock.json")
pins = {item["id"]: (item["repository"], item["commit"]) for item in source_lock["sources"]}
assert pins["dsh"] == ("https://github.com/deepseek-ai/deepseek-harness.git", "639ed015397290b3745d163aafe02ffee4aa3f84")
assert pins["herta"] == ("https://github.com/PersonaCLI/Herta.git", "4623df120adf99340ce5f7e25ed829466975e3ae")

source_inputs = {
    "AGENTS.md": "b6ab92bf4c41d1cbc44fede9c152614b38bc24e5de8c293a55db258735ef53f4",
    "planning/Xiadie_V2_v1.1/tasks/P02-U06.md": "cb443521f7ff3c69a145da425c921610bb406e066640b27a3dce95cb2fb53ff4",
    "docs/sources.lock.json": "009bed3ecc89b12602824ea5d136682d0373e11f3d066e6c2a860cb48afce02e",
    "packages/contracts/src/events.ts": "c2a7d013164b1c3e5e6c27748a3b06ef1856cf22346acd11e356c191718500ee",
    "packages/storage/events/src/index.ts": "04f4ecc5f54122dbfa14eff2de982cb3f81967f6d41b205d1694d24127eb9545",
    "packages/adapters/zcode/src/transcript.ts": "73fcaf64d5932fc15ea7c24d47f103891807ca96015c2ff81fc79ada8f4f3174",
    "packages/application/turn-projection.ts": "2fc3f675856588b2ae8e6e3eb668f913b43bc9acb892a066b7e59a9e4e375292",
}
for name, expected in source_inputs.items():
    raw = (WT / name).read_bytes()
    assert sha(raw) == expected, (name, sha(raw))
    assert raw == subprocess.check_output(["git", "cat-file", "blob", f"{BASELINE}:{name}"], cwd=WT), name

for task, digest in (
    ("P02-U02", "715724b9c83abc17fb8536b7a5c02dd72653bf794a199deb531a036d5867caa8"),
    ("P02-U03", "049abb37c43d4a9edc1a55d230047461a50948fea590b1510a85379cb9d1abac"),
):
    accepted_path = ROOT / f"evidence/{task}/20261003-01/acceptance.json"
    accepted_len, accepted_sha = file_sha(accepted_path)
    accepted = read_json(accepted_path)
    assert accepted["task"] == task and accepted["status"] == "accepted"
    assert accepted_sha == digest

audit = {
    "task": "P02-U06",
    "author_commit": AUTHOR,
    "baseline_commit": BASELINE,
    "author_worktree_clean": True,
    "baseline_is_ancestor": True,
    "manifest": {"files": len(manifest["files"]), "changed_paths": len(changed), "bytes": manifest_bytes, "sha256": manifest_sha, "disk_blob_mismatches": []},
    "scope_violations": [],
    "command_index": {"records": len(command_checks), "all_evidence_and_archive_copies_match": True, "checks": command_checks},
    "author_final_commands": author_commands,
    "prerequisites": {"u05_status": "accepted", "u05_acceptance_sha256": u05_sha, "u02_u03_status": "accepted"},
    "source_pins": {"D02": {"repository": pins["dsh"][0], "commit": pins["dsh"][1]}, "H14": {"repository": pins["herta"][0], "commit": pins["herta"][1]}},
    "independent_bindings": {
        "entries": 112,
        "digest": EXPECTED_INPUT_DIGEST,
        "author_pre_post_identical": True,
        "review_pre_post_identical": True,
        "author_review_bindings_identical": True,
        "review_recheck_identical": True,
        "node": review_pre["node_version"],
        "typescript": review_pre["typescript_version"],
    },
    "not_run_and_rollback_recorded": True,
}
(REVIEW / "audit-results.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
print(json.dumps(audit, ensure_ascii=False))
