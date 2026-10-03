import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
WT = ROOT / ".runtime/P02/worktrees/u07"
REVIEW = ROOT / ".runtime/P02/reviews/u07-final"
AUTHOR = "bbabe95348b166332a072130fe4b394995c018d7"
BASELINE = "6f445086853126227396029cf973c2fd33f90229"
EXPECTED_MANIFEST = "ae3d8d163dad24199943a55e2dd0161c7b08d4dde0a773d85f92f0c8b445bcb9"
EXPECTED_BINDING = "b33f5b52393427fb1738720333686f64eeceae0177704b0f90dfec3d46fae781"
EVIDENCE = pathlib.Path("evidence/P02-U07/20261003-01")


def git(cwd, *args):
    return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.STDOUT).decode().strip()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_json(path):
    return json.loads(path.read_bytes())


head = git(WT, "rev-parse", "HEAD")
assert head == AUTHOR
assert git(WT, "status", "--porcelain=v1") == ""
assert subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, AUTHOR], cwd=WT).returncode == 0

manifest_path = WT / EVIDENCE / "manifest.json"
manifest_bytes = manifest_path.read_bytes()
assert sha(manifest_bytes) == EXPECTED_MANIFEST
manifest = read_json(manifest_path)
assert manifest["task_id"] == "P02-U07" and manifest["baseline_commit"] == BASELINE
assert len(manifest["files"]) == 19
changed = set(git(WT, "diff", "--name-only", BASELINE, AUTHOR).splitlines())
declared = {entry["path"] for entry in manifest["files"]} | {EVIDENCE.as_posix() + "/manifest.json"}
assert changed == declared and len(changed) == 20
scope_violations = [p for p in changed if not (
    p.startswith("packages/application/recovery/") or p == "tools/run-tests.mjs" or
    p.startswith("evidence/P02-U07/20261003-01/")
)]
assert not scope_violations

index = read_json(WT / EVIDENCE / "command-index.json")
assert isinstance(index, list) and len(index) == 8
command_archive_checks = []
for entry in index:
    evidence_record = WT / EVIDENCE / entry["path"]
    original_record = pathlib.Path(entry["original"])
    assert original_record.is_absolute() and original_record.is_relative_to(ROOT / ".runtime/P02/commands/u07")
    for path in (evidence_record, original_record):
        raw = path.read_bytes()
        assert len(raw) == entry["bytes"] and sha(raw) == entry["sha256"], str(path)
    parsed = read_json(evidence_record)
    assert parsed["exit_code"] == entry["exit_code"]
    command_archive_checks.append({"path": entry["path"], "bytes": entry["bytes"], "sha256": entry["sha256"], "archived_copy_matches": True, "exit_code": entry["exit_code"]})

author_pre = read_json(WT / EVIDENCE / "inputs-final-pre.json")
author_post = read_json(WT / EVIDENCE / "inputs-final-post.json")
review_pre = read_json(REVIEW / "inputs-pre.json")
review_post = read_json(REVIEW / "inputs-post-final.json")
for record in (author_pre, author_post, review_pre, review_post):
    assert len(record["bindings"]) == 117 and record["digest"] == EXPECTED_BINDING
assert author_pre["bindings"] == author_post["bindings"]
assert review_pre["bindings"] == review_post["bindings"]
assert author_pre["bindings"] == review_pre["bindings"] == review_post["bindings"]
assert author_post.get("unchanged") is True and review_post.get("unchanged") is True
assert review_pre["node_version"] == "v24.14.0" and review_pre["typescript_version"] == "6.0.2"

def final_command(name, contains):
    item = read_json(WT / EVIDENCE / "commands" / name)
    assert item["exit_code"] == 0 and str(WT) == item["cwd"]
    assert all(term in " ".join(item["argv"]) for term in contains)
    return {"record": name, "argv": item["argv"], "cwd": item["cwd"], "exit_code": item["exit_code"]}


author_final_commands = [
    final_command("04-final-build.json", ["node-v24.14.0-win-x64", "tsc", "tsconfig.json"]),
    final_command("06-final-unit.json", ["node-v24.14.0-win-x64", "P02-U07"]),
]

baseline = read_json(WT / EVIDENCE / "baseline.json")
for record_key, file_path in (("card", "planning/Xiadie_V2_v1.1/tasks/P02-U07.md"), ("source_lock", "docs/sources.lock.json")):
    raw = (WT / file_path).read_bytes()
    assert len(raw) == baseline[record_key]["bytes"] and sha(raw) == baseline[record_key]["sha256"]
assert baseline["prerequisites"] == [{
    "task": "P02-U06", "status": "accepted", "acceptance": {
        "path": "evidence/P02-U06/20261003-01/acceptance.json", "bytes": 5204,
        "sha256": "da6486ebaf884e3723e45a0e1f93712f7e6d32755dd608b4336eafb65d868cb5",
    },
}]
u06_path = ROOT / "evidence/P02-U06/20261003-01/acceptance.json"
u06_raw = u06_path.read_bytes()
assert len(u06_raw) == 5204 and sha(u06_raw) == baseline["prerequisites"][0]["acceptance"]["sha256"]
assert read_json(u06_path)["status"] == "accepted"

source_text = (WT / EVIDENCE / "source-decision.md").read_text(encoding="utf-8")
assert "no upstream source was copied" in source_text.lower()
result_text = (WT / EVIDENCE / "result.md").read_text(encoding="utf-8")
assert "NOT_RUN" in result_text and "Rollback" in result_text

audit = {
    "task": "P02-U07", "author_commit": AUTHOR, "baseline_commit": BASELINE,
    "author_worktree_clean": True, "baseline_is_ancestor": True,
    "manifest": {"files": 19, "changed_paths": 20, "bytes": len(manifest_bytes), "sha256": EXPECTED_MANIFEST, "verify_author_mismatches": 0},
    "scope_violations": [],
    "command_index": {"entries": 8, "evidence_and_original_archives_match": True, "checks": command_archive_checks},
    "author_final_commands": author_final_commands,
    "prerequisite": {"task": "P02-U06", "status": "accepted", "bytes": len(u06_raw), "sha256": sha(u06_raw)},
    "independent_bindings": {"entries": 117, "digest": EXPECTED_BINDING, "migration_included": True, "author_reviewer_match": True, "pre_post_unchanged": True, "node": review_pre["node_version"], "typescript": review_pre["typescript_version"]},
    "not_run_and_rollback_recorded": True,
}
(REVIEW / "audit-results.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
print(json.dumps(audit))
