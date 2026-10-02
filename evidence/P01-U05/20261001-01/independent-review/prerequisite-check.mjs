import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const repo = 'E:/Xiadie/Xiadie';
const worktree = path.resolve(process.argv[2]);
const target = '96457a2ef13e697e1877bcf23deb79578422a08e';
const rel = 'evidence/P01-U04/20261001-01/acceptance.json';
const expectedSha = '2b9a858886656c7fa38af0fd6d0da600948a32d05bcc4575be978c942f5700cf';
const expectedBlob = 'ad5269115d941a9b56858ace2cab4c3d183130df';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const frozen = execFileSync('git', ['-C', worktree, 'cat-file', 'blob', `${target}:${rel}`], { maxBuffer: 8 * 1024 * 1024 });
const blob = execFileSync('git', ['-C', worktree, 'rev-parse', '--verify', `${target}:${rel}`], { encoding: 'utf8' }).trim();
const wt = fs.readFileSync(path.join(worktree, rel));
const main = fs.readFileSync(path.join(repo, rel));
const receipt = JSON.parse(wt.toString('utf8'));
const checks = {
  frozenCommit: target,
  record: { path: rel, bytes: wt.length, sha256: hash(wt), status: receipt.status, author_commit: receipt.author_commit },
  targetBlob: { git_blob: blob, frozen_bytes: frozen.length, frozen_sha256: hash(frozen) },
  worktree_equals_frozen_blob: wt.equals(frozen),
  main_equals_worktree: main.equals(wt),
  pass: wt.length === 3120 && hash(wt) === expectedSha && hash(frozen) === expectedSha && blob === expectedBlob && wt.equals(frozen) && main.equals(wt) && receipt.status === 'accepted' && receipt.author_commit === '122d3028385469a3704249f8df17e013cf880456',
};
console.log(JSON.stringify({ schema: 'p01-u05-prerequisite-verification/v1', checks }, null, 2));
if (!checks.pass) process.exitCode = 1;
