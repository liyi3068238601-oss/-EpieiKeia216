"""Read-only verification of the archive extraction and fixed reference trees."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
PINS = {
    "zcode-29628c9": "29628c9acdb81b703bbd4080c207a0e7ce5e276e",
    "dsh-639ed015": "639ed015397290b3745d163aafe02ffee4aa3f84",
    "herta-4623df12": "4623df120adf99340ce5f7e25ed829466975e3ae",
}

def git(path: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args], text=True).strip()

def main() -> int:
    refs = []
    for name, expected in PINS.items():
        path = ROOT / "references" / name
        actual = git(path, "rev-parse", "HEAD")
        dirty = git(path, "status", "--porcelain")
        refs.append({"name": name, "expected_commit": expected,
                     "actual_commit": actual, "clean": not dirty,
                     "tree": git(path, "rev-parse", "HEAD^{tree}")})
    archive = ROOT / "Xiadie_V2_计划与执行包_v1.1.zip"
    digest = hashlib.sha256(archive.read_bytes()).hexdigest().upper()
    expected = "3FCC323F433C222A3B4C651D0661DFD0F1EEB4577DED0E07436821FC7E9C22AB"
    plan = ROOT / "planning/Xiadie_V2_v1.1"
    manifest = json.loads((plan / "PACKAGE_MANIFEST.json").read_text(encoding="utf-8-sig"))
    failures = []
    for item in manifest["files"]:
        path = (plan / item["path"]).resolve()
        if not path.is_relative_to(plan.resolve()):
            failures.append({"path": item["path"], "reason": "outside plan"})
            continue
        data = path.read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            failures.append({"path": item["path"], "reason": "bytes or sha256 differ"})
    passed = not failures and digest == expected and all(r["clean"] and r["actual_commit"] == r["expected_commit"] for r in refs)
    result = {"project_root": str(ROOT), "archive_sha256": digest,
              "references": refs, "manifest_files_verified": len(manifest["files"]),
              "manifest_failures": failures, "pass": passed, "product_tests_run": False,
              "model_generation_requests": 0}
    target = ROOT / "evidence/P00-U01/20261001-01/baseline-verification.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=True))
    return 0 if passed else 1

if __name__ == "__main__":
    sys.exit(main())
