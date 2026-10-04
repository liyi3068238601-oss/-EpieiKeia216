"""Synthetic validator counterexamples; these do not establish actual CLI loading."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import unittest

SOURCE = Path(__file__).with_name("candidate-verifier.py")
spec = importlib.util.spec_from_file_location("p02_verifier_under_test", SOURCE)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
FIXTURES = Path(sys.argv[1]).resolve()
HOST = Path(r"E:\Xiadie\Xiadie")
assert FIXTURES.is_relative_to(HOST / ".runtime/P02/experiments/mature-integration")
assert not FIXTURES.exists(), "Use a new owned fixture directory"
FIXTURES.mkdir(parents=True)


class CandidateVerifierTests(unittest.TestCase):
    def setUp(self):
        self.root = FIXTURES / self._testMethodName
        self.root.mkdir()

    def artifact(self, relative, contents):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(contents)
        return {"path": relative, "bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}

    def test_owned_files_positive(self):
        artifact = self.artifact("cli.js", b"owned bytes")
        self.artifact("candidate-descriptor.json", b"{}")
        self.assertEqual(verifier.verify_owned_artifacts(self.root, [artifact]), {"cli.js": artifact})

    def test_unlisted_nested_node_modules_rejected(self):
        artifact = self.artifact("cli.js", b"owned bytes")
        self.artifact("apps/cli/dist/node_modules/unlisted/index.js", b"unlisted runtime")
        with self.assertRaisesRegex(ValueError, "candidate_file_set_mismatch"):
            verifier.verify_owned_artifacts(self.root, [artifact])

    def test_same_length_changed_bytes_rejected(self):
        artifact = self.artifact("cli.js", b"first")
        (self.root / "cli.js").write_bytes(b"other")
        with self.assertRaisesRegex(ValueError, "candidate_owned_file_hash_mismatch"):
            verifier.verify_owned_artifacts(self.root, [artifact])

    def probe_context(self):
        candidate = self.root / "candidate"
        addon = candidate / verifier.ADDON_PATH
        addon.parent.mkdir(parents=True)
        shutil.copyfile(HOST / "node_modules/better-sqlite3/prebuilds/win32-x64.node", addon)
        profile = self.root / "profile"
        probe_root = profile / "sqlite-runtime-probes"
        probe_root.mkdir(parents=True)
        result = {"network_guard": {"cli_guarded_pids": [123]}}
        metadata = {"resolved_paths": {"assemblyRoot": str(candidate)}}
        probe = {"schema": "p02-sqlite-runtime-binding/v1", "pid": 123,
                 "processDlopenLoads": [{"pid": 123, "path": str(addon)}],
                 "addonPath": str(addon), "addonSha256": verifier.ADDON_SHA256,
                 "packageVersion": "13.0.3", "sqliteVersion": "3.53.4"}
        return profile, probe_root, result, metadata, probe

    def test_same_addon_bytes_from_borrowed_path_rejected(self):
        profile, probe_root, result, candidate, probe = self.probe_context()
        borrowed = HOST / "node_modules/better-sqlite3/prebuilds/win32-x64.node"
        probe["addonPath"] = str(borrowed)
        probe["processDlopenLoads"][0]["path"] = str(borrowed)
        (probe_root / "123.json").write_text(json.dumps(probe), encoding="utf8")
        with self.assertRaisesRegex(ValueError, "sqlite_runtime_probe_binding_mismatch"):
            verifier.verify_runtime_probes(profile, "success", result, candidate, {"ledgerCount": 1})

    def test_relative_addon_path_rejected_even_if_it_resolves_to_candidate_file(self):
        profile, probe_root, result, candidate, probe = self.probe_context()
        addon = Path(probe["addonPath"])
        probe["addonPath"] = os.path.relpath(addon, self.root)
        self.assertFalse(Path(probe["addonPath"]).is_absolute())
        original_cwd = Path.cwd()
        try:
            os.chdir(self.root)
            self.assertEqual(Path(probe["addonPath"]).resolve(strict=True), addon.resolve(strict=True))
            (probe_root / "123.json").write_text(json.dumps(probe), encoding="utf8")
            with self.assertRaisesRegex(ValueError, "sqlite_runtime_probe_addon_path_invalid"):
                verifier.verify_runtime_probes(profile, "success", result, candidate, {"ledgerCount": 1})
        finally:
            os.chdir(original_cwd)

    def test_bound_synthetic_probe_positive_control(self):
        profile, probe_root, result, candidate, probe = self.probe_context()
        (probe_root / "123.json").write_text(json.dumps(probe), encoding="utf8")
        report = verifier.verify_runtime_probes(profile, "success", result, candidate, {"ledgerCount": 1})
        self.assertEqual(report["status"], "verified_actual_cli_load")
        self.assertEqual([item["pid"] for item in report["probes"]], [123])

    def test_unrelated_pid_rejected(self):
        profile, probe_root, result, candidate, probe = self.probe_context()
        result["network_guard"]["cli_guarded_pids"] = [456]
        (probe_root / "123.json").write_text(json.dumps(probe), encoding="utf8")
        with self.assertRaisesRegex(ValueError, "sqlite_runtime_probe_pid_unbound"):
            verifier.verify_runtime_probes(profile, "success", result, candidate, {"ledgerCount": 1})

    def test_no_key_no_instantiation_is_explicit(self):
        profile, _probe_root, result, candidate, _probe = self.probe_context()
        report = verifier.verify_runtime_probes(profile, "no_key", result, candidate, {"ledgerCount": 0})
        self.assertEqual(report["status"], "not_instantiated")
        self.assertEqual(report["probes"], [])

    def test_existing_ledger_requires_load_evidence(self):
        profile, _probe_root, result, candidate, _probe = self.probe_context()
        with self.assertRaisesRegex(ValueError, "sqlite_runtime_probe_ledger_mismatch"):
            verifier.verify_runtime_probes(profile, "success", result, candidate, {"ledgerCount": 1})


if __name__ == "__main__":
    outcome = unittest.main(argv=[sys.argv[0]], exit=False).result
    print(json.dumps({"schema": "p02-synthetic-candidate-validator-tests/v1", "tests": outcome.testsRun,
                      "passed": outcome.wasSuccessful(), "fixtures": str(FIXTURES),
                      "boundary": "Synthetic validation records, not observed CLI/SQLite execution."}))
    raise SystemExit(0 if outcome.wasSuccessful() else 1)
