import datetime, hashlib, json, pathlib, sys

root = pathlib.Path("E:/Xiadie/Xiadie").resolve()
worktree = root / ".runtime/P03/worktrees/u08"
attempt = worktree / "evidence/P03-U08/20261008-01"
output = pathlib.Path(sys.argv[1]).resolve()
assert output.is_relative_to(root / ".runtime/P03/reviews/u08-20261008") and not output.exists()
before = json.loads((attempt / "execution-before.json").read_bytes())
after = json.loads((attempt / "execution-after.json").read_bytes())

def key(item):
    return (item["path"], item["bytes"], item["sha256"])

assert before["node_version"] == after["node_version"] == "v24.14.0"
assert before["typescript_version"] == after["typescript_version"] == "6.0.2"
assert len(before["bindings"]) == len(after["bindings"]) == 173
assert [key(item) for item in before["bindings"]] == [key(item) for item in after["bindings"]]
records, mismatches = [], []
for item in after["bindings"]:
    file = pathlib.Path(item["path"]).resolve(strict=True)
    assert file.is_relative_to(root)
    data = file.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    root_name = "author_worktree" if file.is_relative_to(worktree) else "baseline_repository"
    relative_root = worktree if root_name == "author_worktree" else root
    record = {
        "root": root_name,
        "path": file.relative_to(relative_root).as_posix(),
        "absolute_path": str(file),
        "expected_bytes": item["bytes"],
        "actual_bytes": len(data),
        "expected_sha256": item["sha256"],
        "actual_sha256": actual,
    }
    records.append(record)
    if len(data) != item["bytes"] or actual != item["sha256"]:
        mismatches.append(record["absolute_path"])
summary = {
    "schema": "p03-u08-review-execution-inputs/v1",
    "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "worktree": str(worktree),
    "execution_before": str(attempt / "execution-before.json"),
    "execution_after": str(attempt / "execution-after.json"),
    "node_version": after["node_version"],
    "typescript_version": after["typescript_version"],
    "before_count": len(before["bindings"]),
    "after_count": len(after["bindings"]),
    "tuple_sets_identical": True,
    "current_files_checked": len(records),
    "mismatches": mismatches,
    "counts_by_root": {
        name: sum(1 for item in records if item["root"] == name)
        for name in ("author_worktree", "baseline_repository")
    },
    "bindings": records,
    "boundary": "Declared executable/source/compiled bindings only, not a complete installed dependency closure.",
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(json.dumps({
    key: summary[key]
    for key in ("schema", "before_count", "after_count", "tuple_sets_identical", "current_files_checked", "mismatches", "counts_by_root")
}))
assert not mismatches
