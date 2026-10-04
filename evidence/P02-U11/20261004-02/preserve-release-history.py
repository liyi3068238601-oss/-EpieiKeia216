"""Copy the accepted 20261003-01 release files from their exact author commit."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


OLD_AUTHOR = "ead4b6bff78250ae9a538819062fd7cb00bd4113"
RELEASE_PATHS = (
    "docs/releases/0.2.0/README.md",
    "docs/releases/0.2.0/freeze.json",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worktree", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    tree = Path(args.worktree).resolve(strict=True)
    output = Path(args.output).resolve()
    repo = Path(r"E:\Xiadie\Xiadie").resolve()
    assert tree.is_relative_to(repo / ".runtime/P02/worktrees/mature-freeze")
    assert output.is_relative_to(tree / "evidence/P02-U11/20261004-02") and not output.exists()
    history = tree / "docs/releases/0.2.0/history/20261003-01"
    assert history.is_relative_to(tree / "docs/releases/0.2.0")
    assert not history.exists()
    history.mkdir(parents=True)
    copied = []
    for relative in RELEASE_PATHS:
        source = subprocess.check_output(["git", "show", f"{OLD_AUTHOR}:{relative}"], cwd=tree)
        blob = subprocess.check_output(["git", "rev-parse", f"{OLD_AUTHOR}:{relative}"], cwd=tree, text=True).strip()
        target = history / Path(relative).name
        assert not target.exists()
        target.write_bytes(source)
        actual = target.read_bytes()
        digest = hashlib.sha256(source).hexdigest()
        assert actual == source
        copied.append({"source_commit": OLD_AUTHOR, "source_path": relative, "git_blob_sha1": blob,
                       "target_path": target.relative_to(tree).as_posix(), "bytes": len(actual),
                       "sha256": digest, "byte_identical": True})
    record = {"schema": "p02-u11-historical-release-copy/v1", "files": copied,
              "boundary": "Raw Git blobs copied by bytes. Current release README/freeze have not been written by this step."}
    output.write_bytes((json.dumps(record, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"copied": len(copied), "sha256": [item["sha256"] for item in copied]}))


if __name__ == "__main__":
    main()
