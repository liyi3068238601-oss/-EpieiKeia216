"""Read-only verification of the committed U06 pause checkpoint."""
import argparse
import hashlib
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--root', default=r'E:\Xiadie\Xiadie')
args = parser.parse_args()
root = pathlib.Path(args.root).resolve()
git = lambda *a: subprocess.check_output(['git', *a], cwd=root)
sha = lambda b: hashlib.sha256(b).hexdigest()
checkpoint_dir = root / 'evidence/P01/checkpoints/U06'
manifest_path = checkpoint_dir / 'manifest.json'
manifest_bytes = manifest_path.read_bytes()
sidecar = (checkpoint_dir / 'manifest.sha256').read_text(encoding='utf-8').split()[0]
assert sha(manifest_bytes) == sidecar, 'Manifest digest mismatch'
manifest = json.loads(manifest_bytes)
head = git('rev-parse', 'HEAD').decode().strip()
anchor = git('rev-parse', 'p01-pause-u06').decode().strip()
assert head == anchor, 'HEAD differs from pause bookmark'
assert not git('status', '--porcelain').strip(), 'Worktree has uncommitted changes'
for entry in manifest['files']:
    path = root / entry['path']
    assert path.resolve().is_relative_to(root)
    disk = path.read_bytes()
    blob = git('show', f"{head}:{entry['path']}")
    assert len(disk) == entry['bytes'] and sha(disk) == entry['sha256'], entry['path']
    assert disk == blob, f"Disk/Git mismatch: {entry['path']}"
for filename in ['manifest.json', 'manifest.sha256']:
    path = checkpoint_dir / filename
    assert path.read_bytes() == git('show', f"{head}:{path.relative_to(root).as_posix()}")
state = json.loads((root / 'evidence/P01/status.json').read_bytes())
assert state['stage_status'] == 'paused' and state['next_task'] == 'P01-U07'
assert state['G01'] == 'pending' and state['next_stage_started'] is False
assert [t['status'] for t in state['tasks'][:6]] == ['accepted'] * 6
assert all(t['status'] == 'not_started' for t in state['tasks'][6:])
assert state['model_authorization']['generation_calls_made'] == 4
author = manifest['u06_author_commit']
author_manifest_path = 'evidence/P01-U06/20261002-01/manifest.json'
author_manifest = json.loads(git('show', f'{author}:{author_manifest_path}'))
entries = author_manifest.get('files', author_manifest.get('entries'))
assert len(entries) == 162
for entry in entries:
    blob = git('show', f"{author}:{entry['path']}")
    assert len(blob) == entry['bytes'] and sha(blob) == entry['sha256']
    assert git('rev-parse', f"{author}:{entry['path']}").decode().strip() == entry['gitBlobSha1']
    assert (root / entry['path']).read_bytes() == blob
print(json.dumps({'status': 'pass', 'head': head, 'bookmark': 'p01-pause-u06',
    'checkpoint_files_verified_disk_and_git': len(manifest['files']),
    'author_files_verified_disk_and_git': len(entries), 'worktree_clean': True,
    'stage': 'paused', 'next_task': 'P01-U07', 'G01': 'pending'}, ensure_ascii=False))
