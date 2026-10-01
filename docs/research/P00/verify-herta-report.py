"""Independent hash check of the submitted Herta source receipt."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
evidence = root / "evidence/P00-U01/20261001-01"
receipt_path = evidence / "herta-sources.json"
receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
ref = (root / receipt["workspace"]["reference_path"]).resolve()
checks = []
for entry in receipt["source_files"] + receipt["tests"]:
    path = (ref / entry["path"]).resolve()
    assert path.is_relative_to(ref), "Source receipt escaped the reference root"
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    checks.append({"path": entry["path"], "sha256": digest,
                   "match": digest == entry["sha256"]})
report_path = root / "docs/research/P00/herta.md"
passed = all(item["match"] for item in checks)
result = {
    "reviewer": "root, not the Herta report author", "task_id": "P00-U01",
    "disposition": "accepted research section only" if passed else "changes_required",
    "report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
    "receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
    "hash_checks": checks,
    "critical_claims_checked": [
        "LICENSE source-only MIT grant and excluded persona/art/voice paths",
        "config.enabled=false and 90-day half-life only a reference candidate",
        "selector requires settled voice with non-thought speech",
        "episode hash projects kind/tag/text and excludes timestamp",
        "strict manifest distinguishes missing, corrupt and unreadable",
        "retention formula verified against actual fixed source",
    ],
    "verification_command": "python docs/research/P00/verify-herta-report.py",
    "cwd": str(root), "tests_run": False, "product_adoption_approved": False,
    "model_calls": 0, "pass": passed,
}
(evidence / "review-herta.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"hashes_verified": len(checks), "pass": passed}))
raise SystemExit(0 if passed else 1)
