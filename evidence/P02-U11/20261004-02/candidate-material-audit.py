"""Compare the accepted candidate09 material index to exact author-tree bytes."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess


EXPECTED_DESCRIPTOR_SHA256 = "6d66ef503b90e9e188159dc6a0e112ac81c54066f07336f9671b6aafd4d12f74"
EXPECTED_MATERIAL_COMMIT = "cd03ddc3a3f6f7ca67b4313e309db20db4755343"
EXPECTED_ARTIFACT_COUNT = 6717
EXPECTED_INPUT_COUNT = 103


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worktree", required=True)
    parser.add_argument("--descriptor", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    tree = Path(args.worktree).resolve(strict=True)
    descriptor_path = Path(args.descriptor).resolve(strict=True)
    output = Path(args.output).resolve()
    repository = Path(r"E:\Xiadie\Xiadie").resolve()
    assert tree.is_relative_to(repository / ".runtime/P02/worktrees")
    assert descriptor_path.is_relative_to(repository / ".runtime/P02/experiments/mature-integration/candidate-09")
    assert output.is_relative_to(tree / "evidence/P02-U11/20261004-02") and not output.exists()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=tree, text=True).strip()
    assert head == args.baseline, (head, args.baseline)

    descriptor_bytes = descriptor_path.read_bytes()
    descriptor_sha256 = sha256(descriptor_bytes)
    assert descriptor_sha256 == EXPECTED_DESCRIPTOR_SHA256, descriptor_sha256
    descriptor = json.loads(descriptor_bytes)
    assert descriptor["repositoryCommit"] == EXPECTED_MATERIAL_COMMIT
    assert len(descriptor["artifacts"]) == EXPECTED_ARTIFACT_COUNT
    inputs = descriptor["repositoryInputs"]
    assert len(inputs) == EXPECTED_INPUT_COUNT
    assert len({item["path"] for item in inputs}) == EXPECTED_INPUT_COUNT

    verified = []
    for item in inputs:
        relative = PurePosixPath(item["path"])
        assert not relative.is_absolute() and ".." not in relative.parts
        file = tree.joinpath(*relative.parts).resolve(strict=True)
        assert file.is_relative_to(tree) and file.is_file()
        current = file.read_bytes()
        committed = subprocess.check_output(["git", "show", f"HEAD:{item['path']}"], cwd=tree)
        current_sha = sha256(current)
        assert len(current) == item["bytes"] and current_sha == item["sha256"], item["path"]
        assert committed == current, item["path"]
        verified.append({"path": item["path"], "bytes": len(current), "sha256": current_sha,
                         "candidate_match": True, "baseline_blob_match": True})

    result = {
        "schema": "p02-u11-candidate-material-audit/v1",
        "baseline_commit": head,
        "material_commit": descriptor["repositoryCommit"],
        "source_commit": descriptor["sourceCommit"],
        "descriptor": {"path": str(descriptor_path), "bytes": len(descriptor_bytes),
                       "sha256": descriptor_sha256},
        "artifact_count": len(descriptor["artifacts"]),
        "repository_input_count": len(inputs),
        "verified_input_count": len(verified),
        "mismatches": [],
        "inputs": verified,
        "qualification": "All descriptor-declared source material inputs match both the accepted candidate09 index and the exact clean author-baseline Git blobs. This does not establish runtime candidate integrity or test results; the fresh Desktop suites verify those separately.",
    }
    output.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({"verified_inputs": len(verified), "artifact_count": result["artifact_count"],
                      "descriptor_sha256": descriptor_sha256, "mismatches": []}))


if __name__ == "__main__":
    main()
