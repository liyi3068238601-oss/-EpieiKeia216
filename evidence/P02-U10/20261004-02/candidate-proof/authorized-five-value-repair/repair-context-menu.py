"""Narrow proposed repair. Dry-run by default; apply only after user approval."""
import argparse
import hashlib
import json
from pathlib import Path
import winreg

ROOT = Path(__file__).resolve().parent
SNAPSHOT = ROOT / "current-keys.json"
SNAPSHOT_HASH = "53e10dd914a73a78201c0969007f00988d861ad1e352ccf241840fab5329169b"
EXE = Path(r"D:\Zcode\ZCode.exe")
EXE_HASH = "2cd9f0672841f9a09d00aced4223114c3c7c37cfa8a308e7e79641d617497b0f"
PROTOCOL_SNAPSHOT = ROOT / "current-protocol-keys.json"
PROTOCOL_HASH = "85111aecd7a2d94bede281f71660954b60afb23d2e080c4e9be3d0d9bdbb9d11"
PROTOCOL_COMMAND = r"Software\Classes\zcode\shell\open\command"


def read_values(subkey):
    result = []
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey, 0, winreg.KEY_READ) as key:
        index = 0
        while True:
            try:
                name, value, kind = winreg.EnumValue(key, index)
            except OSError:
                break
            result.append({"name": name, "value": value, "type": kind})
            index += 1
    return sorted(result, key=lambda row: row["name"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--include-protocol", action="store_true")
    args = parser.parse_args()
    raw = SNAPSHOT.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SNAPSHOT_HASH:
        raise RuntimeError("snapshot_changed")
    if hashlib.sha256(EXE.read_bytes()).hexdigest() != EXE_HASH:
        raise RuntimeError("installed_executable_changed")
    entries = json.loads(raw)["entries"]
    if args.include_protocol:
        protocol_raw = PROTOCOL_SNAPSHOT.read_bytes()
        if hashlib.sha256(protocol_raw).hexdigest() != PROTOCOL_HASH:
            raise RuntimeError("protocol_snapshot_changed")
        protocol_entries = json.loads(protocol_raw)["entries"]
        for entry in protocol_entries:
            try:
                actual = read_values(entry["subkey"])
            except FileNotFoundError:
                if entry["exists"]:
                    raise RuntimeError("protocol_registry_changed_since_snapshot")
            else:
                if not entry["exists"] or actual != sorted(entry["values"], key=lambda row: row["name"]):
                    raise RuntimeError("protocol_registry_changed_since_snapshot")
        entries.extend(entry for entry in protocol_entries if entry["subkey"] == PROTOCOL_COMMAND)
    mutations = []
    for entry in entries:
        if entry["hive"] != "HKCU" or not entry["exists"]:
            raise RuntimeError("unexpected_snapshot")
        subkey = entry["subkey"]
        expected = sorted(entry["values"], key=lambda row: row["name"])
        if read_values(subkey) != expected:
            raise RuntimeError("registry_changed_since_snapshot:" + subkey)
        is_command = subkey.endswith(r"\command")
        name = "" if is_command else "Icon"
        old = next(row for row in expected if row["name"] == name)
        if subkey == PROTOCOL_COMMAND:
            new = f'"{EXE}" "%1"'
        else:
            new = f'"{EXE}" --open-workspace "%1"' if is_command else str(EXE)
        mutations.append({"subkey": subkey, "name": name, "before": old,
                          "after": {"name": name, "value": new, "type": winreg.REG_SZ}})
    if len(mutations) != (5 if args.include_protocol else 4):
        raise RuntimeError("unexpected_mutation_count")
    plan = {"qualification": "functional repair to verified installed ZCode; original values unknown",
            "executableSha256": EXE_HASH, "includesProtocol": args.include_protocol,
            "mutations": mutations, "applied": False}
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    if not args.apply:
        return
    prefix = "repair-with-protocol" if args.include_protocol else "repair"
    before_path = ROOT / (prefix + "-before.json")
    with before_path.open("x", encoding="utf-8") as stream:
        json.dump(plan, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    changed = []
    try:
        for mutation in mutations:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, mutation["subkey"], 0,
                                winreg.KEY_QUERY_VALUE | winreg.KEY_SET_VALUE) as key:
                expected = mutation["before"]
                if winreg.QueryValueEx(key, mutation["name"]) != (expected["value"], expected["type"]):
                    raise RuntimeError("registry_changed_before_write")
                after = mutation["after"]
                winreg.SetValueEx(key, mutation["name"], 0, after["type"], after["value"])
                changed.append(mutation)
                if winreg.QueryValueEx(key, mutation["name"]) != (after["value"], after["type"]):
                    raise RuntimeError("registry_write_readback_mismatch")
        plan["applied"] = True
        with (ROOT / (prefix + "-result.json")).open("x", encoding="utf-8") as stream:
            json.dump(plan, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    except Exception:
        for mutation in reversed(changed):
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, mutation["subkey"], 0,
                                winreg.KEY_SET_VALUE) as key:
                old = mutation["before"]
                winreg.SetValueEx(key, mutation["name"], 0, old["type"], old["value"])
        raise


if __name__ == "__main__":
    main()
