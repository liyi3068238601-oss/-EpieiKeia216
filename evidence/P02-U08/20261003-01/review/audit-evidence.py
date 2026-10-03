import argparse
import hashlib
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("output")
args = parser.parse_args()

root = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
worktree = root / ".runtime/P02/worktrees/u08"
review = root / ".runtime/P02/reviews/u08-final"
author = "066125b86ad01ed811ed88c1da4fb3d91aa884e3"
baseline = "6198ddcf963c7ee594b983f3b1c1fe33f692fb15"
attempt = worktree / "evidence/P02-U08/20261003-01"

def git(*argv):
    return subprocess.check_output(["git", *argv], cwd=worktree)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def read_json(path):
    return json.loads(path.read_bytes())

assert git("rev-parse", "HEAD").decode().strip() == author
assert git("status", "--porcelain").strip() == b""
assert subprocess.run(["git", "merge-base", "--is-ancestor", baseline, author], cwd=worktree).returncode == 0

manifest_path = attempt / "manifest.json"
manifest_raw = manifest_path.read_bytes()
manifest = read_json(manifest_path)
changed_paths = set(git("diff", "--name-only", baseline, author).decode().splitlines())
manifest_paths = {item["path"] for item in manifest["files"]}
assert changed_paths == manifest_paths | {"evidence/P02-U08/20261003-01/manifest.json"}
allowed = lambda item: item.startswith("packages/storage/backup/") or item.startswith("evidence/P02-U08/20261003-01/") or item in {"tools/run-tests.mjs", "tsconfig.json"}
assert all(allowed(item) for item in changed_paths)
assert len(manifest["files"]) == 25 and len(changed_paths) == 26
assert digest(manifest_raw) == "6de478d11cedcee1883fddcb77371493896d6a2ec64822cff5007194aca2ca9e"

baseline_record = read_json(attempt / "baseline.json")
assert baseline_record["baseline_commit"] == baseline
assert baseline_record["author_status"] == "ready_for_review"
assert baseline_record["scope_mapping"] == [
    "packages/storage/backup", "migrations", "tsconfig.json", "tools/run-tests.mjs",
    "evidence/P02-U08/20261003-01",
]
assert baseline_record["test_mapping"] == "packages/storage/backup/test/backup.test.mjs"
card = root / "planning/Xiadie_V2_v1.1/tasks/P02-U08.md"
sources_lock = root / "docs/sources.lock.json"
assert len(card.read_bytes()) == baseline_record["card"]["bytes"]
assert digest(card.read_bytes()) == baseline_record["card"]["sha256"]
assert len(sources_lock.read_bytes()) == baseline_record["source_lock"]["bytes"]
assert digest(sources_lock.read_bytes()) == baseline_record["source_lock"]["sha256"]
u07_acceptance_path = root / "evidence/P02-U07/20261003-01/acceptance.json"
u07_acceptance_raw = u07_acceptance_path.read_bytes()
u07_acceptance = json.loads(u07_acceptance_raw)
u07_expected = baseline_record["prerequisites"][0]["acceptance"]
assert u07_acceptance["status"] == "accepted" and u07_acceptance["task"] == "P02-U07"
assert len(u07_acceptance_raw) == u07_expected["bytes"]
assert digest(u07_acceptance_raw) == u07_expected["sha256"]

migration = pathlib.Path("migrations/001-event-store.ts")
baseline_migration = subprocess.check_output(["git", "show", f"{baseline}:{migration.as_posix()}"], cwd=root)
author_migration = git("show", f"{author}:{migration.as_posix()}")
assert baseline_migration == author_migration
assert str(migration) not in changed_paths

command_index = read_json(attempt / "command-index.json")
command_checks = []
for item in command_index:
    archived = attempt / item["path"]
    archived_raw = archived.read_bytes()
    original = pathlib.Path(item["original"])
    original_raw = original.read_bytes()
    record = json.loads(archived_raw)
    assert archived_raw == original_raw
    assert len(archived_raw) == item["bytes"]
    assert digest(archived_raw) == item["sha256"]
    assert record["exit_code"] == item["exit_code"]
    command_checks.append({"path": item["path"], "bytes": len(archived_raw), "sha256": digest(archived_raw),
                           "exit_code": record["exit_code"]})
assert len(command_checks) == 13
failures = {item["path"]: item["exit_code"] for item in command_checks if item["exit_code"] != 0}
assert failures == {
    "commands/01-build-initial.json": 2,
    "commands/tests-01-test-ack-final.json": 1,
    "commands/tests-02-test-final.json": 1,
}
final_build = read_json(attempt / "commands/07-build-commit-outcome-readback.json")
final_unit = read_json(attempt / "commands/09-final-unit.json")
fixed_node = str(root / ".runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe")
assert final_build["argv"] == [fixed_node, str(worktree / "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"]
assert final_build["exit_code"] == 0
assert final_unit["argv"] == [fixed_node, "tools/run-tests.mjs", "unit", "P02-U08"]
assert final_unit["exit_code"] == 0 and "ℹ pass 15" in final_unit["stdout"] and "ℹ fail 0" in final_unit["stdout"]

expected_digest = "3fdfbd02b2343f10428900836e93ba2c6fc8dd7ea6c90e638e601e7e2e878648"
author_pre = read_json(attempt / "inputs-final-pre.json")
author_post = read_json(attempt / "inputs-final-post.json")
review_pre = read_json(review / "inputs-pre.json")
review_post = read_json(review / "inputs-post.json")
for item in (author_pre, author_post, review_pre, review_post):
    assert len(item["bindings"]) == 122 and item["digest"] == expected_digest
    assert any(binding["path"].endswith("\\migrations\\001-event-store.ts") for binding in item["bindings"])
assert author_pre["bindings"] == author_post["bindings"] == review_pre["bindings"] == review_post["bindings"]
assert author_pre["node_version"] == review_pre["node_version"] == "v24.14.0"
assert author_pre["typescript_version"] == review_pre["typescript_version"] == "6.0.2"
assert review_pre["bindings"] == review_post["bindings"]

results_path = review / "negative-fixtures/counterexample-results.json"
results = read_json(results_path)
assert [item["status"] for item in results["results"]] == ["pass", "pass"]
assert results["results"][0]["result"] == {
    "code": "UNRESOLVED_TRANSACTION", "stage": "migrate", "coordinatorWasActualBeginImmediateHandle": True,
}
assert results["results"][1]["result"] == {
    "code": "CORRUPT_DATABASE", "stage": "restore-source", "destinationCreated": False,
    "captureCountBeforeTamper": 1,
}

report = {
    "schema": "p02-u08-review-audit/v1",
    "author_commit": author,
    "baseline_commit": baseline,
    "worktree_clean": True,
    "manifest": {"files": len(manifest["files"]), "changed_paths": len(changed_paths), "sha256": digest(manifest_raw)},
    "scope": {"in_scope": sorted(changed_paths), "static_migration_unchanged": True},
    "prerequisite": {"task": "P02-U07", "status": "accepted", "sha256": digest(u07_acceptance_raw)},
    "command_archive": {"records": len(command_checks), "failures_preserved": failures,
                        "final_build_exit": final_build["exit_code"], "final_unit_exit": final_unit["exit_code"]},
    "independent_inputs": {"count": 122, "digest": expected_digest, "unchanged_pre_to_post": True,
                           "matches_author_pre_and_post": True, "node": review_pre["node_version"],
                           "typescript": review_pre["typescript_version"]},
    "independent_unit": {"passed": 15, "failed": 0, "skipped": 0},
    "counterexamples": [{"id": item["id"], "status": item["status"], "result": item["result"]}
                        for item in results["results"]],
    "author_commands": command_checks,
}
output = pathlib.Path(args.output).resolve()
assert output.is_relative_to(review)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"output": str(output), "manifest_paths": len(changed_paths), "commands": len(command_checks),
                  "failures_preserved": failures, "inputs": expected_digest, "counterexamples": 2}, ensure_ascii=False))
