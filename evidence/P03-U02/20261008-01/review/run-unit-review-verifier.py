import datetime
import hashlib
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(r"E:\Xiadie\Xiadie").resolve()
REVIEW = ROOT / ".runtime/P03/reviews/u02-20261008"
REPORT = REVIEW / "unit-review-final.json"
VERIFIER = ROOT / ".runtime/P03/coord/verify-review.py"
AUTHOR = "e9314207347d33dd61cab941a8dca549c9575ca8"
OUTPUT = REVIEW / "unit-review-verification-command.json"


def bind(path):
    path = pathlib.Path(path).resolve()
    data = path.read_bytes()
    return {"path": path.relative_to(ROOT).as_posix(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


started = time.monotonic()
started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
argv = [str(VERIFIER), str(REPORT), AUTHOR]
completed = subprocess.run([sys.executable, *argv], cwd=ROOT, text=True, capture_output=True)
record = {
    "schema": "p03-review-verification-command/v1",
    "executable": sys.executable,
    "argv": argv,
    "cwd": str(ROOT),
    "started_at_utc": started_at,
    "completed_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "elapsed_seconds": round(time.monotonic() - started, 6),
    "exit_code": completed.returncode,
    "stdout": completed.stdout,
    "stderr": completed.stderr,
    "report": bind(REPORT),
    "verifier": bind(VERIFIER),
}
OUTPUT.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(completed.stdout, end="")
if completed.stderr:
    print(completed.stderr, file=sys.stderr, end="")
sys.exit(completed.returncode)
