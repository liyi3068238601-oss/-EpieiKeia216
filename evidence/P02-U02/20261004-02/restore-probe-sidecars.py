import hashlib
import json
from pathlib import Path

worktree = Path(r"E:\Xiadie\Xiadie\.runtime\P02\worktrees\mature-sqlite-spike")
failure_path = worktree / "evidence/P02-U02/20261004-02/spike-result.json"
source_dir = Path(r"E:\Xiadie\Xiadie\.runtime\P02\experiments\u02\sqlite\run-2026-10-03T054219-873Z-a0f46f00\identity-transaction-and-pragmas")
expected_dir = Path(r"E:\Xiadie\Xiadie\.runtime\P02\experiments\u02\sqlite\run-2026-10-03T054219-873Z-a0f46f00\identity-transaction-and-pragmas")
allowed_parent = Path(r"E:\Xiadie\Xiadie\.runtime\P02\experiments\u02\sqlite\run-2026-10-03T054219-873Z-a0f46f00")

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

failure = json.loads(failure_path.read_text(encoding="utf-8"))
before = failure["input"]["sourceBefore"]
after = failure["input"]["sourceAfter"]
main = source_dir / "facts.sqlite"
assert source_dir.resolve() == expected_dir.resolve()
assert source_dir.resolve().is_relative_to(allowed_parent.resolve())
assert main.resolve().parent == source_dir.resolve()
assert digest(main) == "721537f42d9843617f87dc62b1652c7f1f202f85b0ce5c4305966c70c6da4120"
assert [item["exists"] for item in before[1:]] == [False, False]

expected_generated = {
    "facts.sqlite-wal": {"bytes": 0, "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
    "facts.sqlite-shm": {"bytes": 32768, "sha256": "fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb"},
}
removed = []
for name, expected in expected_generated.items():
    assert name in ("facts.sqlite-wal", "facts.sqlite-shm")
    path = source_dir / name
    assert path.resolve().parent == source_dir.resolve()
    observed = {"bytes": path.stat().st_size, "sha256": digest(path)}
    assert observed == expected
    result_entry = next(item for item in after if Path(item["path"]).name == name)
    assert {"bytes": result_entry["bytes"], "sha256": result_entry["sha256"]} == expected
    path.unlink()
    removed.append({"path": str(path), **observed})

assert digest(main) == "721537f42d9843617f87dc62b1652c7f1f202f85b0ce5c4305966c70c6da4120"
assert not (source_dir / "facts.sqlite-wal").exists()
assert not (source_dir / "facts.sqlite-shm").exists()
record = {
    "schema": "p02-u02-owned-sidecar-restoration/v1",
    "reason": "The failed read-only probe's before snapshot showed these exact sidecars absent; its after snapshot showed the two exact files below. All probe connections and child processes had exited before this restoration.",
    "sourceDatabase": str(main),
    "sourceDatabaseSha256BeforeAndAfter": digest(main),
    "preProbeSidecars": before[1:],
    "probeCreatedSidecarsRemoved": removed,
    "postCleanupSidecars": [
        {"path": str(source_dir / name), "exists": (source_dir / name).exists()}
        for name in expected_generated
    ],
    "cleanupScope": str(source_dir),
}
out = worktree / "evidence/P02-U02/20261004-02/sidecar-cleanup.json"
out.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(record, ensure_ascii=False))
