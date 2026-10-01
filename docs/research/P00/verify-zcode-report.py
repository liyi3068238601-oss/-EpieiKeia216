"""Independent fixed-source receipt check; does not run ZCode."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
evidence = root / "evidence/P00-U01/20261001-01"
receipt_path = evidence / "zcode-sources.json"
receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
ref = (root / receipt["source_repository"]["checkout"]).resolve()
checks = []
for item in receipt["hashed_sources"]:
    path = (ref / item["path"]).resolve()
    assert path.is_relative_to(ref)
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    checks.append({"path": item["path"], "sha256": actual, "match": actual == item["sha256"]})
report = root / receipt["report"]
passed = all(item["match"] for item in checks) and receipt["license_review"]["spdx"] == "Apache-2.0"
result = {
    "reviewer": "root, not the ZCode report author", "task_id": "P00-U01",
    "disposition": "accepted research section only" if passed else "changes_required",
    "report_sha256": hashlib.sha256(report.read_bytes()).hexdigest(),
    "receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
    "hash_checks": checks, "pass": passed,
    "critical_claims_checked": [
        "LICENSE/NOTICE corrected from erroneous MIT to Apache-2.0 before acceptance",
        "CLI provider and paths use ZCODE_DATA_BASE_DIR separately from cwd",
        "Hook context cap 24000 and temporary transcript cleanup",
        "Hook exitCode 2 blocks; ordinary execution failure is recoverable",
        "persistent memory user/project/local paths and automatic Write/Edit",
        "unreadable memory index is caught and treated empty by upstream",
        "fixed tree contains only four test filenames and no focused Hook/memory tests",
    ],
    "verification_command": "python docs/research/P00/verify-zcode-report.py",
    "cwd": str(root), "tests_run": False, "model_calls": 0,
    "product_adoption_approved": False,
}
(evidence / "review-zcode.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"hashes_verified": len(checks), "pass": passed}))
raise SystemExit(0 if passed else 1)
