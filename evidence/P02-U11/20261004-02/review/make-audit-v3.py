from pathlib import Path
src = Path(r'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004/u11-independent-audit-v2.py').read_text(encoding='utf-8')
repls = [
 ('out = REVIEW / "readback-audit-v2.json"', 'out = REVIEW / "readback-audit-final.json"', 1),
 ('"commands/17-write-release-proof-final-command.json" in manifest_paths', 'f"evidence/P02-U11/{ATTEMPT}/commands/17-write-release-proof-final-command.json" in manifest_paths', 1),
]
for old, new, expected in repls:
    n = src.count(old)
    if n != expected:
        raise SystemExit(f'expected {expected}, got {n}: {old}')
    src = src.replace(old, new)
out = Path(r'.runtime/P02/reviews/mature-freeze-u11/final-e11e734-20261004/u11-independent-audit-v3.py')
if out.exists(): raise SystemExit('refusing to overwrite v3')
out.write_text(src, encoding='utf-8', newline='\n')
print(out)
