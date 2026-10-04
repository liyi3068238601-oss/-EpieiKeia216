"""Synthetic tests for P02 main-process side-effect evidence and CLI alias binding."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parent
DESKTOP_RUNNER = HERE / "desktop.py"
namespace = {"__file__": str(DESKTOP_RUNNER), "__name__": "p02_desktop_test"}
exec(compile(DESKTOP_RUNNER.read_bytes(), str(DESKTOP_RUNNER), "exec"), namespace)
desktop = namespace


class LinkVerifier:
    @staticmethod
    def linked(path: Path) -> bool:
        return path.is_symlink() or path.is_junction()


class DesktopSideEffectGuardTests:
    def __init__(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp(prefix="p02-registry-evidence-")).resolve(strict=True)

    def close(self) -> None:
        temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
        relative = self.temp_root.relative_to(temp_root)
        if (not self.temp_root.is_absolute() or self.temp_root.is_symlink() or
                self.temp_root.is_junction() or not relative.parts or
                not self.temp_root.name.startswith("p02-registry-evidence-")):
            raise RuntimeError("owned registry evidence temp root failed deletion checks")
        shutil.rmtree(self.temp_root)

    def _profile_and_candidate(self, root: Path) -> tuple[Path, dict, dict, dict]:
        run_root = root / "run"
        profile = run_root / "profile"
        cwd = profile / "process-working-directory"
        profile.mkdir(parents=True)
        cwd.mkdir()
        (run_root / "desktop-main.pid").write_text("4126\n", encoding="utf-8")
        (run_root / "desktop-ui.spec.json").write_text(
            json.dumps({"process_working_directory": str(cwd)}), encoding="utf-8")

        argv = [sys.executable, "--inspect=0", str(root / "candidate" / "packages/desktop/dist/main.js")]
        snapshot = {
            "schemaVersion": 1,
            "pid": 51964,
            "processType": "browser",
            "cwd": str(cwd),
            "execPath": sys.executable,
            "defaultApp": True,
            "argv": argv,
            "argvSha256": hashlib.sha256(json.dumps(argv, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
            "argvEntry": argv[1],
            "resolvedArgvEntry": str((cwd / argv[1]).resolve()),
        }
        (profile / "main-process-runtime.json").write_text(json.dumps(snapshot), encoding="utf-8")
        scenario_result = {
            "actual_ui": {"desktop": {"main_pid": 51964}},
            "network_guard": {"main": {"pid": 51964}},
            "process_evidence": {"root_pid": 51964},
        }
        return profile, {"resolved_paths": {"electronPath": sys.executable}}, snapshot, scenario_result

    def _records(self, profile: Path, candidate: dict, snapshot: dict, groups: int = 3) -> list[dict]:
        cwd = snapshot["cwd"]
        protocol_args = ["zcode", sys.executable, [snapshot["resolvedArgvEntry"]]]
        records = []

        def make_record(kind: str, **fields: object) -> dict:
            return {"schemaVersion": 1, "kind": kind, "pid": snapshot["pid"], "processType": "browser",
                    "cwd": cwd, **fields}

        for group_index in range(groups):
            label = "在ZCode中打开" if group_index % 2 == 0 else "Open in ZCode"
            command = f'"{sys.executable}" "{snapshot["resolvedArgvEntry"]}" --open-workspace "%1"'
            for position, key in enumerate(desktop["REGISTRY_GUARD_KEY_SEQUENCE"]):
                if position in {0, 4}:
                    args = ["add", key, "/ve", "/d", label, "/f"]
                elif position in {1, 5}:
                    args = ["add", key, "/v", "MUIVerb", "/t", "REG_SZ", "/d", label, "/f"]
                elif position in {2, 6}:
                    args = ["add", key, "/v", "Icon", "/t", "REG_SZ", "/d", sys.executable, "/f"]
                else:
                    args = ["add", key, "/ve", "/d", command, "/f"]
                raw_argv = [r"C:\Windows\System32\reg.exe", *args]
                records.append(make_record("blocked_reg_exe", rawArgv=raw_argv,
                                           rawArgvSha256=hashlib.sha256(json.dumps(
                                               raw_argv, ensure_ascii=False, separators=(",", ":")
                                           ).encode()).hexdigest()))

        records.append(make_record(
            "blocked_default_protocol_registration",
            code="P02_DEFAULT_PROTOCOL_REGISTRATION_BLOCKED",
            method="app.setAsDefaultProtocolClient",
            defaultApp=snapshot["defaultApp"],
            rawArgs=protocol_args,
            rawArgsSha256=hashlib.sha256(json.dumps(protocol_args, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
            expectedRegistrySubkeys=desktop["EXPECTED_PROTOCOL_GUARD_SUBKEYS"],
            returnValue=False,
            returnType="boolean",
            blocked=True,
        ))
        records.append(make_record(
            "blocked_clear_recent_documents",
            code="P02_CLEAR_RECENT_DOCUMENTS_BLOCKED",
            method="app.clearRecentDocuments",
            defaultApp=snapshot["defaultApp"],
            rawArgs=[],
            rawArgsSha256=hashlib.sha256(b"[]").hexdigest(),
            returnValue=None,
            returnType="undefined",
            blocked=True,
        ))
        return records

    def _write_log(self, profile: Path, records: list[dict]) -> None:
        (profile / "registry-write-guard.jsonl").write_text(
            "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records),
            encoding="utf-8")

    def run_evidence_validator_tests(self) -> None:
        profile, candidate, snapshot, scenario_result = self._profile_and_candidate(self.temp_root / "evidence")
        records = self._records(profile, candidate, snapshot, groups=3)
        self._write_log(profile, records)
        valid = desktop["verify_registry_guard_log"](profile, candidate, scenario_result)
        assert valid["passed"] is True, valid
        assert valid["main_pid"] == 51964 and valid["launcher_pid"] == 4126, valid
        assert valid["menu_install_group_count"] == 3, valid
        assert valid["blocked_menu_request_count"] == 24, valid
        assert valid["blocked_protocol_registration_count"] == 1, valid
        assert valid["blocked_recent_document_clear_count"] == 1, valid

        incomplete = list(records)
        del incomplete[7]
        self._write_log(profile, incomplete)
        rejected = desktop["verify_registry_guard_log"](profile, candidate, scenario_result)
        assert rejected.get("passed") is not True and rejected.get("failure_code") == "registry_write_guard_request_set_mismatch", rejected

        wrong_entry = json.loads(json.dumps(records))
        protocol = next(item for item in wrong_entry if item["kind"] == "blocked_default_protocol_registration")
        protocol["rawArgs"][2] = [str(self.temp_root / "unrelated.js")]
        protocol["rawArgsSha256"] = hashlib.sha256(json.dumps(
            protocol["rawArgs"], ensure_ascii=False, separators=(",", ":")
        ).encode()).hexdigest()
        self._write_log(profile, wrong_entry)
        rejected = desktop["verify_registry_guard_log"](profile, candidate, scenario_result)
        assert rejected.get("passed") is not True and rejected.get("failure_code") == "default_protocol_guard_record_invalid", rejected

        wrong_pid = json.loads(json.dumps(records))
        wrong_pid[0]["pid"] = 9999
        self._write_log(profile, wrong_pid)
        rejected = desktop["verify_registry_guard_log"](profile, candidate, scenario_result)
        assert rejected.get("passed") is not True and rejected.get("failure_code") == "registry_write_guard_record_invalid", rejected

        launcher_as_main = dict(scenario_result)
        launcher_as_main["actual_ui"] = {"desktop": {"main_pid": 4126}}
        self._write_log(profile, records)
        rejected = desktop["verify_registry_guard_log"](profile, candidate, launcher_as_main)
        assert rejected.get("passed") is not True and rejected.get("failure_code") == "main_process_runtime_snapshot_invalid", rejected

        early_default_app = json.loads(json.dumps(records))
        protocol = next(item for item in early_default_app if item["kind"] == "blocked_default_protocol_registration")
        protocol["defaultApp"] = False
        self._write_log(profile, early_default_app)
        rejected = desktop["verify_registry_guard_log"](profile, candidate, scenario_result)
        assert rejected.get("passed") is not True and rejected.get("failure_code") == "default_protocol_guard_record_invalid", rejected

        unexpected_remove = list(records)
        removal_args = ["zcode"]
        unexpected_remove.append({
            "schemaVersion": 1,
            "kind": "blocked_default_protocol_removal",
            "pid": snapshot["pid"],
            "processType": "browser",
            "cwd": snapshot["cwd"],
            "code": "P02_DEFAULT_PROTOCOL_REMOVAL_BLOCKED",
            "method": "app.removeAsDefaultProtocolClient",
            "defaultApp": snapshot["defaultApp"],
            "rawArgs": removal_args,
            "rawArgsSha256": hashlib.sha256(json.dumps(
                removal_args, ensure_ascii=False, separators=(",", ":")
            ).encode()).hexdigest(),
            "expectedRegistrySubkeys": desktop["EXPECTED_PROTOCOL_GUARD_SUBKEYS"],
            "returnValue": False,
            "returnType": "boolean",
            "blocked": True,
        })
        self._write_log(profile, unexpected_remove)
        rejected = desktop["verify_registry_guard_log"](profile, candidate, scenario_result)
        assert rejected.get("passed") is not True and rejected.get("failure_code") == "unexpected_default_protocol_removal_request", rejected

    def run_candidate_alias_test(self) -> None:
        root = self.temp_root / "alias"
        profile = root / "profile"
        home = profile / "home"
        cli_dir = root / "candidate/apps/zcode-cli/packages/cli/dist"
        cli_entry = cli_dir / "zcode.cjs"
        cli_dir.mkdir(parents=True)
        home.mkdir(parents=True)
        cli_entry.write_text("// P02 isolated candidate alias fixture\n", encoding="utf-8")
        seeded_database = home / ".zcode/cli/db/db.sqlite"
        seeded_database.parent.mkdir(parents=True)
        seeded_database.write_bytes(b"seeded native history database")
        candidate = {"resolved_paths": {"assemblyRoot": str(root / "candidate"), "cliEntry": str(cli_entry)}}
        system_env = os.environ.copy()
        if not system_env.get("SYSTEMROOT"):
            raise RuntimeError("SYSTEMROOT is required for the owned junction helper")
        alias_dir = home / ".zcode/server/agents/glm"
        try:
            receipt = desktop["create_candidate_cli_runtime_alias"](
                profile, home, candidate, system_env, LinkVerifier)
            assert receipt.get("passed") is True, receipt
            desktop["write_json"](profile / "sqlite-cli-runtime-alias.json", receipt)
            verified = desktop["verify_candidate_cli_alias"](profile, candidate, LinkVerifier)
            assert verified.get("passed") is True, verified
            assert alias_dir.is_junction()
            assert alias_dir.resolve(strict=True) == cli_dir.resolve(strict=True)
            assert seeded_database.read_bytes() == b"seeded native history database"
            try:
                desktop["create_candidate_cli_runtime_alias"](
                    profile, home, candidate, system_env, LinkVerifier)
            except RuntimeError as error:
                assert str(error) == "p02_cli_alias_path_preexists", str(error)
            else:
                raise AssertionError("an occupied glm alias must never be replaced")
            forged_receipt = dict(receipt)
            forged_receipt["alias_entry"] = str(cli_entry)
            (profile / "sqlite-cli-runtime-alias.json").write_text(
                json.dumps(forged_receipt), encoding="utf-8")
            rejected = desktop["verify_candidate_cli_alias"](profile, candidate, LinkVerifier)
            assert rejected.get("passed") is not True and rejected.get("failure_code") == "candidate_cli_alias_binding_mismatch", rejected

            linked_root = root / "linked-parent"
            linked_profile = linked_root / "profile"
            linked_home = linked_profile / "home"
            linked_target = linked_root / "unowned-target"
            linked_home.mkdir(parents=True)
            linked_target.mkdir()
            linked_dot_zcode = linked_home / ".zcode"
            powershell = Path(system_env["SYSTEMROOT"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            link_result = subprocess.run(
                [str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                 str(desktop["OWNED_JUNCTION_SCRIPT"]), "-Link", str(linked_dot_zcode), "-Target", str(linked_target)],
                capture_output=True, timeout=20, check=False, shell=False)
            assert link_result.returncode == 0, link_result.stderr.decode("utf-8", errors="replace")
            try:
                try:
                    desktop["create_candidate_cli_runtime_alias"](
                        linked_profile, linked_home, candidate, system_env, LinkVerifier)
                except RuntimeError as error:
                    assert str(error) == "p02_cli_alias_parent_preexists", str(error)
                else:
                    raise AssertionError("a linked alias parent must never be followed")
            finally:
                if linked_dot_zcode.is_junction():
                    os.rmdir(linked_dot_zcode)
        finally:
            if alias_dir.is_junction():
                os.rmdir(alias_dir)

    def run(self) -> None:
        try:
            self.run_evidence_validator_tests()
            self.run_candidate_alias_test()
        finally:
            self.close()


def main() -> int:
    before = desktop["registry_side_effect_snapshot"]()
    DesktopSideEffectGuardTests().run()
    after = desktop["registry_side_effect_snapshot"]()
    print(json.dumps({
        "tests": 2,
        "result": "passed",
        "registrySnapshot": {
            "scope": before["scope"],
            "keyCount": len(before["keys"]),
            "preSha256": before["sha256"],
            "postSha256": after["sha256"],
            "unchanged": before["sha256"] == after["sha256"],
            "access": "read-only",
            "historicalPreState": "unknown; this only compares the current pre/post test boundary",
        },
    }, ensure_ascii=False))
    return 0 if before["sha256"] == after["sha256"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
