import hashlib, json, pathlib, subprocess

ROOT = pathlib.Path(r'E:\Xiadie\Xiadie').resolve()
REVIEW = ROOT / '.runtime/P02/reviews/mature-sqlite-u02'
AUTHOR = ROOT / '.runtime/P02/worktrees/mature-sqlite-spike'
REPORT = REVIEW / 'review-final.json'
AUTHOR_SHA = '41395427182ecfdd5480da7ccaac4fccd4186249'
BASE_SHA = '4163f5c5d1df93878bbfd2ecd85ab98cf9e919e2'
NODE = ROOT / '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe'
PKG = ROOT / '.runtime/P02/experiments/mature-sqlite-spike/install/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3'
ADDON = PKG / 'prebuilds/win32-x64.node'
LEDGER = ROOT / '.runtime/P02/experiments/completion-u10/full-01/scenarios/success/profile/plugin-storage/data/xiadie@xiadie-local/event-ledger.sqlite'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def bind(path, root_name, base):
    path = pathlib.Path(path).resolve()
    raw = path.read_bytes()
    return {'path': path.relative_to(base).as_posix(), 'root': root_name,
            'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

def git(*args, cwd=ROOT):
    return subprocess.check_output(['git', *args], cwd=cwd).decode('utf-8').strip()

assert git('rev-parse', 'HEAD', cwd=AUTHOR) == AUTHOR_SHA
assert not git('status', '--porcelain', cwd=AUTHOR)
assert git('rev-parse', 'HEAD') == BASE_SHA
assert not git('status', '--porcelain')
assert sha(ADDON) == 'e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a'
assert sha(NODE) == '63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088'
assert sha(LEDGER) == '7b5960a4ba289203b36694368f675a642d5c28062b969f2a9ce4a7b9190aa8c2'

changed = [p for p in git('diff', '--name-only', BASE_SHA, AUTHOR_SHA, '--', cwd=AUTHOR).splitlines() if p]
assert len(changed) == 12, changed
assert all(p.startswith(('spikes/P02/mature-sqlite/', 'docs/adr/P02-reuse.md', 'evidence/P02-U02/20261004-02/')) for p in changed), changed
artifacts = [bind(AUTHOR / p, 'author_worktree', AUTHOR) for p in changed]
for p in sorted(REVIEW.rglob('*')):
    if not p.is_file() or p.resolve() == REPORT.resolve():
        continue
    if p.is_symlink():
        raise AssertionError(f'symlink in reviewer output: {p}')
    artifacts.append(bind(p, 'review_directory', REVIEW))

repo_inputs = [
    'planning/Xiadie_V2_v1.1/tasks/P02-U02.md',
    'planning/Xiadie_V2_v1.1/tasks/P02-U05.md',
    'docs/research/P02/sqlite-reuse.md',
    'docs/adr/P02-reuse.md',
    'packages/storage/events/src/index.ts',
    'packages/storage/backup/src/index.ts',
    'evidence/P02/status.json',
    '.runtime/P02/coord/verify-author.py',
    '.runtime/P02/coord/verify-review.py',
    '.runtime/P02/coord/accept-unit.py',
    '.runtime/P02/experiments/mature-sqlite-spike/research/index.json',
    '.runtime/P02/experiments/mature-sqlite-spike/research/package.json',
    '.runtime/P02/experiments/mature-sqlite-spike/research/database.txt',
    '.runtime/P02/experiments/mature-sqlite-spike/research/backup.txt',
    '.runtime/P02/experiments/mature-sqlite-spike/research/api.txt',
    '.runtime/P02/experiments/mature-sqlite-spike/research/license.txt',
    '.runtime/P02/experiments/mature-sqlite-spike/install/package.json',
    '.runtime/P02/experiments/mature-sqlite-spike/install/pnpm-lock.yaml',
    '.runtime/P02/experiments/mature-sqlite-spike/install/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/package.json',
    '.runtime/P02/experiments/mature-sqlite-spike/install/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/lib/database.js',
    '.runtime/P02/experiments/mature-sqlite-spike/install/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/lib/methods/backup.js',
    '.runtime/P02/experiments/mature-sqlite-spike/install/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/lib/methods/transaction.js',
    '.runtime/P02/experiments/mature-sqlite-spike/install/node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/prebuilds/win32-x64.node',
    '.runtime/P01/desktop-build-evidence/toolchain/node-v24.14.0-win-x64/node.exe',
    '.runtime/P02/experiments/completion-u10/full-01/scenarios/success/profile/plugin-storage/data/xiadie@xiadie-local/event-ledger.sqlite',
]
immutable_inputs = [bind(ROOT / p, 'baseline_repository', ROOT) for p in repo_inputs]

report = {
  'schema': 'p02-independent-review/v1',
  'decision': 'pass',
  'review_target': {
    'author_commit': AUTHOR_SHA,
    'baseline_commit': BASE_SHA,
    'author_worktree': str(AUTHOR),
  },
  'attempt': '20261004-02',
  'author_manifest_sha256': '6cc875a086a1474fbbcc1c4a9465b7e27339aaa1ec06ec72af18ff02781e5054',
  'artifacts': artifacts,
  'immutable_inputs': immutable_inputs,
  'external_references': [
    {'url':'https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3', 'description':'Official v13.0.3 release page; release identifies commit dbc2ea1.'},
    {'url':'https://raw.githubusercontent.com/WiseLibs/better-sqlite3/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/LICENSE', 'description':'Pinned upstream MIT license; copyright line dates to 2017.'},
    {'url':'https://raw.githubusercontent.com/WiseLibs/better-sqlite3/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/lib/methods/transaction.js', 'description':'Pinned upstream transaction implementation; synchronous callbacks are enforced.'},
    {'url':'https://raw.githubusercontent.com/WiseLibs/better-sqlite3/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/test/40.bigints.js', 'description':'Pinned upstream BigInt tests, retained with hashes under review author-records.'},
    {'url':'https://raw.githubusercontent.com/WiseLibs/better-sqlite3/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/test/36.database.backup.js', 'description':'Pinned upstream online backup tests, retained with hashes under review author-records.'},
  ],
  'checks': [
    {'id':'frozen_author_manifest_scope', 'status':'pass', 'details':'Author HEAD equals 41395427182ecfdd5480da7ccaac4fccd4186249; baseline is 4163f5c5d1df93878bbfd2ecd85ab98cf9e919e2; verify-author.py succeeded with 11 manifest content files, 12 changed paths, clean worktree, and no disk/Git mismatches. The 12 paths are within the declared spike, ADR, and attempt evidence scope.'},
    {'id':'library_provenance_and_windows_load', 'status':'pass', 'details':'Pinned better-sqlite3 13.0.3 source commit dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb; official MIT license carries 2017 copyright; package engines require Node >=22 and declare node-addon-api ^8; the fixed Node 24.14.0 runtime reports N-API 10 and actually loaded the package addon on Windows x64 (SHA-256 e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a); better SQLite is 3.53.4, separately from Node builtin SQLite 3.51.2. `install --ignore-scripts` exited 0, package has no install script.'},
    {'id':'independent_spike_replay', 'status':'pass', 'details':'Frozen author script reran independently in reviewer-owned data/output paths using the pinned Node executable: 9/9 pass, including unique/replay/conflict behavior, transaction rollback/commit process termination, WAL online backup/restore, bounded SQLITE_BUSY/retry, readonly write rejection, integer precision, and native addon load.'},
    {'id':'actual_v1_product_ledger_cross_binding', 'status':'pass', 'details':'Cross-open used the real synthetic P01/U10 completion-u10/full-01 success ledger with v1 product schema, not the simplified early PoC DB. Before any SQLite open, the DB/WAL/SHM set was copied offline into the independent review directory and the owned copy was hash-checked. Node and better-sqlite3 both read and wrote the product schema; Node SQLite backup captured binding-written WAL, and better read the Node backup. Original source DB SHA-256 remained 7b5960a4ba289203b36694368f675a642d5c28062b969f2a9ce4a7b9190aa8c2 before and after; source WAL and SHM were absent both times.'},
    {'id':'safe_integer_and_open_boundaries', 'status':'pass', 'details':'Reviewer negative cases prove get() and all() round unsafe default integer 9007199254740993 to 9007199254740992; enabling safe integers preserves exact BigInt and the checked adapter rejects out-of-range values while accepting MAX_SAFE_INTEGER. Readonly open on missing DB returns SQLITE_CANTOPEN without creating DB/WAL/SHM. Writable new WAL DB creates sidecars; main-file-only copy missed the committed WAL row while SQLite backup retained it.'},
    {'id':'lost_ack_busy_readonly_backup_negative_cases', 'status':'pass', 'details':'Five reviewer-owned negative cases passed. A controlled child exited with code 79 after COMMIT but before acknowledgement; reconciliation read the committed fact/origin/receipt and retry produced duplicate/no-op while changed payload conflicted. This is explicitly process exit, not power loss. A backup to an existing destination replaced prior contents, so future backup publication needs a unique staged file and no-clobber step.'},
    {'id':'addon_and_input_integrity', 'status':'pass', 'details':'Pre/post package tree stayed 68 files / 27,302,969 bytes / SHA-256 dbd29487bbb8240a462174e84c2f90f4957aae33effcd64e6ce64a6a9569c4bd; actual win32-x64 addon remained SHA-256 e21e5efd71fba66578e95b62554d9028064a80dafd7221bf8a8ef155de8d240a. The U10 source ledger and its sidecar absence also remained unchanged.'},
    {'id':'source_index_completeness_note', 'status':'pass_with_note', 'details':'The author result says the locked upstream transaction implementation and four upstream test files are listed in its research/index.json, but that index records only package.json, database.js, backup.js, api.md, and LICENSE. The installed package does include transaction.js; reviewer independently retrieved and SHA-bound the four exact-commit test files in review author-records/upstream-tests. These upstream tests were reference material and were not executed. This is a non-blocking provenance-index omission; it does not invalidate the locally rerun behavioral evidence.'},
  ],
  'limitations': [
    'No upstream development test suite, product implementation tests, or Native Runtime historical 16-test suite were run in this review; the Native 16-test evidence remains historical only.',
    'All test rows are synthetic. The killed workers and lost-ack process exit establish process-termination behavior only, not physical power loss, storage hardware failure, or production durability guarantees.',
    'The spike establishes a mature binding candidate and interoperability evidence for the event ledger. It does not implement U05, migrate the U08 backup coordinator, or establish G02/P03 completion.',
    'better-sqlite3 backup overwrites an existing destination in the tested successful case. Any later backup integration must stage to a unique path and publish with a separately verified no-clobber policy.',
    'Author research/index.json omits transaction.js and the four referenced upstream test file hashes even though result.md implies they are indexed; reviewer preserved independent exact-commit copies and hashes. The full upstream suite was not run.',
  ],
}
REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'report': str(REPORT), 'artifact_count': len(artifacts), 'immutable_input_count': len(immutable_inputs), 'author_path_count': len(changed), 'reviewer_file_count': len(artifacts)-len(changed), 'author_sha': git('rev-parse','HEAD',cwd=AUTHOR), 'baseline_sha': git('rev-parse','HEAD'), 'report_bytes': REPORT.stat().st_size, 'report_sha256': sha(REPORT)}, ensure_ascii=False))

