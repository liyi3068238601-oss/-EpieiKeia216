"""Generate P03-U10's author freeze from already completed, archived evidence.

This helper is intentionally read-only until its final exclusive-create pass.
It writes only docs/releases/0.3.0 and evidence/P03-U10/20261008-01 in the
isolated U10 worktree. It does not accept or publish the work.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

ATTEMPT = "20261008-01"
NATIVE = "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
PLAN_COUNT = 423
RELEASE = "docs/releases/0.3.0"
EVIDENCE = f"evidence/P03-U10/{ATTEMPT}"
GROUPS = ("code", "prompt", "schema", "resources", "tools_and_configuration", "qualification_tests")
CORRECTION_INPUTS = ("tests/integration/P03/project-memory-host.mjs",
                     "tests/integration/P03/project-memory-audit.mjs",
                     "tests/integration/P03/project-memory-audit.test.mjs",
                     "tests/integration/P03/seed-memory.mjs", "tests/integration/P03/desktop.py")


def need(ok: bool, why: str) -> None:
    if not ok:
        raise RuntimeError(why)


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read(path: pathlib.Path, label: str = "file") -> bytes:
    need(path.is_file() and not path.is_symlink(), f"{label} is not a regular file: {path}")
    return path.read_bytes()


def load(path: pathlib.Path) -> dict:
    return json.loads(read(path, "JSON").decode("utf-8"))


def git(root: pathlib.Path, *args: str) -> bytes:
    p = subprocess.run(["git", "-C", str(root), *args], capture_output=True)
    if p.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed: {p.stderr.decode('utf-8', 'replace')[:800]}")
    return p.stdout


def text_git(root: pathlib.Path, *args: str) -> str:
    return git(root, *args).decode("utf-8", "surrogateescape").strip()


def rel(value: str) -> pathlib.PurePosixPath:
    value = str(value).replace("\\", "/")
    p = pathlib.PurePosixPath(value)
    need(value and not p.is_absolute() and ".." not in p.parts and not re.match(r"^[A-Za-z]:", value),
         f"unsafe repository path: {value!r}")
    return p


def under(root: pathlib.Path, value: str) -> pathlib.Path:
    p = root.joinpath(*rel(value).parts)
    for part in p.relative_to(root).parents:
        need(not (root / part).is_symlink(), f"symlink in scoped path: {root / part}")
    need(not p.is_symlink(), f"symlink in scoped path: {p}")
    try:
        p.resolve(strict=False).relative_to(root.resolve())
    except ValueError as e:
        raise RuntimeError(f"path escapes {root}: {value}") from e
    return p


def file_ref(path: pathlib.Path, name: str | None = None) -> dict:
    raw = read(path)
    return {"path": name or str(path.resolve()), "bytes": len(raw), "sha256": digest(raw)}


def repo_ref(root: pathlib.Path, name: str) -> dict:
    return file_ref(under(root, name), pathlib.PurePosixPath(name).as_posix())


def check_hash(row: dict, raw: bytes, label: str) -> None:
    expected = row.get("sha256", row.get("raw_sha256"))
    need(row.get("bytes") == len(raw) and isinstance(expected, str) and digest(raw) == expected.lower(),
         f"{label} byte count or raw SHA-256 differs")


def allowed(path: str) -> bool:
    path = path.replace("\\", "/").lstrip("./")
    return path.startswith(RELEASE + "/") or path.startswith(EVIDENCE + "/") or path in CORRECTION_INPUTS


def accepted_unit(tasks: dict, root: pathlib.Path, name: str) -> dict:
    row = tasks.get(name)
    need(isinstance(row, dict) and row.get("status") == "accepted", f"{name} is not canonically accepted")
    acc, review = row.get("acceptance"), row.get("review")
    need(isinstance(acc, dict) and isinstance(review, dict) and review.get("status") == "pass",
         f"{name} acceptance/review metadata is incomplete")
    ap = rel(acc.get("path", ""))
    ar = read(under(root, ap.as_posix()), f"{name} acceptance")
    check_hash(acc, ar, f"{name} acceptance")
    ev = review.get("evidence")
    need(isinstance(ev, dict), f"{name} review evidence is missing")
    ep = rel(ev.get("path", ""))
    er = read(under(root, ep.as_posix()), f"{name} review")
    check_hash(ev, er, f"{name} review")
    return {"task": name, "status": "accepted", "author_commit": row.get("author_commit"),
            "integration_commit": row.get("integration_commit"),
            "acceptance": {"path": ap.as_posix(), "bytes": len(ar), "sha256": digest(ar)},
            "review": {"path": ep.as_posix(), "bytes": len(er), "sha256": digest(er), "decision": "pass"}}


def classify(path: str) -> list[str]:
    low = path.casefold()
    out = []
    if path.startswith(("packages/", "migrations/")):
        out.append("code")
    if path.startswith(("templates/", "assets/character/", "plugins/xiadie/hooks/")) or "prompt" in low or "persona" in low:
        out.append("prompt")
    if path.startswith("migrations/") or "/schema" in low or low.endswith(".schema.json"):
        out.append("schema")
    if path.startswith(("assets/", "plugins/")):
        out.append("resources")
    if path.startswith("tools/") or path in {"package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.mjs"}:
        out.append("tools_and_configuration")
    if path.startswith("tests/") or "/test/" in low or "/tests/" in low:
        out.append("qualification_tests")
    return out


def candidate_inputs(rows: list, wt: pathlib.Path, head: str) -> tuple[dict, list]:
    files = {key: [] for key in GROUPS}
    all_rows, seen = [], set()
    for row in rows:
        p = rel(row.get("path", "")); name = p.as_posix()
        need(name.casefold() not in seen, f"candidate repeats repository input: {name}")
        seen.add(name.casefold())
        raw = read(under(wt, name), f"repository input {name}")
        check_hash(row, raw, name)
        need(raw == git(wt, "show", f"{head}:{name}"), f"repository input differs from current Git blob: {name}")
        bound = {"path": name, "bytes": len(raw), "sha256": digest(raw)}
        all_rows.append(bound)
        for group in classify(name):
            files[group].append(bound)
    need({"packages/adapters/zcode/src/project-memory.ts", "packages/projects/relocate.ts", "packages/projects/export.ts"} <= seen,
         "candidate repositoryInputs omit accepted project-memory/relocation code")
    result = {}
    for group, rows in files.items():
        rows.sort(key=lambda x: x["path"].casefold())
        raw = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        result[group] = {"count": len(rows), "bindings_sha256": digest(raw), "files": rows}
    return result, all_rows


def suite(name: str, root: pathlib.Path, descriptor: pathlib.Path, desc: dict, dsha: str) -> dict:
    summary_path, runner_path = root / "summary.json", root / "p03-desktop-runner.json"
    s, runner = load(summary_path), load(runner_path)
    need(s.get("suite") == name and s.get("passed") is True and s.get("scenario_status") == "passed",
         f"actual {name} summary is not passed")
    need(s.get("execution_unchanged") is True and s.get("execution_bindings_before") == s.get("execution_bindings_after"),
         f"{name} execution inputs changed")
    need(s.get("real_credentials_used") is False and s.get("real_model_requests") in (False, 0)
         and s.get("external_model_requests") == 0 and s.get("DSH_started") is False,
         f"{name} reports credentials, real model requests or DSH")
    need("loopback" in str(s.get("network_boundary", "")).casefold(), f"{name} lacks loopback mock boundary")
    cand = s.get("candidate", {})
    need(cand.get("descriptor_sha256") == dsha and os.path.normcase(cand.get("descriptor_path", "")) == os.path.normcase(str(descriptor)),
         f"{name} summary candidate descriptor differs")
    scenarios = s.get("scenarios")
    need(isinstance(scenarios, list) and len(scenarios) == 3, f"{name} must have three actual scenarios")
    ids = []
    for sc in scenarios:
        sid = sc.get("scenario_id")
        need(sid and sid not in ids and sc.get("passed") is True and sc.get("exit_code") == 0,
             f"{name} has a failed or repeated scenario")
        ids.append(sid)
        closure = sc.get("candidate_artifact_closure", {})
        for phase in ("before_scenario", "after_scenario"):
            c = closure.get(phase, {})
            need(c.get("passed") is True and c.get("descriptor_sha256") == dsha
                 and c.get("owned_files_verified") == len(desc.get("artifacts", [])),
                 f"{name}/{sid} {phase} candidate closure failed")
    closure = s.get("candidate_artifact_closure_after_suite", {})
    need(closure.get("passed") is True and closure.get("descriptor_sha256") == dsha
         and closure.get("owned_files_verified") == len(desc.get("artifacts", [])), f"{name} final closure failed")
    before, after = runner.get("inputsBefore"), runner.get("inputsAfter")
    need(runner.get("exitCode") == 0 and runner.get("unchanged") is True and isinstance(before, list)
         and before and before == after and runner.get("externalModelCalls") == 0,
         f"{name} composition runner changed inputs or reports failure/model calls")
    for row in before:
        check_hash(row, read(pathlib.Path(row["path"]), f"{name} runner input"), f"{name} runner input")
    run_ids = runner.get("scenariosFull" if name == "full" else "degradation")
    need(isinstance(run_ids, list) and len(run_ids) == 3 and set(run_ids) == set(ids), f"{name} runner scenario set differs")
    return {"summary": file_ref(summary_path), "runner": file_ref(runner_path), "scenarios": ids,
            "candidate_closure": closure, "execution_unchanged": True, "credentials_used": False,
            "real_model_requests": 0, "external_model_requests": 0, "DSH_started": False}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    for arg in ("worktree", "baseline", "candidate", "full", "degradation", "commands", "attempt"):
        ap.add_argument("--" + arg, required=True)
    a = ap.parse_args()
    need(a.attempt == ATTEMPT, f"--attempt must be {ATTEMPT}")
    need(re.fullmatch(r"[0-9a-f]{40}", a.baseline) is not None, "--baseline must be full Git SHA")
    wt = pathlib.Path(a.worktree).resolve(strict=True)
    candidate = pathlib.Path(a.candidate).resolve(strict=True)
    full_dir, deg_dir = pathlib.Path(a.full).resolve(strict=True), pathlib.Path(a.degradation).resolve(strict=True)
    commands = pathlib.Path(a.commands).resolve(strict=True)
    need(pathlib.Path(text_git(wt, "rev-parse", "--show-toplevel")).resolve() == wt, "--worktree must be a Git root")
    common = pathlib.Path(text_git(wt, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
    need(common.name.casefold() == ".git", f"unexpected common Git directory: {common}")
    main_root = common.parent
    need((main_root / "AGENTS.md").is_file() and (main_root / "planning/Xiadie_V2_v1.1").is_dir(), "not the Xiadie repository")
    need(os.path.normcase(str(main_root)) != os.path.normcase(str(wt)), "U10 must use an isolated worktree")
    need(text_git(main_root, "rev-parse", "HEAD") == a.baseline, "main HEAD differs from --baseline")
    need(not text_git(main_root, "status", "--porcelain=v1", "--untracked-files=all"), "main checkout is not clean")
    head = text_git(wt, "rev-parse", "HEAD")

    status = load(main_root / "evidence/P03/status.json")
    tasks = {r.get("id"): r for r in status.get("tasks", [])}
    accepted = [accepted_unit(tasks, main_root, f"P03-U{i:02d}") for i in range(1, 10)]
    u10 = tasks.get("P03-U10", {})
    need(u10.get("status") == "running" and "P03-U09" in u10.get("dependencies", [])
         and tasks["P03-U09"].get("status") == "accepted", "U10 running/U09 accepted dependency gate failed")
    need(status.get("G03") == "pending" and status.get("current_task") == "P03-U10", "G03/current-task gate failed")

    out_evidence = under(wt, EVIDENCE)
    out_release = under(wt, RELEASE)
    need(not out_release.exists(), "docs/releases/0.3.0 already exists")
    need(out_evidence.is_dir(), "root archive helper must create the U10 evidence directory first")
    need(not (out_evidence / "commands").exists(), "commands output already exists")
    for item in out_evidence.rglob("*"):
        if item.is_dir():
            continue
        name = item.relative_to(out_evidence).as_posix()
        need(not item.is_symlink() and (name in {"baseline.json", "candidate-proof-index.json", "stage-input-audit.json", "scope-amendment.json", "scope-amendment-02.json"}
             or name.startswith(("candidate-proof/", "preserved-attempts/"))), f"unexpected pre-existing evidence: {name}")
    proof_index_path, stage_path = out_evidence / "candidate-proof-index.json", out_evidence / "stage-input-audit.json"
    proof_index, stage = load(proof_index_path), load(stage_path)
    amendment_path = out_evidence / "scope-amendment-02.json"
    amendment = load(amendment_path)
    need(amendment.get("added_scopes") == list(CORRECTION_INPUTS) and amendment.get("baseline_commit") == a.baseline,
         "qualification scope amendment differs from the declared correction")
    for row in amendment.get("preserved_artifacts", []):
        check_hash(row, read(under(wt, row["path"])), "preserved failed-run artifact")
    failed_commands = amendment.get("preserved_failed_commands", [])
    need(len(failed_commands) == 2, "both actual failed degradation attempts must be retained")
    for failed_command in failed_commands:
        need(load(pathlib.Path(failed_command["path"])).get("exit_code") == 1, "actual degradation failure was not preserved")
        check_hash(failed_command, read(pathlib.Path(failed_command["path"])), "preserved failed command")

    desc_path = candidate / "candidate-descriptor.json"
    desc_raw, desc = read(desc_path, "candidate descriptor"), load(desc_path)
    dsha = digest(desc_raw)
    need(desc.get("sourceCommit") == NATIVE, "candidate sourceCommit is not pinned Native 29628c9")
    need(os.path.normcase(desc.get("assemblyRoot", "")) == os.path.normcase(str(candidate)), "candidate assemblyRoot differs")
    material = desc.get("repositoryCommit", "")
    need(re.fullmatch(r"[0-9a-f]{40}", material) is not None, "candidate repositoryCommit is not full SHA")
    git(wt, "cat-file", "-e", material + "^{commit}")
    for commit, label in ((head, "worktree"), (material, "candidate material")):
        changed = text_git(main_root, "diff", "--name-only", "--no-renames", a.baseline, commit).splitlines()
        need(all(allowed(p) for p in changed), f"{label} changes outside U10 docs/evidence: {changed[:8]}")
    local = sum((text_git(wt, *cmd).splitlines() for cmd in (
        ("diff", "--name-only", "HEAD"), ("diff", "--cached", "--name-only", "HEAD"),
        ("ls-files", "--others", "--exclude-standard"))), [])
    need(all(allowed(p) for p in local), f"U10 worktree contains out-of-scope changes: {local[:8]}")

    groups, inputs = candidate_inputs(desc.get("repositoryInputs", []), wt, head)
    template_path = "templates/project-note.md"
    template_raw = read(under(wt, template_path), "tracked prompt template")
    need(template_raw == git(wt, "show", f"{head}:{template_path}"), "tracked prompt template differs from Git blob")
    template_ref = {"path": template_path, "bytes": len(template_raw), "sha256": digest(template_raw)}
    prompt_files = groups["prompt"]["files"]
    if not any(row["path"] == template_path for row in prompt_files):
        prompt_files.append(template_ref)
        prompt_files.sort(key=lambda x: x["path"].casefold())
        raw = json.dumps(prompt_files, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        groups["prompt"] = {"count": len(prompt_files), "bindings_sha256": digest(raw), "files": prompt_files}

    plan_rows = stage.get("plan_files")
    need(isinstance(plan_rows, list) and len(plan_rows) == PLAN_COUNT and stage.get("plan_mismatches") == [],
         "stage audit must verify all 423 plan files without mismatches")
    for row in plan_rows:
        p = rel(row.get("path", "")); name = p.as_posix()
        need(name.startswith("planning/Xiadie_V2_v1.1/"), f"plan file outside v1.1: {name}")
        raw = read(under(main_root, name), "authoritative plan")
        check_hash(row, raw, f"plan {name}")
        need(raw == read(under(wt, name), "U10 plan file"), f"plan file changed in U10: {name}")

    idx = proof_index
    need(idx.get("schema") == "p03-candidate-proof-archive/v1" and os.path.normcase(idx.get("candidate", "")) == os.path.normcase(str(candidate)),
         "candidate proof index schema/root differs")
    archived = {}
    for row in idx.get("artifacts", []):
        name = rel(row.get("path", "")).as_posix()
        raw = read(under(out_evidence, name), f"archived candidate proof {name}")
        check_hash(row, raw, f"archived proof {name}")
        need(name not in archived, f"duplicate archived proof path: {name}")
        archived[name] = raw
    full, degradation = suite("full", full_dir, desc_path, desc, dsha), suite("degradation", deg_dir, desc_path, desc, dsha)
    need(os.path.normcase(str(full_dir)) != os.path.normcase(str(deg_dir)), "full/degradation outputs must be separate")
    required_proof = {
        "candidate-proof/candidate-descriptor.json": desc_raw,
        "candidate-proof/runs/full/summary.json": read(full_dir / "summary.json"),
        "candidate-proof/runs/full/p03-desktop-runner.json": read(full_dir / "p03-desktop-runner.json"),
        "candidate-proof/runs/degradation/summary.json": read(deg_dir / "summary.json"),
        "candidate-proof/runs/degradation/p03-desktop-runner.json": read(deg_dir / "p03-desktop-runner.json"),
    }
    need(all(archived.get(k) == v for k, v in required_proof.items()), "candidate archive omits or differs from current run proof")

    native_root = pathlib.Path(desc["sourceRoot"]).resolve(strict=True)
    need(text_git(native_root, "rev-parse", "HEAD") == NATIVE, "Native source checkout differs from pinned commit")
    need(not text_git(native_root, "status", "--porcelain"), "Native source checkout is not clean")
    sqlite_src = "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts"
    sqlite_src_raw = read(native_root / sqlite_src, "Native SQLite source")
    need(sqlite_src_raw == git(native_root, "show", f"{NATIVE}:{sqlite_src}") and b'from "node:sqlite"' in sqlite_src_raw,
         "Native node:sqlite source differs from pinned Git blob")

    def artifact(name: str) -> dict:
        raw = read(candidate.joinpath(*rel(name).parts), f"candidate artifact {name}")
        row = next((x for x in desc.get("artifacts", []) if x.get("path") == name), None)
        need(isinstance(row, dict), f"candidate descriptor omits {name}")
        check_hash(row, raw, f"candidate artifact {name}")
        return {"path": name, "bytes": len(raw), "sha256": digest(raw)}

    native_license_raw = read(native_root / "LICENSE", "Native LICENSE")
    native_license = artifact("UPSTREAM-LICENSE")
    need(native_license_raw == read(candidate / "UPSTREAM-LICENSE"), "Native LICENSE copy is not byte-identical")
    notice = desc["upstreamNotice"]
    notice_src = pathlib.Path(notice["source"]["path"])
    notice_copy = candidate.joinpath(*rel(notice["copy"]["path"]).parts)
    notice_src_raw, notice_raw = read(notice_src, "Native NOTICE"), read(notice_copy, "candidate NOTICE")
    check_hash(notice["source"], notice_src_raw, "Native NOTICE source")
    check_hash(notice["copy"], notice_raw, "candidate NOTICE copy")
    need(notice_src_raw == notice_raw, "Native NOTICE copy is not byte-identical")
    cli_notice_path = "apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md"
    cli_notice_source = read(native_root / cli_notice_path, "Native CLI third-party notices")
    cli_notice = artifact(cli_notice_path)
    need(cli_notice_source == read(candidate.joinpath(*rel(cli_notice_path).parts)), "CLI third-party notices differ from Native")

    sq = desc["sqliteRuntime"]
    need(sq.get("packageVersion") == "13.0.3" and sq.get("sqliteVersion") == "3.53.4", "SQLite runtime version differs")
    pkg_path = candidate.joinpath(*rel(sq["packageRoot"] + "/package.json").parts)
    pkg = load(pkg_path)
    need(pkg.get("version") == "13.0.3" and pkg.get("license") == "MIT", "owned SQLite package is not 13.0.3/MIT")
    addon, sqlite_license = artifact(sq["addonPath"]), artifact(sq["licensePath"])
    need(addon["sha256"] == sq.get("addonSha256") and sqlite_license["sha256"] == sq.get("licenseSha256"),
         "owned SQLite addon/license hashes differ from descriptor")

    electron = pathlib.Path(desc["electronPath"]).resolve(strict=True)
    electron_pkg = load(electron.parent.parent / "package.json")
    need(electron_pkg.get("version") == "41.0.3" and desc.get("nodeVersion") == "v24.14.0", "Desktop/tool Node version differs")
    node = pathlib.Path(desc["nodePath"]).resolve(strict=True)
    ts_pkg_path, ts_bin = wt / "node_modules/typescript/package.json", wt / "node_modules/typescript/bin/tsc"
    ts_pkg = load(ts_pkg_path)
    need(ts_pkg.get("version") == "6.0.2", "TypeScript compiler is not 6.0.2")
    toolchain = {
        "electron": {"version": "41.0.3", **file_ref(electron), "role": "actual Desktop host; candidate CLI uses Electron Node mode"},
        "node": {"version": "v24.14.0", **file_ref(node), "role": "fixed Node tools/build runtime"},
        "typescript": {"version": "6.0.2", "package": file_ref(ts_pkg_path), "compiler": file_ref(ts_bin)},
    }

    u09_acc = rel(tasks["P03-U09"]["acceptance"]["path"])
    need(u09_acc.parts[:2] == ("evidence", "P03-U09") and len(u09_acc.parts) >= 4, "unexpected U09 acceptance path")
    u09_attempt = pathlib.PurePosixPath(*u09_acc.parts[:3])
    u09_result_path = main_root.joinpath(*u09_attempt.parts, "result.json")
    u09_result = load(u09_result_path)
    need(u09_result.get("task") == "P03-U09" and u09_result.get("author_status") == "ready_for_review",
         "U09 result is not the author snapshot")
    u09_refs = {
        "acceptance": repo_ref(main_root, u09_acc.as_posix()),
        "result": repo_ref(main_root, (u09_attempt / "result.json").as_posix()),
        "candidate_proof_index": repo_ref(main_root, (u09_attempt / "candidate-proof-index.json").as_posix()),
        "coverage": repo_ref(main_root, "docs/evals/P03/coverage.md"),
    }
    prior = {r["task"]: r for r in accepted}
    migration = {k: repo_ref(main_root, prior[f"P03-{k}"]["acceptance"]["path"])
                 for k in ("U03", "U06")}
    source_manifest = repo_ref(main_root, "evidence/P03-U01/20261004-01/source-manifest.json")
    need(NATIVE in read(main_root / source_manifest["path"]).decode("utf-8", "replace"), "accepted U01 source manifest omits Native pin")

    cmd_payloads, cmd_rows, suite_commands = {}, [], {"full": 0, "degradation": 0}
    for src in sorted(commands.rglob("*.json")):
        need(not src.is_symlink(), f"symlink in command evidence: {src}")
        raw, record = read(src, "command output"), load(src)
        argv = record.get("argv")
        need(isinstance(argv, list) and argv and isinstance(record.get("cwd"), str) and isinstance(record.get("exit_code"), int),
             f"command record lacks argv/cwd/exit code: {src.name}")
        env = record.get("environment_overrides", {})
        need(not any(re.search(r"key|token|secret|credential|password", str(k), re.I) for k in env),
             f"command record exposes a credential environment variable: {src.name}")
        args_text = " ".join(map(str, argv))
        for kind in suite_commands:
            if re.search(rf"(?:--suite\s+{kind}\b|--suite={kind}\b)", args_text):
                if record["exit_code"] != 0:
                    need(kind == "degradation" and file_ref(src) in failed_commands,
                         f"unaccounted actual {kind} command failed: {src.name}")
                else:
                    expected_run = str(full_dir if kind == "full" else deg_dir)
                    def argv_value(flag):
                        try: return str(argv[argv.index(flag) + 1])
                        except (ValueError, IndexError): return ""
                    if (os.path.normcase(argv_value("--candidate")) == os.path.normcase(str(candidate)) and
                            os.path.normcase(argv_value("--output")) == os.path.normcase(expected_run)):
                        suite_commands[kind] += 1
        name = "commands/" + src.relative_to(commands).as_posix()
        need(name not in cmd_payloads, f"duplicate command output: {name}")
        cmd_payloads[name] = raw
        cmd_rows.append({"path": name, "bytes": len(raw), "sha256": digest(raw), "argv": argv,
                         "cwd": record["cwd"], "exit_code": record["exit_code"]})
    need(all(suite_commands.values()), "command records must include successful actual full and degradation runs")
    command_index = json.dumps({"schema": "p03-u10-command-index/v1", "commands": cmd_rows},
                               ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    evidence_rel = pathlib.PurePosixPath(EVIDENCE)
    command_ref = {"path": f"{EVIDENCE}/command-index.json", "bytes": len(command_index), "sha256": digest(command_index)}

    def md_ref(name: str, raw: bytes) -> dict:
        return {"path": name, "bytes": len(raw), "sha256": digest(raw)}

    proof_ref = file_ref(proof_index_path, f"{EVIDENCE}/candidate-proof-index.json")
    stage_ref = file_ref(stage_path, f"{EVIDENCE}/stage-input-audit.json")
    native_sqlite_ref = {"path": sqlite_src, "bytes": len(sqlite_src_raw), "sha256": digest(sqlite_src_raw)}
    license_refs = {
        "native_license": {"source": {"path": "LICENSE", "bytes": len(native_license_raw), "sha256": digest(native_license_raw)},
                           "copy": native_license, "byte_identical": True},
        "native_notice": {"source": {"path": str(notice_src), "bytes": len(notice_src_raw), "sha256": digest(notice_src_raw)},
                          "copy": {"path": notice["copy"]["path"], "bytes": len(notice_raw), "sha256": digest(notice_raw)},
                          "byte_identical": True},
        "native_cli_third_party_notices": {"source": {"path": cli_notice_path, "bytes": len(cli_notice_source), "sha256": digest(cli_notice_source)},
                                           "copy": cli_notice, "byte_identical": True},
        "owned_better_sqlite": {"package": "better-sqlite3", "version": "13.0.3", "license": "MIT",
                                "addon": addon, "license_file": sqlite_license},
    }
    limits = [
        "运行环境边界：实际 Desktop 使用 Electron 41.0.3；候选 CLI 运行于 Electron Node mode。构建及工具使用固定 Node 24.14.0、TypeScript 6.0.2。",
        "存储与分发边界：Native 使用 node:sqlite；Xiadie 自有 CLI 使用独立的 better-sqlite3 13.0.3 MIT addon。候选借用 junction，不能视为可移植安装包。",
        "隔离与未运行项：本轮只验证 mock loopback 模型流量；付费模型、DSH、已安装应用、人类视觉验收和 whole-OS sandbox 均为 NOT_RUN。",
        "M2 边界：已接受的 U03/U06 证据包含迁移 API 的实际验证，并由 U09 回归补充；迁移后 App 端到端验证为 NOT_RUN。",
        "事实与业务状态边界：project/experience notes 只作线索，不等同事实。没有独立业务 TaskLedger 实体证据证明 owner 或 progress；本轮项目记忆组合未启用 Native writer，也未建立第二个事实数据库。",
        "字节与语义边界：当前输入字节及 raw SHA-256 只能证明文件字节和运行前后状态一致，不能证明内容语义真实、获得许可，也不能证明真实模型遵循 facts priority、persona 或 memory policy。",
        "来源限制：原始角色素材及原始 prompt 的来源、provenance 和许可均为 NOT_VERIFIED。",
        "计划与许可边界：423 份 v1.1 计划文件只读核对。hash 标识精确字节，不代表许可或授权。",
        "日志与权限边界：父进程以独占创建和固定物理身份授权同一隔离场景的 CLI 追加，并在启动前后核对回执与日志身份；仅凭既有文件存在仍拒绝。固定 Node 日志测试为 11 pass/1 symlink EPERM skip；既有 U03/U07 symlink 权限未测也保留。这是测试日志组合，不是任意既有 profile 的恢复声明。",
    ]
    source_decision = (
        "# P03-U10 来源采用决定\n\n"
        f"采用固定提交 `{NATIVE}` 的 Native ZCode。实际 Native checkout、候选 descriptor 和 U01 source manifest 均在 `freeze.json` 中绑定。"
        "复用范围包括 memory context/prompt、project-memory adapter、event/store 集成及 Desktop CLI 路径。"
        "Native 存储实现使用 `node:sqlite`；Xiadie 自有 CLI 使用另一套 `better-sqlite3` 13.0.3，带独立 MIT license 和 addon。\n\n"
        "固定提交的源码位置：\n\n"
        + "\n".join(f"- https://github.com/zai-org/ZCode/blob/{NATIVE}/{p}" for p in (
            "apps/zcode-cli/packages/core/src/context/sections/memory.ts",
            "apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts",
            "apps/zcode-cli/packages/core/src/memory/index-content.ts",
            "packages/services/src/memory/memoryService.ts",
            "apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts"))
        + "\n\n`repositoryInputs` 分组沿用 0.2.0 freeze 的结构。`freeze.json` 按实际 tracked path 记录每项 bytes 与 raw SHA-256，分组允许重叠。"
        f"tracked project-note 模板另行绑定：`{template_ref['path']}`，{template_ref['bytes']} bytes，raw SHA-256 `{template_ref['sha256']}`。"
        "U10 full/degradation 命令记录按原始字节复制，并在 command index 中记录精确 SHA-256。\n\n"
        "许可证据逐字节绑定 Native LICENSE、NOTICE、CLI THIRD-PARTY-NOTICES 的来源文件和候选副本。原始角色素材与原始 prompt 的来源及许可仍为 NOT_VERIFIED。\n\n"
        "M2 依据已接受的 U03/U06 迁移 API 实际验证证据和 U09 回归；迁移后 App 端到端仍是 NOT_RUN。输入字节保持一致不等于内容为语义真相，也不能证明模型行为符合记忆策略。"
        "本轮项目记忆组合未启用 Native writer，也未建立第二个事实数据库。更多运行边界见 README，回退方式见 rollback。\n"
    )
    rollback = (
        "# P03-U10 回退\n\n"
        "如需回退，应针对独立的 U10 提交创建一个普通 `git revert` 提交，不重写共享历史。"
        "保留原 U10 提交、此前所有已接受记录、失败证据和候选 proof；不得删除或改写这些 evidence。"
        "本作者材料不改变 canonical acceptance。helper 不执行 remote、tag 或 release 操作；按 root gate 已准备的普通分支备份进行审查和回退。\n"
    )
    readme = (
        "# Xiadie 0.3.0 冻结候选\n\n"
        f"此文保留 P03-U10 attempt `{ATTEMPT}` 的作者冻结快照：`ready_for_review`、`accepted=false`，冻结时 G03 等待独立审查。当前验收结论见 [P03 状态](../../../evidence/P03/status.json) 和后续 canonical acceptance。\n\n"
        f"Native source 固定为 `{NATIVE}`。full 与 degradation 均以实际 summary 记录 3 个通过场景；执行输入、runner 输入及候选材料闭包保持不变，模型流量限于 mock loopback。"
        "proof archive index 绑定实际 summary、runner 和 candidate descriptor 的原始字节。两次离线失败分别揭示同进程 Host 重建和新任务启动另一 CLI 时的审计日志冲突；父进程固定日志物理身份后重新生成候选并实跑全套。原失败、路径映射变化与新增保护测试均保留，未放宽历史消息、离线请求或 ledger 断言。\n\n"
        "以下仅映射 P03 范围；各需求在其他阶段的工作仍须单独验收。\n\n"
        "| 条目 | 实现与实际证据 | 支持边界 |\n| --- | --- | --- |\n"
        "| G03-M1 不自然衰减 | accepted U08 三年旧笔记仍按当前 Git/raw hash 重验；U09 freshness 回归。 | byte-current 是字节引用有效性，不是语义真相。 |\n"
        "| G03-M2 迁移可追 | accepted U03/U06 实际 Git/SQLite、Native 路径映射、导出/导入、迁移/回滚与旧源 hash；U09 回归。 | 迁移后 App 端到端 NOT_RUN。 |\n"
        "| G03-M3 无双写权威 | registry 只存身份元数据；Native 原始笔记是内容源；实际 Read/拒读/取消恢复核对 fixture 字节和文件集。 | 未启用 Native writer；观测期间文件集不变不能证明所有瞬时或外部行为。 |\n"
        "| R03 先查、再试、最小实现 | accepted U01 来源比较/U02 隔离试验；U03–U08 实现；U09 独立回归；本次候选实跑与冻结。 | 许可、素材和真实模型语义不由源码 hash 证明。 |\n"
        "| R07 记忆与事实分工 | U03/U04/U05/U08 政策、Reader 与 freshness；U09 Native/Host 实际拒读。 | 经验仅作线索；业务 owner/progress 无证据时 unknown。 |\n"
        "| R08 scope 与最小 handoff | accepted U07 最小包/字节上限/项目隔离、U08 核验回执；U09 实际 Native 回归。 | mock 接收者不等于真实 DSH 交付或语义遵循。 |\n"
        "| R24 恢复与旧工程保护 | accepted U03/U06 不覆盖、rollback 与旧源保持；候选全套运行核对生产配置 hash/registry guard。 | 只读保护及 API 测试不等于 portable 安装器或物理故障恢复。 |\n\n"
        + "\n".join(f"- {x}" for x in limits)
        + "\n\n`freeze.json` 记录输入分组及 raw hash、工具身份、许可副本、命令 hash 和已接受证据引用。"
        "只有 canonical P03 status 与之后独立写入的 acceptance record 才能将 U10 标为 accepted。\n"
    )
    input_text = ", ".join(f"{k}: {v['count']}" for k, v in groups.items())
    result_md = (
        "# P03-U10 作者结果\n\n"
        "状态：`ready_for_review`；`accepted=false`；G03：`pending_independent_acceptance`。\n\n"
        f"基线：`{a.baseline}`。候选 Native source：`{NATIVE}`。材料提交：`{material}`。"
        f"candidate descriptor：{len(desc_raw)} bytes，raw SHA-256 `{dsha}`。repositoryInputs：{len(inputs)} 项；分组数量：{input_text}。\n\n"
        f"full 场景：{', '.join(full['scenarios'])}。degradation 场景：{', '.join(degradation['scenarios'])}。"
        "实际 summary 与 runner 已记录 hash，并由 candidate proof 原样归档；执行输入和 runner 输入保持不变。\n\n"
        + "\n".join(f"- {x}" for x in limits)
        + "\n\n是否 accepted 只由 canonical status 和之后独立生成的 acceptance record 决定。\n"
    )
    generation_raw = read(pathlib.Path(__file__), "generation script source")
    generation = {"path": f"{EVIDENCE}/generation-script.py", "bytes": len(generation_raw), "sha256": digest(generation_raw)}
    source_ref, rollback_ref = md_ref(f"{EVIDENCE}/source-decision.md", source_decision.encode()), md_ref(f"{EVIDENCE}/rollback.md", rollback.encode())
    readme_ref, result_md_ref = md_ref(f"{RELEASE}/README.md", readme.encode()), md_ref(f"{EVIDENCE}/result.md", result_md.encode())
    freeze = {
        "schema": "xiadie-local-freeze/v1", "product_version": "0.3.0", "plan_document_version": "1.1",
        "author_status": "ready_for_review", "accepted": False, "G03": "pending_independent_acceptance",
        "author_snapshot_boundary": "Canonical evidence/P03/status.json and a later independent U10 acceptance record establish acceptance.",
        "attempt": ATTEMPT, "baseline_commit": a.baseline, "build_repository_commit": material, "source_commit": NATIVE,
        "candidate_root": str(candidate), "descriptor": {"path": str(desc_path), "bytes": len(desc_raw), "sha256": dsha},
        "artifact_count": len(desc.get("artifacts", [])), "repository_input_count": len(inputs), "input_groups": groups,
        "group_boundary": "P02 freeze layout by actual tracked path; groups may overlap. Tracked prompt template is bound even if outside candidate repositoryInputs. SHA-256 identifies bytes, not permission.",
        "tracked_prompt_template": template_ref, "proof_archive_index": proof_ref,
        "qualification_scope_amendment": file_ref(amendment_path, f"{EVIDENCE}/scope-amendment-02.json"),
        "preserved_failed_commands": failed_commands,
        "actual_suites": {"full": full, "degradation": degradation}, "accepted_prior_units": accepted,
        "P03-U09": u09_refs, "M2_migration_evidence": migration, "source_lock": repo_ref(main_root, "docs/sources.lock.json"),
        "plan_read_only": {"files_verified": len(plan_rows), "required_count": PLAN_COUNT, "mismatches": 0, "audit": stage_ref},
        "native_node_sqlite": native_sqlite_ref, "licenses": license_refs, "toolchain": toolchain,
        "sqlite_runtime": {"package": "better-sqlite3", "version": "13.0.3", "sqlite_version": "3.53.4",
                           "package_root": sq["packageRoot"], "addon": addon, "license": sqlite_license,
                           "ownership": "Xiadie-owned CLI package; Native root implementation remains node:sqlite."},
        "limitations": limits, "candidate_junction": "Borrowed machine-local junction; not a portable installer.",
        "release_0_2_preserved": {"README": repo_ref(main_root, "docs/releases/0.2.0/README.md"),
                                  "freeze": repo_ref(main_root, "docs/releases/0.2.0/freeze.json")},
        "README": readme_ref, "author_result": result_md_ref, "source_decision": source_ref,
        "rollback": rollback_ref, "command_index": command_ref, "generation_script": generation,
        "rollback_boundary": f"Only isolated {RELEASE}/, {EVIDENCE}/ and the exact five qualification correction paths are in scope; accepted history remains intact.",
    }
    freeze_raw = json.dumps(freeze, ensure_ascii=False, indent=2).encode() + b"\n"
    freeze_ref = {"path": f"{RELEASE}/freeze.json", "bytes": len(freeze_raw), "sha256": digest(freeze_raw)}
    result = {
        "schema": "p03-u10-author-freeze/v1", "task": "P03-U10", "attempt": ATTEMPT,
        "author_status": "ready_for_review", "accepted": False, "G03": "pending_independent_acceptance",
        "canonical_acceptance_boundary": "Only canonical P03 status plus later independent acceptance establishes acceptance.",
        "baseline_commit": a.baseline, "worktree_head_at_generation": head, "material_commit": material,
        "source_commit": NATIVE, "candidate": freeze["descriptor"], "actual_suites": freeze["actual_suites"],
        "accepted_prior_units": accepted, "M2_migration_evidence": migration, "plan_read_only": freeze["plan_read_only"],
        "qualification_scope_amendment": freeze["qualification_scope_amendment"], "preserved_failed_commands": failed_commands,
        "toolchain": toolchain, "licenses": license_refs, "limitations": limits,
        "source_decision": source_ref, "rollback": rollback_ref, "command_index": command_ref,
        "generation_script": generation, "freeze": freeze_ref,
    }
    result_raw = json.dumps(result, ensure_ascii=False, indent=2).encode() + b"\n"
    planned = {
        f"{RELEASE}/README.md": readme.encode(), f"{RELEASE}/freeze.json": freeze_raw,
        f"{EVIDENCE}/result.md": result_md.encode(), f"{EVIDENCE}/result.json": result_raw,
        f"{EVIDENCE}/source-decision.md": source_decision.encode(), f"{EVIDENCE}/rollback.md": rollback.encode(),
        f"{EVIDENCE}/command-index.json": command_index,
        f"{EVIDENCE}/generation-script.py": generation_raw,
    }
    planned.update({f"{EVIDENCE}/{name}": raw for name, raw in cmd_payloads.items()})
    for name in planned:
        need(allowed(name), f"output escaped U10 scope: {name}")
        need(not under(wt, name).exists(), f"refusing to overwrite: {name}")
    for name, raw in planned.items():
        path = under(wt, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as f:
            f.write(raw)
    print(json.dumps({"author_status": "ready_for_review", "accepted": False,
                      "G03": "pending_independent_acceptance", "created": [
                          {"path": n, "bytes": len(b), "sha256": digest(b)} for n, b in sorted(planned.items())]},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"U10 freeze generation refused: {exc}", file=sys.stderr)
        raise
