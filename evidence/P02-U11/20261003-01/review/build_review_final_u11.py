from pathlib import Path
import hashlib, json
ROOT=Path(r'E:\Xiadie\Xiadie')
WT=ROOT/r'.runtime/P02/worktrees/u11'
REVIEW=ROOT/r'.runtime/P02/reviews/u11'
EV=Path('evidence/P02-U11/20261003-01')
OUT=REVIEW/'review-final.json'
if OUT.exists(): raise SystemExit('refusing to overwrite review-final.json')
artifacts=[]; seen=set()
def add(root, rel):
    bases={'author_worktree':WT,'review_directory':REVIEW,'baseline_repository':ROOT}
    if root not in bases: raise ValueError(root)
    rel=Path(rel)
    if rel.is_absolute(): raise ValueError(('expected relative path',str(rel)))
    file=(bases[root]/rel).resolve()
    if not file.is_file(): raise FileNotFoundError(file)
    key=str(file).casefold()
    if key in seen: return
    data=file.read_bytes()
    artifacts.append({'root':root,'path':rel.as_posix(),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    seen.add(key)

def author(*paths):
    for p in paths: add('author_worktree',EV/p if isinstance(p,str) else p)

# Author's exact scope, source mapping, freeze, and bound proof index.
author('baseline.json','manifest.json','diff.json','command-index.json','prerequisite-audit.json','result.md','source-decision.md','rollback.md','candidate-proof-index.json','candidate-proof/candidate-descriptor.json','commands/01-prerequisite-audit.json','commands/02-source-build.json','commands/tests-01-inputs-before.json','commands/tests-02-inputs-after.json','candidate-proof/commands/01-build.json','candidate-proof/commands/02-build-final.json','candidate-proof/commands/03-desktop-full.json','candidate-proof/commands/04-desktop-degradation.json','candidate-proof/runs/full/summary.json','candidate-proof/runs/degradation/summary.json')
# Bind every scenario summary/UI/ledger report while the proof index independently covers all 135 archived files.
for suite in ('full','degradation'):
    summary=json.loads((WT/EV/'candidate-proof/runs'/suite/'summary.json').read_bytes())
    for scenario in summary['scenarios']:
        sid=scenario['scenario_id']
        base=EV/'candidate-proof/runs'/suite/'scenarios'/sid
        for name in ('ui-result.json','scenario-result.json','ledger-verification.json','ledger-verification.command.json'):
            add('author_worktree',base/name)

for rel in [
    'docs/releases/0.2.0/README.md','docs/releases/0.2.0/freeze.json',
    'package.json','README.md','docs/sources.lock.json','docs/evals/P02/requirement-evidence.md',
    'planning/Xiadie_V2_v1.1/PACKAGE_MANIFEST.json','planning/Xiadie_V2_v1.1/tasks/P02-U11.md',
    'migrations/001-event-store.ts','assets/manifest.json','assets/character/xiadie/v3/manifest.json',
    'assets/character/xiadie/v3/persona.json',
    'tests/integration/P02/build-candidate.mjs','tests/integration/P02/desktop.py',
    'tests/integration/P02/desktop-ui.mjs','tests/integration/P02/verify-ledger.mjs',
]: add('author_worktree',rel)

# Independent review scripts, all command logs (including corrected helper failures), and fresh readbacks.
for f in sorted((REVIEW/'commands').glob('*.json')): add('review_directory',f.relative_to(REVIEW))
for f in sorted(REVIEW.glob('*.py')): add('review_directory',f.relative_to(REVIEW))
for f in sorted((REVIEW/'ledger-readback-final').glob('*.json')): add('review_directory',f.relative_to(REVIEW))
add('review_directory','author-manifest-verification.json')

# Canonical prerequisites and immutable planning inputs independently rehashed by the review command.
status=json.loads((WT/'evidence/P02/status.json').read_bytes())
audit=json.loads((WT/EV/'prerequisite-audit.json').read_bytes())
for rel in ('evidence/P02/status.json','planning/Xiadie_V2_v1.1/PACKAGE_MANIFEST.json','docs/sources.lock.json','planning/Xiadie_V2_v1.1/tasks/P02-U11.md'):
    add('author_worktree',rel)
for item in audit['accepted_prerequisites']:
    add('author_worktree',item['acceptance']['path'])
    add('author_worktree',item['review']['path'])
add('author_worktree',audit['historical_g01']['path'])

# Physical candidate and the pinned upstream/license payload it qualifies.
freeze=json.loads((WT/'docs/releases/0.2.0/freeze.json').read_bytes())
candidate=Path(freeze['candidate_root'])
for path in [candidate/'candidate-descriptor.json',candidate/'UPSTREAM-LICENSE',candidate/'apps/zcode-cli/packages/cli/dist/zcode.cjs',candidate/'apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md',candidate/'xiadie/assets/manifest.json',candidate/'xiadie/assets/character/xiadie/v3/manifest.json',candidate/'xiadie/assets/character/xiadie/v3/persona.json']:
    add('baseline_repository',path.relative_to(ROOT))
add('baseline_repository',Path(r'.runtime/P01/desktop-source/LICENSE'))
# The frozen verifier implementation used for the declared candidate check and its known U10 template.
add('baseline_repository',Path(r'.runtime/P02/worktrees/u10/tests/integration/P01/desktop.py'))
add('baseline_repository',Path(r'.runtime/P02/reviews/u10/verify_desktop_readbacks_final.py'))

# The independent scripts themselves are part of the report's byte/SHA bindings.
add('review_directory','build_review_final_u11.py')

report={
 'schema':'p02-independent-review/v1',
 'decision':'pass',
 'task':'P02-U11',
 'review_target':{
   'author_commit':'ead4b6bff78250ae9a538819062fd7cb00bd4113',
   'baseline_commit':'8620d00eecec67d0884efa8d211242acb21eb1c8',
   'author_worktree':str(WT),
 },
 'reviewer':'p02_u11_independent',
 'scope':'Exact-commit independent G02 gate review and local 0.2.0 candidate qualification: canonical prerequisites, immutable plan, candidate build/source/inputs, proof archive and actual SQLite receipts. No production, installation, publication, or next-stage acceptance.',
 'checks':[
  {'id':'exact-target-manifest-and-metadata-scope','status':'pass','detail':'verify-author confirms clean exact HEAD ead4b6bff78250ae9a538819062fd7cb00bd4113 against baseline 8620d00eecec67d0884efa8d211242acb21eb1c8: 153 manifest files/154 changed paths, manifest SHA-256 cf1ea04d6d59a54ec838c0336ed16845a7bb53530f41b3180e9870bb424f879d, zero Git/disk mismatches. The bounded changes are root version/e2e entry, README, U11 evidence and 0.2.0 freeze docs; candidate build commit e3d15af210ee6df3871bc6c10b99a093817db819 is explicitly distinguished from this later evidence commit.'},
  {'id':'canonical-prerequisites-and-plan','status':'pass','detail':'Independent byte/hash verification matches all ten canonical P02-U01..U10 accepted acceptance/review records and author commits, validates the unchanged source lock and U11 card, and rehashes all 423 files in PACKAGE_MANIFEST.json with zero mismatches.'},
  {'id':'candidate-build-and-release-binding','status':'pass','detail':'The frozen P01 verify_candidate helper independently verified candidate-01: descriptor SHA-256 e1b7b4fed3a910b709c89d2d9f5f861027b0394eb5236a3eeeac69b67e642d47, build commit e3d15af210ee6df3871bc6c10b99a093817db819, pinned source 29628c9acdb81b703bbd4080c207a0e7ce5e276e, all 6,689 declared artifacts and 94 repository inputs. Release freeze counts, descriptor/CLI, source lock, proof index, command index, generator snapshot, execution bindings, and all six theme-group file lists/hashes were independently recomputed; the document explicitly says groups may overlap and repositoryInputs is the complete declared material-input index.'},
  {'id':'actual-desktop-proof-and-ledger-readback','status':'pass','detail':'Actual candidate-01 full suite is 6/6 and degradation is 3/3; every scenario UI and ledger report passes, production/execution are unchanged, DSH stayed off, and real/external model calls are zero. Independent verification found all 135 proof-archive copies byte-identical to retained originals, then performed nine fresh read-only scenario-state SQLite checks. No-Key is not admitted with zero turns/facts/model requests; disabled Native has no ledger/admission; Pro-denied retains a refusal record with zero facts. The nine checks are not represented as nine physical databases.'},
  {'id':'execution-input-stability','status':'pass','detail':'Author pre/post execution-input reports bind 135 inputs, including static migration, to the same digest 206b4aec3679a3825fc08983c45f320dd94d99555c32cf2f0c459fbd0dd3b5a2; independently confirmed both byte/hash bindings and unchanged flag.'},
  {'id':'g02-source-recovery-and-failure-boundary','status':'pass','detail':'Prior accepted U03-U10 contracts plus this actual Electron UI/fixed-Node CLI/SQLite candidate support source/event/receipt provenance, recovery of committed facts and refusal to fabricate admission/history under no-Key, disabled, or denied cases. Current raw-source validation remains explicitly NOT_VERIFIED; the freeze does not claim full transcript or original-message recovery.'},
  {'id':'license-and-limitations','status':'pass','detail':'Candidate UPSTREAM-LICENSE matches the pinned P01 Apache-2.0 LICENSE; the descriptor-bound Third-Party Notices are present and hashed. Asset manifest is research_only with zero approved assets; persona manifest limits authorization to a local user-approved adaptation and does not assert public distribution rights. README/freeze accurately bound the local development assembly and unverified support areas.'},
 ],
 'limitations':[
  'Qualification is for a local development assembly with borrowed pinned dependencies, not a hermetic portable closure, installer, public release, or full dependency closure. No public character-asset rights are asserted.',
  'Desktop tests use owned profiles and synthetic loopback fixtures; no paid/external model call or real credential was used. SQLite is in the fixed Node CLI protocol process, not Electron main. Human visual acceptance, installed production behavior, physical power-loss/disk-failure behavior, and real external model routing were not tested.',
  'Source provenance retains historical hashes/locators, but current raw-source validation is NOT_VERIFIED. The fully masked current UserPromptSubmit capture is not a complete transcript/history. Diagnostics turnSeal remains unavailable and scans are bounded.',
  'The first candidate build attempt failed because its owned parent directory did not exist (ENOENT); that failure is retained. Creating the owned parent allowed the final build and actual full/degradation suites to pass; the failed record was not overwritten.',
  'Two reviewer-owned release-text assertions were too literal: one Chinese assertion was corrupted in the generated helper text, and one checked for the English phrase “portable/public release” in the README where the equivalent is Chinese. Both logs are preserved; corrected checks against the freeze qualification and README boundaries pass. These review-only assertions did not touch author or candidate files.',
 ],
 'artifacts':artifacts,
 'immutable_inputs':[
   {'root':'author_worktree','path':'evidence/P02/status.json','bytes':0,'sha256':''},
 ],
}
# Materialize immutable_inputs bindings and replace the placeholder status entry.
def binding(root,rel):
    file=(ROOT/r'.runtime/P02/worktrees/u11'/rel).resolve(); data=file.read_bytes()
    return {'root':root,'path':Path(rel).as_posix(),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
immutable=[binding('author_worktree','evidence/P02/status.json'),binding('author_worktree','planning/Xiadie_V2_v1.1/PACKAGE_MANIFEST.json'),binding('author_worktree','docs/sources.lock.json')]
for item in audit['accepted_prerequisites']:
    immutable.append(binding('author_worktree',item['acceptance']['path']))
    immutable.append(binding('author_worktree',item['review']['path']))
immutable.append(binding('author_worktree',audit['historical_g01']['path']))
report['immutable_inputs']=immutable
OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'report':str(OUT),'decision':report['decision'],'artifacts':len(artifacts),'immutable_inputs':len(immutable),'sha256':hashlib.sha256(OUT.read_bytes()).hexdigest()},ensure_ascii=False))
