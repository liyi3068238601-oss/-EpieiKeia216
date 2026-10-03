from pathlib import Path
import hashlib, json

root = Path(r'E:\Xiadie\Xiadie')
wt = root / r'.runtime\P02\worktrees\u10'
review = root / r'.runtime\P02\reviews\u10'
evidence = Path(r'evidence\P02-U10\20261003-01')
report_path = review / 'review-final.json'
if report_path.exists():
    raise SystemExit('review-final.json already exists; refusing to overwrite')

artifacts = []
seen = set()
def add(base_name, rel):
    p = Path(rel)
    bases = {'author_worktree': wt, 'review_directory': review, 'baseline_repository': root}
    if base_name not in bases or p.is_absolute():
        raise ValueError((base_name, rel))
    f = (bases[base_name] / p).resolve()
    key = str(f).casefold()
    if key in seen:
        return
    if not f.is_file():
        raise FileNotFoundError(f)
    raw = f.read_bytes()
    artifacts.append({'root': base_name, 'path': p.as_posix(), 'bytes': len(raw),
                      'sha256': hashlib.sha256(raw).hexdigest()})
    seen.add(key)

# Exact author target, source decision, full manifest and candidate proof index.
for rel in [
    evidence / 'manifest.json', evidence / 'baseline.json', evidence / 'diff.json',
    evidence / 'command-index.json', evidence / 'result.md', evidence / 'source-decision.md',
    evidence / 'candidate-proof-index.json', evidence / 'candidate-proof' / 'candidate-descriptor.json',
]:
    add('author_worktree', rel)

# Final actual Desktop summaries and preserved first/retry degradation summaries.
for suite in ('full', 'degradation', 'degradation-initial', 'degradation-retry'):
    add('author_worktree', evidence / 'candidate-proof' / 'runs' / suite / 'summary.json')

# Final Native matrix, unchanged pre/post input bindings, and accepted regression run.
for rel in [
    evidence / 'commands' / 'tests-07-final-native-matrix.json',
    evidence / 'commands' / 'tests-06-final-inputs-before.json',
    evidence / 'commands' / 'tests-08-final-inputs-after.json',
    evidence / 'commands' / '03-accepted-unit-regression.json',
    evidence / 'commands' / '01-build.json',
    evidence / 'commands' / '02-wrapper-syntax.json',
]:
    add('author_worktree', rel)

# Reviewed U10 source paths and compiled API contracts.
for rel in [
    'tests/integration/P02/durable-host.mjs',
    'tests/integration/P02/factory-entry.mjs',
    'tests/integration/P02/desktop.py',
    'tests/integration/P02/desktop-ui.mjs',
    'tests/integration/P02/verify-ledger.mjs',
    'tests/integration/P02/native.integration.test.mjs',
    'tests/integration/P02/native.worker.mjs',
    'tools/run-tests.mjs',
    'dist/packages/adapters/zcode/src/host.js',
    'dist/packages/storage/events/src/index.js',
    'dist/packages/contracts/src/events.js',
    'migrations/001-event-store.ts',
    'assets/manifest.json',
    'assets/character/xiadie/v3/manifest.json',
    'planning/Xiadie_V2_v1.1/tasks/P02-U10.md',
]:
    add('author_worktree', rel)

# Review commands, including retained helper failures, plus fresh SQLite readbacks.
add('review_directory', 'u10-independent-review-20261003-candidate01-and-driver-fix.md')
add('review_directory', 'author-manifest-verification.json')
add('review_directory', 'author-manifest-verification-post.json')
for f in sorted((review / 'commands').glob('*.json')):
    add('review_directory', f.relative_to(review))
for f in sorted((review / 'ledger-readback-final').glob('*.json')):
    add('review_directory', f.relative_to(review))
for f in sorted(review.glob('*.py')):
    if f.name != 'build-review-final.py':
        add('review_directory', f.relative_to(review))

# Actual final candidate-build/Desktop command records and pinned-source license boundary.
for rel in [
    '.runtime/P02/commands/u10-candidate/06-build-final.json',
    '.runtime/P02/commands/u10-candidate/07-final-desktop-full.json',
    '.runtime/P02/commands/u10-candidate/08-final-desktop-degradation.json',
    '.runtime/P02/commands/u10-tests/07-final-native-matrix.json',
    '.runtime/P01/desktop-source/LICENSE',
    '.runtime/P02/experiments/u10/candidate-02/candidate-descriptor.json',
    '.runtime/P02/experiments/u10/candidate-02/UPSTREAM-LICENSE',
    '.runtime/P02/experiments/u10/candidate-02/xiadie/assets/manifest.json',
    '.runtime/P02/experiments/u10/candidate-02/xiadie/assets/character/xiadie/v3/manifest.json',
]:
    add('baseline_repository', rel)

# Keep the provenance/licensing statements grounded in byte-identical copies.
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert sha(root / r'.runtime\P01\desktop-source\LICENSE') == sha(root / r'.runtime\P02\experiments\u10\candidate-02\UPSTREAM-LICENSE')
assert sha(wt / 'assets/manifest.json') == sha(root / r'.runtime\P02\experiments\u10\candidate-02\xiadie\assets\manifest.json')
assert sha(wt / 'assets/character/xiadie/v3/manifest.json') == sha(root / r'.runtime\P02\experiments\u10\candidate-02\xiadie\assets\character\xiadie\v3\manifest.json')
add('review_directory', 'build-review-final.py')

report = {
  'schema': 'p02-independent-review/v1',
  'decision': 'pass',
  'task': 'P02-U10',
  'review_target': {
    'author_commit': 'c894d0525b43cf0e3c47639b7246b4007b45114b',
    'baseline_commit': 'da364514f78d486564b26d3973a66b821a937503',
    'author_worktree': str(wt),
  },
  'reviewer': 'p02_u10_independent',
  'scope': 'Exact-commit independent qualification of the bounded P02-U10 Native durable host, candidate-02 build mapping, actual Desktop full/degradation evidence and SQLite receipt/readback. No product/upstream/P01 edits or public-release qualification.',
  'checks': [
    {'id':'exact-target-manifest-and-scope','status':'pass','detail':'verify-author independently confirms exact HEAD c894d0525b43cf0e3c47639b7246b4007b45114b, clean author worktree, 347 manifest files/348 changed paths, manifest SHA-256 eabeca1704f7806aab08b00834b482b7f21a3ceabf5515a29b8b2a9f869f4729, and zero disk/Git mismatches; pre and post checks agree. The source review found no critical scope, hook-correlation, durable-receipt, or close-order defect.'},
    {'id':'candidate-build-provenance','status':'pass','detail':'Frozen verify_candidate pre/post confirms candidate-02 descriptor SHA-256 751d005573354d5f09aa676c2c306c744f1754432506915a08eb874a7e14cb45, source commit 7f947b3abc172aa2e8dc3614abec0679b0b8d24d, pinned Native source 29628c9acdb81b703bbd4080c207a0e7ce5e276e, all 94 repository inputs and 6,689 declared physical artifacts; contract checks cover factory, recipe, CLI, protocol patch, provider config, Desktop paths and fixed Node v24.14.0. Post-build source/test drift is zero; only the allowed docs/evals/P02/requirement-evidence.md evidence update is outside candidate inputs.'},
    {'id':'native-integration-and-regression','status':'pass','detail':'Independent fixed Node v24.14.0 selector tools/run-tests.mjs integration P02-U10 exited 0: 8/8 passed, 0 failed/skipped, including backup/restore, actual tool and Native failures, cancellation, in-flight close, SQLite writer BUSY and recovery without replay. Author’s final pre/post Native input bindings match (132 inputs, digest 588e587c5d6580cdc1cbc4c43afcebedeeaa265899dbc0b33664151d2be3b964); accepted U03-U09 regression is 82/82.'},
    {'id':'actual-desktop-and-sqlite-readback','status':'pass','detail':'Candidate-02 final Desktop full suite is 6/6 and degradation suite 3/3; retained original run evidence and candidate-proof index bind the archived proof. Independent read-only verifier rechecked all 319 archived proof copies and freshly read back all 9 actual SQLite ledgers: every expected report passed. The no-Key case is not admitted, with zero turns and zero fact rows; it retains its ledger refusal record. Final suites report production/execution unchanged, DSH not started and zero external model calls.'},
    {'id':'durability-and-lifecycle-review','status':'pass','detail':'Reviewed durable-host against the compiled ZCode host, event-store and event-contract APIs. Native envelope identity and installed UserPromptSubmit correlation stay tied to the current run/attempt; capture is derived/masked; Saved follows commit plus matching persisted receipt/readback and is separate from Native outcome; close stops admission, aborts its owned work and awaits completion before Native/storage close.'},
    {'id':'license-and-asset-boundary','status':'pass','detail':'Candidate upstream license is byte-identical to the fixed P01 source LICENSE (Apache-2.0). Asset manifest remains research_only with zero approved assets; persona manifest says local user-approved adaptation and explicitly does not assert public distribution rights. This review grants no redistribution rights.'},
  ],
  'limitations': [
    'This is local candidate qualification only. It does not establish a portable/hermetic dependency closure (candidate borrows a node_modules junction/runtime), installed production use, full historical-data correctness, physical power-loss behavior, human visual acceptance, or public distribution clearance.',
    'Desktop scenarios use owned profiles and loopback fixtures; there were zero external/paid model calls and no real credentials. The durable host/SQLite qualification is in the CLI protocol process, not Electron main. Human visual review was not run.',
    'Earlier candidate-01 no-Key UI runs and their failures are retained. The P02-only driver repair accepts a Settings timeout only when the real Settings page is detached and workspace composer visible; candidate-02 full and degradation reruns passed. This DOM postcondition is not a human visual review.',
    'Three failed reviewer-helper attempts are retained in commands: an overbroad whole-candidate-tree assertion counted borrowed node_modules/runtime paths outside the declared descriptor boundary; an initial readback helper chose the wrong profile-root parent and failed before DB reads; an initial post-build helper rejected the permitted evidence-only docs/evals/P02/requirement-evidence.md update. The scope-appropriate frozen verifiers and corrected readback then passed; no author source or database was changed by those failures.',
  ],
  'artifacts': artifacts,
  'immutable_inputs': [],
}
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'report':str(report_path),'decision':report['decision'],'artifacts':len(artifacts),'sha256':hashlib.sha256(report_path.read_bytes()).hexdigest()}, ensure_ascii=False))
