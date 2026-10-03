import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie")
TREE = ROOT / ".runtime/P02/worktrees/u09"
REVIEW = ROOT / ".runtime/P02/reviews/u09-final"
AUTHOR = "90034445be3175038e976b04211369ffada5e975"
BASELINE = "99c8702a34660f36b528efa0cca8c7257e6f98a5"
EVIDENCE_REL = pathlib.Path("evidence/P02-U09/20261003-01")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_bytes())


head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=TREE).decode().strip()
status = subprocess.check_output(["git", "status", "--porcelain"], cwd=TREE).decode()
assert head == AUTHOR, head
assert status == "", status

manifest_path = TREE / EVIDENCE_REL / "manifest.json"
manifest_bytes = manifest_path.read_bytes()
manifest = json.loads(manifest_bytes)
changed = set(subprocess.check_output(
    ["git", "diff", "--name-only", BASELINE, AUTHOR], cwd=ROOT
).decode().splitlines())
manifest_paths = {item["path"] for item in manifest["files"]}
assert len(manifest["files"]) == 21
assert len(changed) == 22
assert manifest_paths == changed - {str(EVIDENCE_REL / "manifest.json").replace("\\", "/")}
allowed = (
    "packages/diagnostics/",
    "tools/run-tests.mjs",
    "tsconfig.json",
    "evidence/P02-U09/20261003-01/",
)
assert all(any(path.startswith(prefix) for prefix in allowed) for path in changed)

command_index = read_json(TREE / EVIDENCE_REL / "command-index.json")
assert len(command_index) == 10
command_checks = []
for item in command_index:
    author_path = TREE / EVIDENCE_REL / item["path"]
    archive_path = pathlib.Path(item["original"])
    author_bytes = author_path.read_bytes()
    archive_bytes = archive_path.read_bytes()
    record = json.loads(author_bytes)
    assert author_bytes == archive_bytes, item["path"]
    assert len(author_bytes) == item["bytes"], item["path"]
    assert sha(author_bytes) == item["sha256"], item["path"]
    assert record["exit_code"] == item["exit_code"], item["path"]
    command_checks.append({"path": item["path"], "exit_code": record["exit_code"], "sha256": sha(author_bytes)})

expected_failures = {
    "commands/02-receipt-unverified-build.json": 2,
    "commands/tests-01-unit-initial.json": 1,
}
by_path = {item["path"]: item for item in command_checks}
assert all(by_path[path]["exit_code"] == code for path, code in expected_failures.items())
for path in (
    "commands/03-receipt-unverified-build.json",
    "commands/05-final-unit.json",
    "commands/tests-02-unit-final.json",
    "commands/tests-03-unit-default-pagination.json",
    "commands/tests-04-unit-receipt-unverified-page.json",
):
    assert by_path[path]["exit_code"] == 0, path

baseline = read_json(TREE / EVIDENCE_REL / "baseline.json")
card = ROOT / "planning/Xiadie_V2_v1.1/tasks/P02-U09.md"
source_lock = ROOT / "docs/sources.lock.json"
assert baseline["task"] == "P02-U09"
assert baseline["baseline_commit"] == BASELINE
assert baseline["author_status"] == "ready_for_review"
assert sha(card.read_bytes()) == baseline["card"]["sha256"]
assert sha(source_lock.read_bytes()) == baseline["source_lock"]["sha256"]
u08_acceptance = ROOT / "evidence/P02-U08/20261003-01/acceptance.json"
u08_acceptance_bytes = u08_acceptance.read_bytes()
assert sha(u08_acceptance_bytes) == baseline["prerequisites"][0]["acceptance"]["sha256"]
assert json.loads(u08_acceptance_bytes)["status"] == "accepted"

migration = TREE / "migrations/001-event-store.ts"
baseline_migration = ROOT / "migrations/001-event-store.ts"
assert migration.read_bytes() == baseline_migration.read_bytes()
assert subprocess.run(
    ["git", "diff", "--quiet", BASELINE, AUTHOR, "--", "migrations/001-event-store.ts"], cwd=ROOT
).returncode == 0

author_pre = read_json(TREE / EVIDENCE_REL / "inputs-final-pre.json")
author_post = read_json(TREE / EVIDENCE_REL / "inputs-final-post.json")
review_pre = read_json(REVIEW / "inputs-pre.json")
review_post = read_json(REVIEW / "inputs-post.json")
assert len(author_pre["bindings"]) == len(author_post["bindings"]) == 126
assert len(review_pre["bindings"]) == len(review_post["bindings"]) == 126
assert author_pre["digest"] == author_post["digest"] == review_pre["digest"] == review_post["digest"]
assert author_pre["bindings"] == author_post["bindings"] == review_pre["bindings"] == review_post["bindings"]
assert author_pre["node_version"] == review_pre["node_version"] == "v24.14.0"
assert author_pre["typescript_version"] == review_pre["typescript_version"] == "6.0.2"

source = TREE / "packages/diagnostics/src/index.ts"
source_sha = sha(source.read_bytes())
assert source_sha == "e91e73753c37cf236720dc14abe38a2253c24b02c2b55cfeb2ff2b4f313a0f99"
report_text = (TREE / EVIDENCE_REL / "result.md").read_text(encoding="utf-8")
assert "NOT_VERIFIED" in report_text
assert "NOT_RUN" in report_text

result = {
    "schema": "p02-u09-independent-evidence-audit/v1",
    "author_commit": head,
    "baseline_commit": BASELINE,
    "worktree_clean": True,
    "manifest": {"files": len(manifest["files"]), "changed_paths": len(changed), "sha256": sha(manifest_bytes)},
    "scope": "pass",
    "prerequisite_u08": "accepted",
    "migration_unchanged": True,
    "source_sha256": source_sha,
    "author_command_archive": {"records": len(command_checks), "checks": command_checks},
    "bindings": {
        "count": len(review_pre["bindings"]),
        "digest": review_pre["digest"],
        "author_pre_post_equal": True,
        "review_pre_post_equal": True,
        "review_matches_author": True,
        "migration_included": any(item["path"].lower().endswith("migrations\\001-event-store.ts") for item in review_pre["bindings"]),
    },
}
(REVIEW / "audit-results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))
