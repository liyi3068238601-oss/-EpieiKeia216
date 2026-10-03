import concurrent.futures, hashlib, json, os, pathlib, subprocess, sys
ROOT=pathlib.Path(r'E:\Xiadie\Xiadie')
WT=ROOT/'.runtime/P02/worktrees/u10'
BASE='da364514f78d486564b26d3973a66b821a937503'
HEAD='c894d0525b43cf0e3c47639b7246b4007b45114b'
SOURCE='7f947b3abc172aa2e8dc3614abec0679b0b8d24d'
NATIVE='29628c9acdb81b703bbd4080c207a0e7ce5e276e'
EV=WT/'evidence/P02-U10/20261003-01'
PROOF=EV/'candidate-proof'
CAND=ROOT/'.runtime/P02/experiments/u10/candidate-02'
EXPECTED_MANIFEST='eabeca1704f7806aab08b00834b482b7f21a3ceabf5515a29b8b2a9f869f4729'
EXPECTED_DESCRIPTOR='751d005573354d5f09aa676c2c306c744f1754432506915a08eb874a7e14cb45'

def git(args, data=None):
    p=subprocess.run(['git','-C',str(WT),*args],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
    return p.stdout

def sha(b): return hashlib.sha256(b).hexdigest()
def safe_rel(s):
    p=pathlib.PurePosixPath(s)
    if p.is_absolute() or '..' in p.parts or '\\' in s: raise AssertionError(f'unsafe relative path: {s}')
    return p

def ensure(cond,msg):
    if not cond: raise AssertionError(msg)

head=git(['rev-parse','HEAD']).decode().strip()
status=git(['status','--porcelain']).decode().strip()
ensure(head==HEAD,f'author HEAD mismatch: {head}')
ensure(not status,f'author worktree dirty: {status[:300]}')
manifest_path=EV/'manifest.json'
manifest_raw=manifest_path.read_bytes()
ensure(sha(manifest_raw)==EXPECTED_MANIFEST,'manifest SHA mismatch')
manifest=json.loads(manifest_raw)
ensure(manifest['task_id']=='P02-U10' and manifest['baseline_commit']==BASE,'manifest task/baseline mismatch')
ensure(manifest['manifest_excludes_itself'] is True,'manifest self-exclusion mismatch')
files=manifest['files']
ensure(len(files)==347,'manifest file count mismatch')
paths=[f['path'] for f in files]
ensure(len(paths)==len(set(paths)),'duplicate manifest path')
changed=set(git(['diff','--name-only','-z',BASE,HEAD]).decode('utf-8').split('\0'))-{''}
manifest_path_rel='evidence/P02-U10/20261003-01/manifest.json'
ensure(changed==set(paths)|{manifest_path_rel},f'changed path set mismatch: missing={sorted((set(paths)|{manifest_path_rel})-changed)[:5]} extra={sorted(changed-(set(paths)|{manifest_path_rel}))[:5]}')
ensure(len(changed)==348,'changed path count mismatch')
allowed=('docs/evals/P02/','tests/integration/P02/','evidence/P02-U10/20261003-01/')
for p in changed:
    ensure(p=='tools/run-tests.mjs' or p.startswith(allowed),f'out-of-scope changed path: {p}')
ensure(not any(p.startswith('tests/integration/P01/') for p in changed),'P01 test history changed')
# Bind every manifested disk file to its SHA-256 and actual Git blob ID.
manifest_mismatches=[]
for entry in files:
    rel=safe_rel(entry['path'])
    path=WT.joinpath(*rel.parts)
    raw=path.read_bytes()
    blob=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
    if len(raw)!=entry['bytes'] or sha(raw)!=entry['sha256'] or blob!=entry['git_blob']:
        manifest_mismatches.append(entry['path'])
ensure(not manifest_mismatches,f'manifest file/hash/blob mismatches: {manifest_mismatches[:12]}')
# Changed implementation scope stays in P02; the prior event-store migration is unchanged.
for rev in (BASE,HEAD):
    pass
migration_base=git(['show',f'{BASE}:migrations/001-event-store.ts'])
migration_head=git(['show',f'{HEAD}:migrations/001-event-store.ts'])
migration_disk=(WT/'migrations/001-event-store.ts').read_bytes()
ensure(migration_base==migration_head==migration_disk,'migrations/001-event-store.ts changed or disk differs')
# Candidate build descriptor and its full output-tree manifest.
desc_path=PROOF/'candidate-descriptor.json'
desc_raw=desc_path.read_bytes()
ensure(sha(desc_raw)==EXPECTED_DESCRIPTOR,'candidate descriptor SHA mismatch')
desc=json.loads(desc_raw)
ensure(desc['repositoryCommit']==SOURCE and desc['sourceCommit']==NATIVE,'candidate source/repository pin mismatch')
ensure(len(desc['repositoryInputs'])==94,'repository input count mismatch')
ensure(len(desc['artifacts'])==6689,'candidate artifact count mismatch')
source_is_ancestor=git(['merge-base','--is-ancestor',SOURCE,HEAD]) if False else None
subprocess.run(['git','-C',str(WT),'merge-base','--is-ancestor',SOURCE,HEAD],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
source_paths=[]
for item in desc['repositoryInputs']:
    rel=safe_rel(item['path'])
    raw=(WT.joinpath(*rel.parts)).read_bytes()
    blob=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
    if len(raw)!=item['bytes'] or sha(raw)!=item['sha256'] or git(['show',f'{SOURCE}:{item["path"]}'])!=raw:
        source_paths.append(item['path'])
ensure(not source_paths,f'candidate repository input mismatch: {source_paths[:10]}')
ensure(not any(a['path'].startswith('node_modules/') for a in desc['artifacts']),'candidate descriptor unexpectedly hashes borrowed node_modules')
artifact_paths=[a['path'] for a in desc['artifacts']]
ensure(len(artifact_paths)==len(set(artifact_paths)),'duplicate candidate artifact path')
def check_artifact(item):
    rel=safe_rel(item['path'])
    path=CAND.joinpath(*rel.parts)
    try:
        st=path.stat()
        if not path.is_file() or st.st_size!=item['bytes']:
            return item['path']
        h=hashlib.sha256()
        with path.open('rb') as f:
            for chunk in iter(lambda:f.read(4*1024*1024),b''): h.update(chunk)
        return None if h.hexdigest()==item['sha256'] else item['path']
    except OSError:
        return item['path']
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    mismatches=[p for p in pool.map(check_artifact,desc['artifacts']) if p]
ensure(not mismatches,f'candidate artifact mismatches: {mismatches[:12]}')
# The output tree may contain its self-excluding descriptor and the copied upstream license; no other unbound files.
actual=set()
for current,dirs,names in os.walk(CAND,followlinks=False):
    base=pathlib.Path(current)
    dirs[:]=[d for d in dirs if not (base/d).is_symlink()]
    for name in names:
        p=base/name
        if p.is_file(): actual.add(p.relative_to(CAND).as_posix())
listed=set(artifact_paths)
allowed_unlisted={p for p in ('candidate-descriptor.json',) if (CAND/p).is_file()}
extra=actual-listed-allowed_unlisted
missing=listed-actual
ensure(not extra and not missing,f'candidate tree coverage mismatch extra={sorted(extra)[:10]} missing={sorted(missing)[:10]}')
# Verify the 319 archived proof copies against their retained originals.
index=json.loads((EV/'candidate-proof-index.json').read_bytes())
ensure(index['task']=='P02-U10' and pathlib.Path(index['candidate'])==CAND,'proof index candidate mismatch')
archive_mismatches=[]
for item in index['artifacts']:
    rel=safe_rel(item['path'])
    archived=EV.joinpath(*rel.parts)
    original=pathlib.Path(item['original'])
    if not archived.is_file() or not original.is_file():
        archive_mismatches.append(item['path']); continue
    raw=archived.read_bytes()
    if len(raw)!=item['bytes'] or sha(raw)!=item['sha256'] or raw!=original.read_bytes():
        archive_mismatches.append(item['path'])
ensure(len(index['artifacts'])==319,'proof archive count mismatch')
ensure(not archive_mismatches,f'proof archive mismatches: {archive_mismatches[:12]}')
# Check fixed Native source identity and clean tracked/untracked state; bind copied license.
native_root=ROOT/'.runtime/P01/desktop-source'
native_head=subprocess.check_output(['git','-C',str(native_root),'rev-parse','HEAD']).decode().strip()
native_status=subprocess.check_output(['git','-C',str(native_root),'status','--porcelain']).decode().strip()
ensure(native_head==NATIVE and not native_status,f'Native source not fixed/clean: {native_head} {native_status[:200]}')
license_actual=(CAND/'UPSTREAM-LICENSE').read_bytes()
license_source=(native_root/'LICENSE').read_bytes()
ensure(license_actual==license_source,'upstream license copy differs from fixed Native LICENSE')
print(json.dumps({'result':'pass','author_commit':head,'baseline_commit':BASE,'worktree_clean':True,'manifest_sha256':sha(manifest_raw),'manifest_files_verified':len(files),'changed_paths_verified':len(changed),'out_of_scope_paths':0,'migration_001_sha256':sha(migration_disk),'candidate_descriptor_sha256':sha(desc_raw),'candidate_repository_inputs_verified':len(desc['repositoryInputs']),'candidate_artifacts_verified':len(desc['artifacts']),'candidate_tree_file_count':len(actual),'candidate_unlisted_files':sorted(extra),'candidate_proof_archive_entries_verified':len(index['artifacts']),'native_source_commit':native_head,'upstream_license_sha256':sha(license_actual)},ensure_ascii=False))
