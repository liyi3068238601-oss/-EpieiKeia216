from pathlib import Path
src = Path(r'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004/u11-independent-audit.py').read_text(encoding='utf-8')
repls = [
 ('out = REVIEW / "readback-audit.json"', 'out = REVIEW / "readback-audit-v2.json"', 1),
 ('probe_files = [p for p in raw_paths if p.startswith(prefix + "/sqlite-runtime-probes/")]', 'raw_prefix = prefix.removeprefix("runtime-raw-candidate09/")\n        probe_files = [p for p in raw_paths if p.startswith(raw_prefix + "/sqlite-runtime-probes/")]', 1),
 ('not cmd_bad and len(cmdidx["commands"]) == 16 and len(nonzero) >= 1 and cmd17.exists() and any(x["path"] == "commands/17-write-release-proof-final-command.json" for x in manifest_paths)', 'not cmd_bad and len(cmdidx["commands"]) == 17 and len(nonzero) >= 1 and cmd17.exists() and cmdidx.get("selfReferenceExclusion", {}).get("path") == "commands/17-write-release-proof-final-command.json" and "commands/17-write-release-proof-final-command.json" in manifest_paths', 1),
 ('f"indexed commands={len(cmdidx[\'commands\'])}; failures retained={len(nonzero)}; final self-reference-excluded generator record is in manifest; mismatches={len(cmd_bad)}"', 'f"indexed commands={len(cmdidx[\'commands\'])}; failures retained={len(nonzero)}; self-reference-excluded outer generator record is manifest-bound; mismatches={len(cmd_bad)}"', 1),
 ('sum(group.get("count", 0) for group in input_groups.values()) == 103', 'len({row["path"] for group in input_groups.values() for row in group.get("files", [])}) == 103 and {row["path"] for group in input_groups.values() for row in group.get("files", [])} == set(desc_inputs)', 1),
 ('"P03 has not started" in result_text', '"P03 尚未开始" in result_text', 2),
 ('"new onboarding-timeout fallback" in result_text', '"未触发新的 onboarding-timeout fallback 分支" in result_text', 1),
 ('f"README/freeze/result/source-decision/rollback/requirement evidence are valid UTF-8 and bind P02 source/prompt/schema/requirements, Better license/notices, pending G02, Electron/Node distinction, not-OS-sandbox and untested limits; input-group count={sum(x.get(\'count\',0) for x in input_groups.values())}"', 'f"README/freeze/result/source-decision/rollback/requirement evidence are valid UTF-8 and bind 103 distinct inputs (groups overlap), pending G02, Electron/Node distinction, Better license/notices and limits; distinct group paths={len({row[\'path\'] for group in input_groups.values() for row in group.get(\'files\', [])})}"', 1),
 ('not any("run-tests.mjs" in str(json.loads(readb(E / c["path"])).get("argv", [])) or "native.integration.test" in str(json.loads(readb(E / c["path"])).get("argv", [])) for c in cmdidx["commands"])', 'not any(any(pathlib.Path(str(arg)).name in {"run-tests.mjs", "native.integration.test.mjs"} for arg in json.loads(readb(E / c["path"])).get("argv", [])) for c in cmdidx["commands"])', 1),
]
for old, new, expected in repls:
    n = src.count(old)
    if n != expected:
        raise SystemExit(f'expected {expected} occurrence(s), got {n}: {old[:120]}')
    src = src.replace(old, new)
out = Path(r'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004/u11-independent-audit-v2.py')
if out.exists():
    raise SystemExit('refusing to overwrite v2')
out.write_text(src, encoding='utf-8', newline='\n')
print(out)
