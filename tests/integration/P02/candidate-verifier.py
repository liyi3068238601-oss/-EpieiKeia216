"""P02 verification of owned candidate files and actual CLI SQLite load evidence."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re


PACKAGE_ROOT = "apps/zcode-cli/packages/cli/dist/node_modules/better-sqlite3"
ADDON_PATH = PACKAGE_ROOT + "/prebuilds/win32-x64.node"
ADDON_SHA256 = "e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a"
LICENSE_SHA256 = "09856b52897c91ab67e7456ef43067019f31dfd3b87fda72e655736b1ebdee55"


def sha256(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def linked(file: Path) -> bool:
    return file.is_symlink() or file.is_junction()


def artifact_map(items: object) -> dict[str, dict]:
    if not isinstance(items, list) or not items:
        raise ValueError("candidate_artifacts_empty_or_invalid")
    result = {}
    case_names = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"path", "bytes", "sha256"}:
            raise ValueError("candidate_artifact_binding_invalid")
        name = item["path"]
        if not isinstance(name, str) or not name or "\\" in name or ":" in name:
            raise ValueError("candidate_artifact_path_invalid")
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != name:
            raise ValueError("candidate_artifact_path_invalid")
        if name.casefold() in case_names:
            raise ValueError("candidate_artifact_duplicate")
        if type(item["bytes"]) is not int or item["bytes"] < 0 or not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"]):
            raise ValueError("candidate_artifact_hash_invalid")
        case_names.add(name.casefold())
        result[name] = item
    return result


def owned_file_names(root: Path) -> set[str]:
    """Exclude only the declared borrowed root junction and descriptor itself."""
    names = set()
    def unreadable(_error):
        raise ValueError("candidate_owned_directory_unreadable")

    for directory, folders, files in os.walk(root, followlinks=False, onerror=unreadable):
        current = Path(directory)
        for name in list(folders):
            child = current / name
            if child == root / "node_modules":
                if not child.is_junction():
                    raise ValueError("candidate_borrowed_root_not_junction")
                folders.remove(name)
                continue
            if linked(child) or not child.resolve(strict=True).is_relative_to(root):
                raise ValueError("candidate_owned_directory_link")
        for name in files:
            child = current / name
            if linked(child) or not child.is_file() or not child.resolve(strict=True).is_relative_to(root):
                raise ValueError("candidate_owned_file_link")
            relative = child.relative_to(root).as_posix()
            if relative != "candidate-descriptor.json":
                names.add(relative)
    return names


def verify_owned_artifacts(root: Path, items: object) -> dict[str, dict]:
    bindings = artifact_map(items)
    if owned_file_names(root) != set(bindings):
        raise ValueError("candidate_file_set_mismatch")
    for name, item in bindings.items():
        file = root / name
        if file.stat().st_size != item["bytes"] or sha256(file) != item["sha256"]:
            raise ValueError("candidate_owned_file_hash_mismatch")
    return bindings


def verify_sqlite_package(root: Path, runtime: object, bindings: dict[str, dict]) -> dict:
    fields = {"packageRoot", "packageVersion", "sqliteVersion", "addonPath", "addonSha256", "licensePath", "licenseSha256", "closedFiles"}
    if not isinstance(runtime, dict) or set(runtime) != fields:
        raise ValueError("candidate_sqlite_runtime_schema_invalid")
    if (runtime["packageRoot"] != PACKAGE_ROOT or runtime["packageVersion"] != "13.0.3" or
            runtime["sqliteVersion"] != "3.53.4" or runtime["addonPath"] != ADDON_PATH or
            runtime["addonSha256"] != ADDON_SHA256 or runtime["licensePath"] != PACKAGE_ROOT + "/LICENSE" or
            runtime["licenseSha256"] != LICENSE_SHA256):
        raise ValueError("candidate_sqlite_runtime_pin_mismatch")
    closed = artifact_map(runtime["closedFiles"])
    package_bindings = {name: item for name, item in bindings.items() if name.startswith(PACKAGE_ROOT + "/")}
    if closed != package_bindings:
        raise ValueError("candidate_sqlite_package_closure_mismatch")
    required = {PACKAGE_ROOT + "/package.json", PACKAGE_ROOT + "/LICENSE", PACKAGE_ROOT + "/lib/index.js", ADDON_PATH}
    if not required.issubset(closed) or any(name not in required and not name.startswith(PACKAGE_ROOT + "/lib/") for name in closed):
        raise ValueError("candidate_sqlite_package_files_invalid")
    package = json.loads((root / PACKAGE_ROOT / "package.json").read_bytes())
    if package.get("name") != "better-sqlite3" or package.get("version") != "13.0.3" or package.get("license") != "MIT":
        raise ValueError("candidate_sqlite_package_identity_mismatch")
    if closed[ADDON_PATH]["sha256"] != ADDON_SHA256 or closed[PACKAGE_ROOT + "/LICENSE"]["sha256"] != LICENSE_SHA256:
        raise ValueError("candidate_sqlite_package_pin_mismatch")
    return {"package_files_verified": len(closed), "package_version": "13.0.3", "addon_sha256": ADDON_SHA256,
            "boundary": "Owned Better SQLite runtime package only; Native root dependencies remain borrowed."}


def verify_candidate(harness, candidate_arg: str, base_verify) -> dict:
    original_keys = harness.ALLOWED_DESCRIPTOR_KEYS
    harness.ALLOWED_DESCRIPTOR_KEYS = original_keys | {"sqliteRuntime"}
    try:
        verified = base_verify(candidate_arg)
        root = Path(verified["resolved_paths"]["assemblyRoot"])
        borrowed = root / "node_modules"
        expected = Path(verified["resolved_paths"]["sourceRoot"]) / "node_modules"
        if not borrowed.is_junction() or borrowed.resolve(strict=True) != expected.resolve(strict=True):
            raise ValueError("candidate_borrowed_root_mismatch")
        descriptor = json.loads((root / "candidate-descriptor.json").read_bytes())
        bindings = verify_owned_artifacts(root, descriptor.get("artifacts"))
        verified["p02_owned_file_verification"] = {
            "passed": True, "owned_files_verified": len(bindings),
            **verify_sqlite_package(root, descriptor.get("sqliteRuntime"), bindings),
        }
        return verified
    except (ValueError, OSError, TypeError, KeyError) as error:
        code = str(error) if re.fullmatch(r"[a-z0-9_]+", str(error)) else "p02_candidate_verification_failed"
        raise harness.HarnessError(code) from error
    finally:
        harness.ALLOWED_DESCRIPTOR_KEYS = original_keys


def verify_runtime_probes(profile: Path, scenario_id: str, result: dict, candidate: dict, ledger: dict) -> dict:
    root = Path(candidate["resolved_paths"]["assemblyRoot"])
    expected_addon = (root / ADDON_PATH).resolve(strict=True)
    probe_root = profile / "sqlite-runtime-probes"
    if not probe_root.is_dir() or linked(probe_root) or not probe_root.resolve(strict=True).is_relative_to(profile.resolve(strict=True)):
        raise ValueError("sqlite_runtime_probe_directory_invalid")
    files = sorted(probe_root.iterdir())
    if len(files) > 64:
        raise ValueError("sqlite_runtime_probe_limit")
    guard_pids = set(result.get("network_guard", {}).get("cli_guarded_pids", []))
    probes = []
    fields = {"schema", "pid", "processDlopenLoads", "addonPath", "addonSha256", "packageVersion", "sqliteVersion"}
    for file in files:
        if linked(file) or not file.is_file() or not re.fullmatch(r"[1-9][0-9]*\.json", file.name) or file.stat().st_size > 65536:
            raise ValueError("sqlite_runtime_probe_file_invalid")
        probe = json.loads(file.read_bytes())
        if not isinstance(probe, dict) or set(probe) != fields or probe["schema"] != "p02-sqlite-runtime-binding/v1":
            raise ValueError("sqlite_runtime_probe_schema_invalid")
        pid = probe["pid"]
        if type(pid) is not int or pid <= 0 or file.stem != str(pid) or pid not in guard_pids:
            raise ValueError("sqlite_runtime_probe_pid_unbound")
        if (probe["packageVersion"] != "13.0.3" or probe["sqliteVersion"] != "3.53.4" or
                probe["addonSha256"] != ADDON_SHA256 or Path(probe["addonPath"]).resolve(strict=True) != expected_addon):
            raise ValueError("sqlite_runtime_probe_binding_mismatch")
        loads = probe["processDlopenLoads"]
        if not isinstance(loads, list) or not loads or len(loads) > 64:
            raise ValueError("sqlite_runtime_probe_loads_invalid")
        actual = []
        for load in loads:
            if not isinstance(load, dict) or set(load) != {"pid", "path"} or type(load["pid"]) is not int or load["pid"] != pid:
                raise ValueError("sqlite_runtime_probe_load_identity_invalid")
            if not isinstance(load["path"], str) or not Path(load["path"]).is_absolute():
                raise ValueError("sqlite_runtime_probe_load_path_invalid")
            loaded = Path(load["path"]).resolve(strict=True)
            if "better-sqlite3" in loaded.parts and loaded != expected_addon:
                raise ValueError("sqlite_runtime_probe_borrowed_addon_rejected")
            actual.append(loaded)
        if expected_addon not in actual or sha256(expected_addon) != ADDON_SHA256:
            raise ValueError("sqlite_runtime_probe_actual_load_missing")
        probes.append({"pid": pid, "path": str(file), "bytes": file.stat().st_size, "sha256": sha256(file),
                       "addon_sha256": ADDON_SHA256, "package_version": "13.0.3", "sqlite_version": "3.53.4"})
    has_ledger = ledger.get("ledgerCount", 0) > 0
    if scenario_id == "disabled_native" and (probes or has_ledger):
        raise ValueError("disabled_native_sqlite_probe_unexpected")
    if has_ledger != bool(probes):
        raise ValueError("sqlite_runtime_probe_ledger_mismatch")
    if not has_ledger and scenario_id not in {"disabled_native", "no_key", "pro_denied"}:
        raise ValueError("sqlite_runtime_probe_expected_instantiation_missing")
    return {"passed": True, "status": "verified_actual_cli_load" if probes else "not_instantiated",
            "probes": probes, "cli_guarded_pids": sorted(guard_pids),
            "boundary": "Observed CLI load only; no-load routes do not qualify an addon load. Ledger readback is a separate process."}
