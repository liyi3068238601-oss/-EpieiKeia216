"""Coordinator receipt for independently reviewed P00-U01 research."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ATTEMPT = ROOT / 'evidence/P00-U01/20261001-01'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

review_path = ATTEMPT / 'review-final.json'
assert digest(review_path) == 'e3809dbae1bebc2a292731fd92688ea2d48149b1fbe6f2c14dcbfd20e4e78556'
review = json.loads(review_path.read_text(encoding='utf-8-sig'))
assert review['all_three_reviews_accepted_and_current_bindings_match'] is True
assert digest(ROOT / review['result']['path']) == review['result']['sha256']
bindings = []
for section in review['section_reviews']:
    assert digest(ROOT / section['review_path']) == section['review_sha256']
    for key in ('report', 'sources'):
        item = section[key]
        assert digest(ROOT / item['path']) == item['expected_sha256']
        bindings.append({'path': item['path'], 'sha256': item['expected_sha256']})

receipt = {
    'task_id': 'P00-U01', 'attempt_id': '20261001-01', 'status': 'accepted',
    'coordinator': 'root', 'accepted_at': '2026-10-01',
    'scope': 'R03 static source research and isolated execution preparation only',
    'final_independent_review': {'path': review['result']['path'].replace('result.md', 'review-final.json'), 'sha256': digest(review_path)},
    'verified_current_bindings': bindings,
    'limitations': ['Historical Library originals unavailable; v1.1 archive remains authority.', 'Runtime compatibility, model generation and Windows package tests not accepted by this receipt.'],
    'next_task': 'P00-U02',
}
(ATTEMPT / 'acceptance.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
status_path = ROOT / 'evidence/P00/status.json'
status = json.loads(status_path.read_text(encoding='utf-8-sig'))
status['tasks'][0]['status'] = 'accepted'
status['tasks'][1]['status'] = 'running'
status['tasks'][1]['attempt_id'] = '20261001-01'
status['current_task'] = 'P00-U02'
status_path.write_text(json.dumps(status, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('P00-U01 accepted after current hash binding verification; P00-U02 running.')
