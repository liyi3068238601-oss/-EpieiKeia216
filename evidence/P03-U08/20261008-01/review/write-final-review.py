import datetime, hashlib, json, pathlib

root = pathlib.Path("E:/Xiadie/Xiadie").resolve()
worktree = root / ".runtime/P03/worktrees/u08"
review_dir = root / ".runtime/P03/reviews/u08-20261008"
attempt = worktree / "evidence/P03-U08/20261008-01"
report_path = review_dir / "unit-review-final.json"
assert not report_path.exists()

manifest_path = attempt / "manifest.json"
manifest_raw = manifest_path.read_bytes()
manifest = json.loads(manifest_raw)
assert hashlib.sha256(manifest_raw).hexdigest() == "7f7cac56bb32f5746730bd458c20c6bc3629590cea608dae6dc4f66d0841fa07"
assert manifest["baseline_commit"] == "5831ba60285536aaa9b8ef40770510f380cb6edf"
assert len(manifest["files"]) == 18

def record(base_name, base, relative, expected_bytes=None, expected_sha=None):
    file = (base / relative).resolve(strict=True)
    assert file.is_relative_to(base)
    data = file.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if expected_bytes is not None:
        assert len(data) == expected_bytes, str(file)
    if expected_sha is not None:
        assert digest == expected_sha, str(file)
    return {"root": base_name, "path": file.relative_to(base).as_posix(),
            "bytes": len(data), "sha256": digest}

immutable_by_key = {}
def add_input(base_name, base, relative, expected_bytes=None, expected_sha=None):
    item = record(base_name, base, relative, expected_bytes, expected_sha)
    immutable_by_key[(base_name, item["path"])] = item

for item in manifest["files"]:
    add_input("author_worktree", worktree, item["path"], item["bytes"], item["sha256"])
add_input("author_worktree", worktree, "evidence/P03-U08/20261008-01/manifest.json",
          len(manifest_raw), hashlib.sha256(manifest_raw).hexdigest())

execution = json.loads((review_dir / "execution-inputs-readback.json").read_bytes())
assert execution["before_count"] == execution["after_count"] == execution["current_files_checked"] == 173
assert execution["tuple_sets_identical"] and execution["mismatches"] == []
for item in execution["bindings"]:
    add_input(item["root"], worktree if item["root"] == "author_worktree" else root, item["path"],
              item["actual_bytes"], item["actual_sha256"])

adoption_check = json.loads((review_dir / "adoption-inputs-readback.json").read_bytes())
assert adoption_check["mismatches"] == []
for item in adoption_check["inputs"]:
    add_input(item["root"], worktree if item["root"] == "author_worktree" else root, item["path"],
              item["bytes"], item["sha256"])

for relative in (
    "AGENTS.md",
    "evidence/P03/status.json",
    "evidence/P03-U02/20261008-01/acceptance.json",
    "evidence/P03-U02/20261008-01/manifest.json",
    "tools/run-tests.mjs",
    ".runtime/P03/coord/run-command.py",
    ".runtime/P03/coord/verify-author.py",
    ".runtime/P03/coord/verify-review.py",
    ".runtime/P03/coord/read-native-accepted.py",
):
    add_input("baseline_repository", root, relative)
native_readback = json.loads((review_dir / "native-readback.json").read_bytes())
assert native_readback["commit"] == "29628c9acdb81b703bbd4080c207a0e7ce5e276e"
assert native_readback["clean"] and native_readback["mismatches"] == []
assert native_readback["source_inputs"] == 1181 and native_readback["compiled_outputs"] == 1163
for item in native_readback["accepted_records"]:
    add_input("baseline_repository", root, item["path"], item["bytes"], item["sha256"])

for relative in (
    "verify-execution-bindings.py",
    "verify-adoption-inputs.py",
    "write-final-review.py",
):
    add_input("review_directory", review_dir, relative)

immutable_inputs = sorted(immutable_by_key.values(), key=lambda item: (item["root"], item["path"]))
assert {item["root"] for item in immutable_inputs} == {
    "author_worktree", "baseline_repository", "review_directory"
}

artifacts = []
for file in sorted(review_dir.rglob("*")):
    if not file.is_file() or file.resolve() == report_path.resolve():
        continue
    data = file.read_bytes()
    artifacts.append({
        "root": "review_directory",
        "path": file.relative_to(review_dir).as_posix(),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    })

def command_record(name):
    return json.loads((review_dir / "commands" / name).read_bytes())

build = command_record("fresh-build-command.json")
unit = command_record("u08-selector-command.json")
regression = command_record("u03-u07-regression-command.json")
diff = command_record("diff-check-command.json")
verify_before = json.loads((review_dir / "author-verify-before.json").read_bytes())
verify_after = json.loads((review_dir / "author-verify-after.json").read_bytes())
typescript = command_record("typescript-version-command.json")
native_command = command_record("native-readback-command.json")

assert build["exit_code"] == 0 and "Version 6.0.2" in typescript["stdout"] and typescript["exit_code"] == 0
assert unit["exit_code"] == 0 and "ℹ tests 9" in unit["stdout"] and "ℹ pass 9" in unit["stdout"]
assert "ℹ fail 0" in unit["stdout"] and "ℹ skipped 0" in unit["stdout"]
assert regression["exit_code"] == 0 and diff["exit_code"] == 0 and native_command["exit_code"] == 0
assert verify_before["worktree_clean"] and verify_after["worktree_clean"]
assert verify_before["manifest"]["sha256"] == verify_after["manifest"]["sha256"] == "7f7cac56bb32f5746730bd458c20c6bc3629590cea608dae6dc4f66d0841fa07"

review = {
    "schema": "p03-independent-review/v1",
    "created_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "task": "P03-U08",
    "decision": "pass",
    "unit_acceptance": "not_decided",
    "reviewer": "Codex independent reviewer (/root/p03_u08_static_review)",
    "scope": "Independent exact-author-commit review of U08 freshness observation and append-only revision API, its actual Node selector, and U03/U07 regressions. Does not imply coordinator unit acceptance, U09/U10 integration, or model behavior.",
    "review_target": {
        "author_commit": "035bb11b423f6e06da6cefc595ac1c936a548ca6",
        "baseline_commit": "5831ba60285536aaa9b8ef40770510f380cb6edf",
        "author_worktree": str(worktree),
        "attempt": "20261008-01; exact manifest-bound commit",
        "changed_paths": 19,
        "manifest_files": 18,
        "manifest_sha256": "7f7cac56bb32f5746730bd458c20c6bc3629590cea608dae6dc4f66d0841fa07",
    },
    "checks": [
        {
            "id": "exact-author-manifest-and-clean-worktrees",
            "status": "pass",
            "detail": "Independent verify-author runs before and after execution each confirmed the clean author worktree at 035bb11b423f6e06da6cefc595ac1c936a548ca6, 18 bound files covering all 19 changed paths, manifest SHA-256 7f7cac56bb32f5746730bd458c20c6bc3629590cea608dae6dc4f66d0841fa07, and zero disk/Git blob mismatches. The main checkout stayed clean at baseline 5831ba60285536aaa9b8ef40770510f380cb6edf.",
        },
        {
            "id": "accepted-prerequisites-source-adoption-and-license",
            "status": "pass",
            "detail": "U03, U04, U06 and U07 remain accepted in the P03 ledger; their cited acceptance records, the U07 review-final artifact, all eight source-adoption refs, the U02 Native accepted records, and the pinned Native LICENSE were independently re-read and raw-hash checked. The native source is pinned at 29628c9acdb81b703bbd4080c207a0e7ce5e276e under Apache-2.0. U08 adopts contracts and observations without copying Native implementation code.",
        },
        {
            "id": "fresh-build-fixed-toolchain",
            "status": "pass",
            "detail": "A fresh TypeScript build under the pinned Node v24.14.0 exited 0. The same compiler reports TypeScript 6.0.2.",
            "command_record": "commands/fresh-build-command.json",
        },
        {
            "id": "official-u08-selector",
            "status": "pass",
            "detail": "The official selector node tools/run-tests.mjs unit P03-U08 exited 0: 9 inner cases passed, 0 failed/skipped, plus one outer test-file completion. The actual Windows ACL denial and exact DACL restoration, hardlink/junction cases, source mutation cases, mapping relocation, history integrity and Host callback cases ran.",
            "command_record": "commands/u08-selector-command.json",
        },
        {
            "id": "related-u03-u07-regression",
            "status": "pass",
            "detail": "The official U03/U07 selector exited 0. U03 registry reported 14 passed and one Windows symbolic-directory-link skip after EPERM; U07 reported 8 passed. The outer runner reported two test-file completions. These streams are reported separately and not summed.",
            "command_record": "commands/u03-u07-regression-command.json",
        },
        {
            "id": "freshness-and-unknown-contract",
            "status": "pass",
            "detail": "Static review and tests confirm current Git HEAD plus selected raw-byte hashes determine current versus needs_recheck; age alone does not decay matching knowledge. Missing, unreadable, unsafe, incomplete, untrusted or changed ref sets remain unknown. Snapshot and change classification do not infer owner/progress or semantic truth.",
        },
        {
            "id": "host-attestation-history-and-replay-boundary",
            "status": "pass",
            "detail": "The API binds a live module-branded observation, exact proposal and complete canonical history-prefix digest to Host acceptance. It re-observes mapping/HEAD/refs before and after the callback and before append; module-issued receipts are one-use, prior revisions are structurally validated, metadata is deep-cloned/frozen, and supersession retains old history. The Host must actually execute verification and atomically persist via cross-process CAS; this module checks its attestation and returns an append result.",
        },
        {
            "id": "path-scope-and-no-production-writer",
            "status": "pass",
            "detail": "The observer uses literal normalized relative paths, rejects path traversal, Windows aliases and reparse/hardlink targets, and applies the documented private/runtime path exclusions. Evidence paths must be approved by the trusted Host; these lexical exclusions are not a general secret classifier or OS sandbox. The implementation has no Native note writer, formal-note persistence, extra database, model call or generic shell execution engine.",
        },
        {
            "id": "pinned-native-accepted-readback",
            "status": "pass",
            "detail": "Independent readback matched all 1,181 accepted U02 Native source inputs and 1,163 compiled outputs at the pinned clean commit, with zero mismatches. No Native rebuild, application, model or Desktop run occurred.",
            "record": "native-readback.json",
        },
        {
            "id": "execution-inputs-and-post-run-integrity",
            "status": "pass",
            "detail": "The author before/after execution binding tuples were identical. All 173 currently bound files were rehashed: 163 under the author worktree and 10 under the baseline repository, with zero mismatches. git diff --check exited 0; the post-run manifest readback remained clean.",
            "record": "execution-inputs-readback.json",
        },
    ],
    "reviewer_readback": {
        "author_manifest_before": {
            "record": "author-verify-before.json", "command_record": "commands/author-verify-before-command.json",
            "bound_files": verify_before["files"], "changed_paths": verify_before["changed_paths"],
            "mismatches": len(verify_before["disk_and_git_mismatches"]), "manifest_sha256": verify_before["manifest"]["sha256"],
        },
        "author_manifest_after": {
            "record": "author-verify-after.json", "command_record": "commands/author-verify-after-command.json",
            "bound_files": verify_after["files"], "changed_paths": verify_after["changed_paths"],
            "mismatches": len(verify_after["disk_and_git_mismatches"]), "manifest_sha256": verify_after["manifest"]["sha256"],
        },
        "fresh_build": {
            "command_record": "commands/fresh-build-command.json", "exit_code": build["exit_code"],
            "node": "v24.14.0", "typescript": "6.0.2",
        },
        "official_selector": {
            "command_record": "commands/u08-selector-command.json", "selector": "unit P03-U08",
            "exit_code": unit["exit_code"], "inner_cases_passed": 9, "failed": 0, "skipped": 0,
            "outer_file_completions": 1,
        },
        "related_regression": {
            "command_record": "commands/u03-u07-regression-command.json", "exit_code": regression["exit_code"],
            "u03_registry": {"passed": 14, "failed": 0, "skipped": 1, "skip_reason": "Windows symbolic-directory-link creation returned EPERM"},
            "u07_handoff": {"passed": 8, "failed": 0, "skipped": 0},
            "outer_file_completions": 2,
            "note": "Counts from nested test files are not combined with outer completions.",
        },
        "diff_check": {"command_record": "commands/diff-check-command.json", "exit_code": diff["exit_code"]},
        "main_checkout": {
            "head_command": "commands/main-head-command.json",
            "status_command": "commands/main-status-command.json",
            "head": "5831ba60285536aaa9b8ef40770510f380cb6edf",
            "clean": True,
        },
        "pinned_native_readback": {
            "command_record": "commands/native-readback-command.json", "record": "native-readback.json",
            "commit": native_readback["commit"], "clean": native_readback["clean"],
            "source_inputs": native_readback["source_inputs"], "compiled_outputs": native_readback["compiled_outputs"],
            "mismatches": len(native_readback["mismatches"]),
        },
        "execution_input_stability": {
            "command_record": "commands/execution-inputs-command-02.json", "record": "execution-inputs-readback.json",
            "before_count": execution["before_count"], "after_count": execution["after_count"],
            "pair_digests_equal": execution["tuple_sets_identical"], "current_files_checked": execution["current_files_checked"],
            "mismatches": len(execution["mismatches"]), "counts_by_root": execution["counts_by_root"],
            "boundary": execution["boundary"],
        },
        "adoption_input_readback": {
            "command_record": "commands/adoption-inputs-command-02.json", "record": "adoption-inputs-readback.json",
            "checked_count": adoption_check["checked_count"], "mismatches": len(adoption_check["mismatches"]),
            "accepted_prior_units": adoption_check["accepted_prior_statuses"],
            "native_license": adoption_check["native_license"],
        },
    },
    "preserved_failures": [
        {
            "record": "author_worktree:evidence/P03-U08/20261008-01/build-02.json",
            "detail": "An intermediate author build reported TS7006; the failure remains manifest-bound and build-03 plus the independent fresh build pass.",
        },
        {
            "record": "review_directory:commands/execution-inputs-command.json",
            "detail": "The first reviewer readback attempt could not find its helper at the expected path; no product command ran. The helper was placed inside the authorized review directory and execution-inputs-command-02 verified all 173 files.",
        },
        {
            "record": "review_directory:commands/adoption-inputs-command.json",
            "detail": "The first reviewer adoption-check helper assumed an author_commit field absent from the source-adoption shape; it was corrected to bind accepted status, acceptance path and integration commit. adoption-inputs-command-02 passed all checks.",
        },
    ],
    "limitations": [
        "Freshness reports raw Git and byte-reference matches, not semantic truth. Historical serialized snapshots remain experience leads.",
        "A callback result alone does not prove that a Host executed the command. The production trusted Host must execute verification and atomically persist the complete-history compare-and-swap; this unit contains no persistence writer.",
        "The trusted Host must approve evidence paths. The path rules reject documented private/runtime classes but do not classify arbitrary secret content or create an OS sandbox.",
        "No Native createZCodeApp composition, production formal-note write, provider/model invocation, live DSH or Desktop was run. Those boundaries remain outside U08 and for later integration.",
        "The related U03 regression could not create its synthetic symbolic directory link because the Windows host returned EPERM. U08's actual junction, hardlink and ACL branches ran.",
        "The Native accepted readback covers the declared 1,181 source and 1,163 compiled inputs, not the full installed dependency closure.",
    ],
    "artifacts": artifacts,
    "immutable_inputs": immutable_inputs,
    "boundary": "Independent review pass only. Coordinator unit acceptance remains not_decided; no U09/U10 integration, Native application or model claim is made.",
}
report_path.write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({
    "path": str(report_path),
    "artifacts": len(artifacts),
    "immutable_inputs": len(immutable_inputs),
    "review_bytes": report_path.stat().st_size,
    "review_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
}))
