"""Build, unpack, and exercise the three-file 0.0.0 research candidate."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import zipfile

ROOT = Path(r"E:\Xiadie\Xiadie")
EXTERNAL = ROOT / "evidence/P00-U12/20261001-01/external-project"
ATTEMPT = ROOT / "evidence/P00-U12/20261001-01"
RELEASE = ROOT / "docs/releases/0.0.0"
BASELINE = "95ac4933ea30049e689c9d4d7d63c2b66ecd62be"
SOURCES = {
    "zcode": (".runtime/P00/zcode/source", "29628c9acdb81b703bbd4080c207a0e7ce5e276e"),
    "dsh": (".runtime/P00/dsh/source", "639ed015397290b3745d163aafe02ffee4aa3f84"),
    "herta": ("references/herta-4623df12", "4623df120adf99340ce5f7e25ed829466975e3ae"),
}


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def file_sha(path: Path) -> str:
    return sha(path.read_bytes())


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def env() -> dict[str, str]:
    system = os.environ.get("SystemRoot", r"C:\Windows")
    return {"SystemRoot": system, "WINDIR": system, "ComSpec": str(Path(system) / "System32/cmd.exe"),
            "PATHEXT": ".COM;.EXE;.BAT;.CMD", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
            "PATH": os.pathsep.join((r"C:\Program Files\nodejs", r"C:\Program Files\Git\cmd",
                                      str(Path(system) / "System32"), str(Path(sys.executable).parent)))}


def command(*args: str, cwd: Path = EXTERNAL) -> subprocess.CompletedProcess[str]:
    return subprocess.run(list(args), cwd=cwd, env=env(), capture_output=True, text=True, check=False)


def accepted_rows() -> list[dict[str, object]]:
    rows = []
    for number in range(1, 12):
        rel = f"evidence/P00-U{number:02d}/20261001-01/acceptance.json"
        path = EXTERNAL / rel
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("status") != "accepted":
            raise RuntimeError(f"Prerequisite not accepted: {rel}")
        rows.append({"unit": f"P00-U{number:02d}", "path": rel,
                     "bytes": path.stat().st_size, "sha256": file_sha(path)})
    return rows


def dependencies() -> dict[str, object]:
    head = command("git", "rev-parse", "HEAD")
    if head.returncode or head.stdout.strip() != BASELINE:
        raise RuntimeError(f"external project HEAD mismatch: {head.stdout.strip()}")
    accepts = accepted_rows()
    source_rows = {}
    for name, (rel, expected) in SOURCES.items():
        path = EXTERNAL / rel
        rev = command("git", "-C", str(path), "rev-parse", "HEAD")
        status = command("git", "-C", str(path), "status", "--porcelain")
        if rev.returncode or rev.stdout.strip() != expected or status.returncode or status.stdout.strip():
            raise RuntimeError(f"source pin or clean check failed: {name}")
        source_rows[name] = {"path": rel, "commit": expected, "clean": True}

    common = [
        "docs/sources.lock.json", "assets/manifest.json", "docs/legal/reuse.md",
        "docs/adr/host-and-reuse.md", "evidence/P00/final-baseline-confirmation.json",
        "planning/Xiadie_V2_v1.1/requirements.json", "planning/Xiadie_V2_v1.1/tasks/P00-U12.md",
        "tests/integration/P00/u07_mock_probe.py", "spikes/zcode-context/probe.py",
        "spikes/zcode-context/host.mjs", "spikes/zcode-context/plugin/.zcode-plugin/plugin.json",
        "spikes/zcode-context/plugin/hooks/hooks.json", "spikes/zcode-context/plugin/hooks/context.mjs",
        ".runtime/P00/zcode/source/config/provider/zcode-builtin.json",
        ".runtime/P00/zcode/source/apps/zcode-cli/packages/bootstrap/dist/index.js",
        ".runtime/P00/zcode/source/apps/zcode-cli/packages/bootstrap/dist/app/create-app.js",
        ".runtime/P00/zcode/source/node_modules/tsx/dist/esm/index.mjs",
    ]
    smoke = [
        "tests/integration/P00/run.py", "spikes/zcode-memory/probe.mjs",
        "spikes/dsh-sdk/probe.ts", "spikes/dsh-sdk/windows-job.py", "spikes/dsh-sdk/job-gate.mjs",
        "spikes/dsh-sdk/job-sdk-bootstrap.mjs", "spikes/dsh-sdk/job-detached-test.py",
        ".runtime/P00/dsh/source/packages/sdk/protocol/src/transport.ts",
        ".runtime/P00/dsh/source/packages/sdk/client/tsconfig.json",
        ".runtime/P00/dsh/source/node_modules/tsx/dist/esm/api/index.mjs",
        "spikes/P00/herta-pure/poc.mjs",
        "references/herta-4623df12/packages/knowledge/src/dream/config.ts",
        "references/herta-4623df12/packages/knowledge/src/dream/retention.ts",
        "references/herta-4623df12/packages/knowledge/src/dream/select-episodes.ts",
        "references/herta-4623df12/packages/knowledge/src/dream/segment-session.ts",
    ]
    file_cases: dict[str, set[str]] = {}
    for rel in common:
        file_cases[rel] = {"smoke", "no-key", "no-dsh", "offline"}
    for rel in smoke:
        file_cases[rel] = {"smoke"}
    for row in accepts:
        file_cases[row["path"]] = {"smoke", "no-key", "no-dsh", "offline"}
    file_rows = []
    for rel, required_by in sorted(file_cases.items()):
        path = EXTERNAL / rel
        if not path.is_file():
            raise RuntimeError(f"external candidate dependency missing: {rel}")
        file_rows.append({"path": rel, "bytes": path.stat().st_size,
                          "sha256": file_sha(path), "required_by": sorted(required_by)})
    node = Path(r"C:\Program Files\nodejs\node.exe")
    py = Path(sys.executable).resolve()
    node_ver = command(str(node), "--version").stdout.strip()
    py_ver = command(str(py), "--version").stdout.strip()
    assets = json.loads((EXTERNAL / "assets/manifest.json").read_text(encoding="utf-8"))
    if assets.get("approvedAssets") != []:
        raise RuntimeError("Expected zero approved role assets for P00 research candidate")
    requirements = json.loads((EXTERNAL / "planning/Xiadie_V2_v1.1/requirements.json").read_text(encoding="utf-8"))
    p00_musts = sorted(row["id"] for row in requirements["requirements"]
                       if row.get("priority") == "must" and "P00" in row.get("stages", []))
    if p00_musts != ["R02", "R03", "R08", "R17", "R24", "R25", "R27"]:
        raise RuntimeError(f"Unexpected P00 Must set: {p00_musts}")
    lock = json.loads((EXTERNAL / "docs/sources.lock.json").read_text(encoding="utf-8"))
    versions = {row["id"]: {"commit": row["commit"], "package_version": row["root_package_version"],
                             "package_manager": row["package_manager"]} for row in lock["sources"]}
    return {
        "project_commit": BASELINE, "project_source_lock_sha256": file_sha(EXTERNAL / "docs/sources.lock.json"),
        "sources": source_rows, "files": file_rows, "acceptances": accepts,
        "toolchain": {
            "python": {"path": str(py), "version": py_ver, "sha256": file_sha(py)},
            "node": {"path": str(node), "version": node_ver, "sha256": file_sha(node)},
            "upstream_package_versions": versions,
        },
        "p00_musts": p00_musts,
        "content_classes": {
            "prompt_and_hook_sources": ["spikes/zcode-context/probe.py", "spikes/zcode-context/host.mjs",
                                        "spikes/zcode-context/plugin/hooks/context.mjs"],
            "protocol_schema_source": ".runtime/P00/dsh/source/packages/sdk/protocol/src/transport.ts",
            "actual_synthetic_packet_prompt_hashes": "Recorded per case in U07 packet/spec/request artifact bindings.",
            "assets_manifest": {"path": "assets/manifest.json", "sha256": file_sha(EXTERNAL / "assets/manifest.json"),
                                "approvedAssets": []},
            "persona_schema": "NOT_PRESENT_IN_P00", "life_schema": "NOT_PRESENT_IN_P00",
            "live2d_and_role_assets": "NOT_PRESENT_IN_P00",
        },
        "archive_policy": {"only_self_authored_candidate_files": True,
                           "third_party_payload": False, "real_credentials": False,
                           "role_assets": False, "installer": False},
    }


def main() -> int:
    if subprocess.run(["git", "-C", str(EXTERNAL), "rev-parse", "HEAD"], cwd=ROOT,
                      env=env(), capture_output=True, text=True).stdout.strip() != BASELINE:
        raise SystemExit("scratch external root is not the fixed accepted baseline")
    archive = RELEASE / "candidate.zip"
    unpacked = ATTEMPT / "unpacked"
    case_root = ATTEMPT / "cases"
    launch_root = ATTEMPT / "launchers"
    for path in (archive, unpacked, case_root, launch_root, RELEASE / "manifest.json"):
        if path.exists():
            raise SystemExit(f"refusing to overwrite existing artifact: {path}")
    candidate, readme = RELEASE / "candidate.py", RELEASE / "README.md"
    package_files = [{"path": p.name, "bytes": p.stat().st_size, "sha256": file_sha(p)}
                     for p in (candidate, readme)]
    manifest = {
        "schema": "xiadie-p00-research-candidate/v1", "product_version": "0.0.0",
        "artifact_kind": "research_candidate_zip", "baseline_commit": BASELINE,
        "package_files": package_files, "external": dependencies(),
        "limitations": ["fixed external local sources and toolchain required", "not portable", "not an installer",
                        "persona/Life schema and role assets absent; no P01 code"],
    }
    write_json(RELEASE / "manifest.json", manifest)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in (candidate, readme, RELEASE / "manifest.json"):
            zf.write(path, path.name)
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        if sorted(names) != ["README.md", "candidate.py", "manifest.json"] or zf.testzip() is not None:
            raise RuntimeError(f"unexpected or damaged ZIP contents: {names}")
        zf.extractall(unpacked)
    package_summary = {
        "archive": {"path": str(archive.relative_to(ROOT)).replace("\\", "/"),
                    "bytes": archive.stat().st_size, "sha256": file_sha(archive),
                    "members": names, "third_party_payload": False},
        "unpacked": str(unpacked.relative_to(ROOT)).replace("\\", "/"),
        "manifest_sha256": file_sha(unpacked / "manifest.json"),
        "candidate_sha256": file_sha(unpacked / "candidate.py"),
        "external_root": str(EXTERNAL), "external_root_head": BASELINE,
        "scratch_source_junctions": {name: {"target": str(ROOT / rel), "usage": "path alias for fixed source; Git clean checks apply; not an ACL sandbox"}
                                     for name, (rel, _) in SOURCES.items()},
    }
    write_json(ATTEMPT / "package-summary.json", package_summary)
    case_root.mkdir(); launch_root.mkdir()
    runs = []
    for case in ("smoke", "no-key", "no-dsh", "offline"):
        case_out = case_root / case
        launcher = launch_root / case
        launcher.mkdir()
        cmd = [sys.executable, str(unpacked / "candidate.py"), "--case", case,
               "--external-root", str(EXTERNAL), "--output-dir", str(case_out)]
        if case == "no-dsh":
            cmd.extend(["--dsh-entry", str(case_out / "isolated-absent-dsh/sdk-entry.mjs")])
        start = time.monotonic()
        proc = subprocess.run(cmd, cwd=unpacked, env=env(), capture_output=True, timeout=1000, check=False)
        (launcher / "stdout.bin").write_bytes(proc.stdout)
        (launcher / "stderr.bin").write_bytes(proc.stderr)
        row = {"command": cmd, "cwd": str(unpacked), "exit_code": proc.returncode,
               "elapsed_seconds": round(time.monotonic() - start, 3),
               "stdout": {"path": str((launcher / "stdout.bin").relative_to(ROOT)).replace("\\", "/"),
                          "bytes": len(proc.stdout), "sha256": sha(proc.stdout)},
               "stderr": {"path": str((launcher / "stderr.bin").relative_to(ROOT)).replace("\\", "/"),
                          "bytes": len(proc.stderr), "sha256": sha(proc.stderr)}}
        summary_path = case_out / "summary.json"
        if summary_path.is_file():
            sraw = summary_path.read_bytes()
            summary = json.loads(sraw)
            row["summary"] = {"path": str(summary_path.relative_to(ROOT)).replace("\\", "/"),
                              "bytes": len(sraw), "sha256": sha(sraw), "status": summary.get("status")}
            row["passed"] = proc.returncode == 0 and summary.get("status") == "passed_with_limits"
        else:
            row["passed"] = False
        write_json(launcher / "command.json", row)
        runs.append(row)
    execution = {"status": "passed_with_limits" if all(r["passed"] for r in runs) else "failed",
                 "cases": runs, "paid_model_calls": 0, "external_network_calls": 0,
                 "archive_sha256": package_summary["archive"]["sha256"],
                 "scope": "The four scenarios were launched from the fresh ZIP extraction directory."}
    write_json(ATTEMPT / "execution.json", execution)
    print(json.dumps({"status": execution["status"], "cases": len(runs),
                      "archive_sha256": package_summary["archive"]["sha256"]}, ensure_ascii=False))
    return 0 if execution["status"] == "passed_with_limits" else 1


if __name__ == "__main__":
    raise SystemExit(main())
