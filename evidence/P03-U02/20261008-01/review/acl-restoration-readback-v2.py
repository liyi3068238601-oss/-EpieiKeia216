import base64, hashlib, json, pathlib, re, subprocess
root = pathlib.Path(r'E:\Xiadie\Xiadie')
exp = root / '.runtime/P03/experiments/u02-review-topology-20261008-01'
summary = json.loads((exp / 'summary.json').read_text(encoding='utf-8'))
target = pathlib.Path(summary['roots']['legacyA']) / 'schema.md'
memories_root = exp / 'profile/.zcode/cli/memories'
rel = target.relative_to(memories_root).as_posix()
expected = next(x for x in summary['memoryAfter'] if x['path'].replace('\\','/') == rel)
content = target.read_bytes()
r = subprocess.run(['icacls.exe', str(target)], capture_output=True)
raw = r.stdout + r.stderr
text = raw.decode('gb18030', errors='replace')
assert r.returncode == 0, text
assert hashlib.sha256(content).hexdigest() == expected['sha256']
assert not re.search(r'\(D(?:ENY)?\)', text, re.IGNORECASE), text
result = {'status':'pass','target':str(target),'target_bytes':len(content),'target_sha256':hashlib.sha256(content).hexdigest(),
          'summary_expected_sha256':expected['sha256'],'icacls_exit_code':r.returncode,
          'icacls_output_base64':base64.b64encode(raw).decode('ascii'),'icacls_output_sha256':hashlib.sha256(raw).hexdigest(),
          'icacls_output':text,'explicit_deny_present':False,
          'proof_scope':'post-run synthetic fixture only; service read-after-restoration is recorded in service-results.json'}
print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
