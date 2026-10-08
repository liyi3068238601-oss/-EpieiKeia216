import datetime, hashlib, json, pathlib, sys

root = pathlib.Path("E:/Xiadie/Xiadie").resolve()
worktree = root / ".runtime/P03/worktrees/u08"
attempt = worktree / "evidence/P03-U08/20261008-01"
adoption_path = attempt / "source-adoption.json"
adoption = json.loads(adoption_path.read_bytes())
status_path = root / "evidence/P03/status.json"
status = json.loads(status_path.read_bytes())
tasks = {item["id"]: item for item in status["tasks"]}
records = []

def read_record(path, expected_bytes=None, expected_sha=None, root_name="baseline_repository"):
    file = pathlib.Path(path).resolve(strict=True)
    data = file.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if expected_bytes is not None:
        assert len(data) == expected_bytes, f"byte count mismatch: {file}"
    if expected_sha is not None:
        assert digest == expected_sha, f"SHA-256 mismatch: {file}"
    relative_root = worktree if root_name == "author_worktree" else root
    item = {"root": root_name, "path": file.relative_to(relative_root).as_posix(),
            "absolute_path": str(file), "bytes": len(data), "sha256": digest}
    records.append(item)
    return data, item

for item in adoption["refs"]:
    read_record(root / item["path"], item["bytes"], item["sha256_raw"])

for prior in adoption["accepted_prior_units"]:
    task = tasks[prior["task"]]
    assert task["status"] == "accepted"
    assert task["integration_commit"] == prior["integration_commit"]
    assert task["acceptance"]["path"] == prior["acceptance_path"]
    acceptance_bytes, _ = read_record(root / prior["acceptance_path"], prior["acceptance_bytes"], prior["acceptance_sha256_raw"])
    accepted = json.loads(acceptance_bytes)
    assert accepted["task"] == prior["task"] and accepted["status"] == "accepted"
    assert accepted["integration_commit"] == task["integration_commit"]

u07_acceptance_path = root / "evidence/P03-U07/20261008-01/acceptance.json"
u07 = json.loads(u07_acceptance_path.read_bytes())
review = u07["review"]
read_record(root / review["path"], review["bytes"], review["sha256"])

license_path = root / adoption["native_source"]["license_path"]
license_bytes, license_item = read_record(license_path, root_name="baseline_repository")
assert b"Apache License" in license_bytes[:256] and b"Version 2.0" in license_bytes[:512]
license_item["license_observed"] = "Apache-2.0"

output = pathlib.Path(sys.argv[1]).resolve()
assert output.is_relative_to(root / ".runtime/P03/reviews/u08-20261008") and not output.exists()
summary = {
    "schema": "p03-u08-review-adoption-inputs/v1",
    "at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "adoption_path": str(adoption_path),
    "status_path": str(status_path),
    "accepted_prior_units": [item["task"] for item in adoption["accepted_prior_units"]],
    "accepted_prior_statuses": {item["task"]: tasks[item["task"]]["status"] for item in adoption["accepted_prior_units"]},
    "native_license": "Apache-2.0",
    "checked_count": len(records),
    "inputs": records,
    "mismatches": [],
    "boundary": "Hashes bind the listed bytes and accepted records; they do not establish claim semantics.",
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
print(json.dumps({key: summary[key] for key in ("schema", "accepted_prior_units", "accepted_prior_statuses", "native_license", "checked_count", "mismatches")}))
