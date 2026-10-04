import hashlib
import json
import pathlib
import os

ROOT = pathlib.Path(r'E:\Xiadie\Xiadie')
AUTHOR = ROOT / '.runtime' / 'P02' / 'worktrees' / 'mature-sqlite-store'
REVIEW = ROOT / '.runtime' / 'P02' / 'reviews' / 'mature-sqlite-store-u05'
AUTHOR_COMMIT = '008005d37a0aa543f3827880de2c85980164c499'
BASELINE_COMMIT = 'b694bed232fa914a1c6b27329fa072c2e8a30a13'
MANIFEST_SHA = '4bf0f60207d23728654a2fb063d54c448f48923233706c95d15e4ca6e834ec64'

def digest(path):
    raw = pathlib.Path(path).read_bytes()
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}

def inventory(root_name, root_path, relative):
    path = pathlib.Path(root_path) / relative
    meta = digest(path)
    return {'path': pathlib.Path(relative).as_posix(), 'root': root_name, **meta}

manifest_path = AUTHOR / 'evidence/P02-U05/20261004-02/manifest.json'
manifest_raw = manifest_path.read_bytes()
assert hashlib.sha256(manifest_raw).hexdigest() == MANIFEST_SHA
manifest = json.loads(manifest_raw)
pre = json.loads((REVIEW / 'state-before.json').read_bytes())
post = json.loads((REVIEW / 'state-after.json').read_bytes())
comparison = json.loads((REVIEW / 'state-comparison.json').read_bytes())
negative = json.loads((REVIEW / 'negative-results.json').read_bytes())
assert comparison['result'] == 'pass'
assert len(manifest['files']) == 48
assert pre['authorGit']['head']['stdout'] == AUTHOR_COMMIT
assert post['authorGit']['head']['stdout'] == AUTHOR_COMMIT
assert pre['baselineGit']['head']['stdout'] == BASELINE_COMMIT
assert post['baselineGit']['head']['stdout'] == BASELINE_COMMIT
assert all(not state['status']['stdout'] for state in (pre['authorGit'], post['authorGit']))
assert all(not state['status']['stdout'] for state in (pre['baselineGit'], post['baselineGit']))

immutable = {}
def add_immutable(root_name, root_path, relative, expected=None):
    key = (root_name, pathlib.Path(relative).as_posix())
    absolute = pathlib.Path(root_path) / relative
    actual = digest(absolute)
    if expected:
        assert actual['bytes'] == expected['bytes'], str(absolute)
        assert actual['sha256'] == expected['sha256'], str(absolute)
    item = {'path': key[1], 'root': root_name, **actual}
    old = immutable.get(key)
    assert old is None or old == item, str(absolute)
    immutable[key] = item

for entry in manifest['files']:
    add_immutable('author_worktree', AUTHOR, entry['path'], entry)
add_immutable('author_worktree', AUTHOR, pathlib.Path('evidence/P02-U05/20261004-02/manifest.json').as_posix(),
              {'bytes': len(manifest_raw), 'sha256': MANIFEST_SHA})

for item in pre['authorInputs']:
    if 'missing' not in item:
        rel = pathlib.Path(item['path']).relative_to(AUTHOR).as_posix()
        add_immutable('author_worktree', AUTHOR, rel, item)
for item in pre['baselineInputs']:
    if 'missing' not in item:
        rel = pathlib.Path(item['path']).relative_to(ROOT).as_posix()
        add_immutable('baseline_repository', ROOT, rel, item)
for item in pre['installMetadata']:
    if 'missing' not in item:
        rel = pathlib.Path(item['path']).relative_to(AUTHOR).as_posix()
        add_immutable('author_worktree', AUTHOR, rel, item)

for tree_name in ('betterSqlite3', 'betterSqlite3Types', 'nodeAddonApi'):
    tree = pre['packageTrees'][tree_name]
    package_root = pathlib.Path(tree['root'])
    for entry in tree['entries']:
        target = package_root / entry['path']
        if entry['type'] == 'file':
            rel = target.relative_to(AUTHOR).as_posix()
            add_immutable('author_worktree', AUTHOR, rel, entry)
        elif entry['type'] == 'symlink':
            raw = target.read_bytes()
            rel = target.relative_to(AUTHOR).as_posix()
            add_immutable('author_worktree', AUTHOR, rel, {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})

dist_root = pathlib.Path(pre['compiledTree']['root'])
for entry in pre['compiledTree']['entries']:
    if entry['type'] == 'file':
        rel = (dist_root / entry['path']).relative_to(AUTHOR).as_posix()
        add_immutable('author_worktree', AUTHOR, rel, entry)

node_exe = pathlib.Path(pre['runtime']['executableFile']['path'])
add_immutable('baseline_repository', ROOT, node_exe.relative_to(ROOT).as_posix(), pre['runtime']['executableFile'])

artifacts = []
for path in sorted(REVIEW.rglob('*')):
    if not path.is_file() or path.name == 'review-final.json':
        continue
    artifacts.append(inventory('review_directory', REVIEW, path.relative_to(REVIEW)))

negative_counts = {
    'readonly_missing_database_no_sidecars': all(not row['exists'] for row in negative['cases']['readonlyMissing']['filesBeforeAndAfter']),
    'unsafe_integer_read_rejected': negative['cases']['unsafeStoredInteger']['readObservationsError']['code'] == 'CORRUPT_STORE' and negative['cases']['unsafeStoredInteger']['queryReceiptError']['code'] == 'CORRUPT_STORE',
    'duplicate_ack_loss_reconciled': negative['cases']['duplicateAckLoss']['afterCommittedDuplicateAckLoss']['status'] == 'unknown' and negative['cases']['duplicateAckLoss']['retry']['status'] == 'duplicate' and negative['cases']['duplicateAckLoss']['countsAfterReopen'] == {'facts': 1, 'observations': 1},
}
assert all(negative_counts.values())

report = {
    'schema': 'p02-independent-review/v1',
    'decision': 'pass',
    'review_target': {
        'author_commit': AUTHOR_COMMIT,
        'baseline_commit': BASELINE_COMMIT,
        'author_worktree': str(AUTHOR),
    },
    'attempt': '20261004-02-independent',
    'author_manifest_sha256': MANIFEST_SHA,
    'artifacts': artifacts,
    'immutable_inputs': sorted(immutable.values(), key=lambda x: (x['root'], x['path'])),
    'checks': [
        {'id': 'frozen_author_manifest', 'status': 'pass', 'details': 'Independent verify-author passed: exact frozen HEAD, clean author worktree, 48 content files, 49 changed paths, manifest SHA matches, disk/Git mismatches empty.'},
        {'id': 'scope_and_public_contract', 'status': 'pass', 'details': 'All 49 changed paths fit the registered events, root dependency/lock, recovery-test, and evidence scopes. EventStore public interface and v1 migration are unchanged; backup production source is byte-identical to baseline.'},
        {'id': 'mature_binding_and_precision', 'status': 'pass', 'details': 'Pinned better-sqlite3 13.0.3 loaded on fixed Windows Node 24.14.0; independent safe-integer persisted-row negative returns CORRUPT_STORE on both readObservations and queryReceipt.'},
        {'id': 'fresh_fixed_runtime_typecheck', 'status': 'pass', 'details': 'Direct fixed Node 24.14.0 TypeScript --noEmit command exited 0.'},
        {'id': 'fresh_fixed_runtime_build', 'status': 'pass', 'details': 'Direct fixed Node 24.14.0 TypeScript build exited 0; dist file count, bytes, and aggregate SHA match before, after build, and after tests.'},
        {'id': 'fresh_targeted_product_tests', 'status': 'pass', 'details': 'Direct fixed Node 24.14.0 tools/run-tests.mjs unit P02-U05 P02-U07 exited 0: 26/26 (events 14, recovery 12). Author fixed-runtime full-unit record separately reports 159/159; reviewer did not rerun the full suite.'},
        {'id': 'independent_product_negative_cases', 'status': 'pass', 'details': 'Reviewer-owned DBs prove readonly missing path creates no DB/WAL/SHM; exact unsafe stored integer fails read/query as CORRUPT_STORE; actual duplicate COMMIT ACK loss returns UNKNOWN_COMMIT, receipt reconciles, retry is duplicate, and reopen retains one fact and one observation.'},
        {'id': 'input_and_runtime_stability', 'status': 'pass', 'details': 'Pre/post fixed Node binary, loaded native addon, Better SQLite/@types/node-addon-api package trees, package/lock/install metadata, listed author/root inputs, and author/root Git state are unchanged.'},
        {'id': 'core_import_boundary', 'status': 'not_run', 'details': 'Author fixed-runtime command records BOUNDARY_SCAN_NOT_RUN because packages/core is absent; this review does not claim Core import coverage.'},
        {'id': 'backup_and_g02_scope', 'status': 'pass', 'details': 'packages/storage/backup/src/index.ts is unchanged and still imports Node DatabaseSync. U08 and G02 are not covered by this U05 acceptance.'},
    ],
    'limitations': [
        'All reviewer fixtures are synthetic. Controlled worker termination tests process-kill behavior, not physical power loss or hardware failure.',
        'The fixed-runtime tests emit Node builtin SQLite ExperimentalWarning from the explicit cross-binding compatibility test; production event-store source uses the mature binding.',
        'No packaged Electron cold-start or non-Windows native-addon validation was performed.',
        'The boundary scanner reports NOT_RUN because packages/core is absent.',
        'U08 backup migration and G02 remain out of scope.',
    ],
}
out = REVIEW / 'review-final.json'
out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'report': str(out), 'artifacts': len(artifacts), 'immutable_inputs': len(report['immutable_inputs']), 'manifest_sha256': MANIFEST_SHA, 'decision': report['decision']}, ensure_ascii=False))

