import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [rootArg, commit, expectedManifestSha] = process.argv.slice(2);
if (!rootArg || !commit || !expectedManifestSha) throw new Error('usage: manifest-audit.mjs <repo-root> <commit> <manifest-sha256>');
const root = path.resolve(rootArg);
const attempt = 'evidence/P01-U05/20261001-01';
const manifestPath = `${attempt}/manifest.json`;
const sidecarPath = `${attempt}/manifest.sha256`;
const expectedBaseline = '01f3f8700ada91ef6756a184fe5ea029d432f530';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (args, encoding = null) => execFileSync('git', ['-C', root, ...args], { encoding, maxBuffer: 128 * 1024 * 1024 });
const errors = [];
const checks = {};
const manifestBytes = fs.readFileSync(path.join(root, manifestPath));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const manifestSha = hash(manifestBytes);
const sidecarText = fs.readFileSync(path.join(root, sidecarPath), 'utf8').trim();
const sidecarSha = sidecarText.split(/\s+/)[0];
checks.manifestSha256 = { actual: manifestSha, expected: expectedManifestSha, sidecar: sidecarSha, pass: manifestSha === expectedManifestSha && sidecarSha === manifestSha };
if (!checks.manifestSha256.pass) errors.push('manifest JSON digest or sidecar mismatch');

const head = git(['rev-parse', 'HEAD'], 'utf8').trim();
const branch = git(['branch', '--show-current'], 'utf8').trim();
const status = git(['status', '--porcelain=v1'], 'utf8').trim();
checks.frozenWorktree = { head, expectedCommit: commit, branch, clean: status.length === 0, pass: head === commit && branch === 'p01-u05' && status.length === 0 };
if (!checks.frozenWorktree.pass) errors.push('review worktree is not clean at the frozen target commit');

const authorCommitField = manifest.author_commit ?? null;
checks.manifestBinding = { task_id: manifest.task_id, attempt_id: manifest.attempt_id, baseline_commit: manifest.baseline_commit, author_commit_field: authorCommitField, declared_files: manifest.files?.length ?? 0, pass: manifest.task_id === 'P01-U05' && manifest.attempt_id === '20261001-01' && manifest.baseline_commit === expectedBaseline && Array.isArray(manifest.files) };
if (!checks.manifestBinding.pass) errors.push('manifest metadata does not match P01-U05 frozen baseline');
if (authorCommitField && authorCommitField !== commit) errors.push('manifest author_commit field does not match frozen commit');

const declared = new Map((manifest.files ?? []).map((entry) => [entry.path, entry]));
if (declared.size !== (manifest.files ?? []).length) errors.push('duplicate manifest paths');
const changed = git(['diff', '--name-only', '-z', expectedBaseline, commit]).toString('utf8').split('\0').filter(Boolean).sort();
const excludedManifestFiles = new Set([manifestPath, sidecarPath]);
const changedBound = changed.filter((p) => !excludedManifestFiles.has(p));
const declaredPaths = [...declared.keys()].sort();
const allChangedBoundMatch = changedBound.length === declaredPaths.length && changedBound.every((p, i) => p === declaredPaths[i]);
checks.changedPathBinding = { changed_paths: changed.length, excluded_manifest_sidecars: changed.length - changedBound.length, manifest_bindings: declaredPaths.length, changed_paths_excluding_manifest_match_bindings: allChangedBoundMatch, pass: allChangedBoundMatch };
if (!allChangedBoundMatch) errors.push('changed path set differs from manifest bindings');

const unexpected = changed.filter((p) => {
  if (p === 'packages/contracts/src/context.ts' || p === 'packages/contracts/src/index.ts' || p === 'tools/run-tests.mjs' || p === 'tsconfig.json') return false;
  if (p.startsWith('packages/context/')) return false;
  if (p.startsWith(`${attempt}/`)) return false;
  return true;
});
checks.scope = { unexpected_changed_paths: unexpected, no_reference_or_role_asset_copies: !changed.some((p) => p.startsWith('references/') || p.startsWith('assets/character/')), pass: unexpected.length === 0 && !changed.some((p) => p.startsWith('references/') || p.startsWith('assets/character/')) };
if (!checks.scope.pass) errors.push('out-of-scope change or reference/character asset path changed');

let diskByteMatches = 0;
let diskShaMatches = 0;
let diskGitBlobMatches = 0;
let diskFrozenBlobMatches = 0;
const mismatches = [];
for (const entry of manifest.files ?? []) {
  const abs = path.join(root, entry.path);
  let disk;
  try { disk = fs.readFileSync(abs); }
  catch (error) { mismatches.push({ path: entry.path, kind: 'disk_missing', message: String(error) }); continue; }
  const diskSha = hash(disk);
  const blobId = git(['rev-parse', '--verify', `${commit}:${entry.path}`], 'utf8').trim();
  const frozenBlob = git(['cat-file', 'blob', `${commit}:${entry.path}`]);
  if (disk.length === entry.bytes) diskByteMatches += 1;
  else mismatches.push({ path: entry.path, kind: 'byte_count', manifest: entry.bytes, disk: disk.length });
  if (diskSha === entry.sha256) diskShaMatches += 1;
  else mismatches.push({ path: entry.path, kind: 'sha256', manifest: entry.sha256, disk: diskSha });
  if (blobId === entry.git_blob) diskGitBlobMatches += 1;
  else mismatches.push({ path: entry.path, kind: 'manifest_git_blob', manifest: entry.git_blob, target: blobId });
  if (frozenBlob.length === disk.length && frozenBlob.equals(disk)) diskFrozenBlobMatches += 1;
  else mismatches.push({ path: entry.path, kind: 'disk_vs_frozen_git_blob', frozen_bytes: frozenBlob.length, disk_bytes: disk.length });
}
const diskCount = (manifest.files ?? []).length;
checks.fileContents = { count: diskCount, disk_byte_count_matches: diskByteMatches, disk_sha256_matches: diskShaMatches, declared_git_blob_matches: diskGitBlobMatches, disk_equals_frozen_git_blob: diskFrozenBlobMatches, mismatches, pass: mismatches.length === 0 && diskCount === diskByteMatches && diskCount === diskShaMatches && diskCount === diskGitBlobMatches && diskCount === diskFrozenBlobMatches };
if (!checks.fileContents.pass) errors.push('one or more bound files differ on disk or from target commit blobs');

const ancestorChecks = {};
for (const [name, ancestor] of [['P01-U03', 'cf407f278fea36fa7e1f48d154e0ae0720c1ef88'], ['P01-U04', '122d3028385469a3704249f8df17e013cf880456']]) {
  let pass = true;
  try { git(['merge-base', '--is-ancestor', ancestor, commit]); } catch { pass = false; }
  ancestorChecks[name] = { commit: ancestor, is_ancestor: pass };
  if (!pass) errors.push(`${name} accepted commit is not an ancestor of the target`);
}
checks.prerequisiteAncestry = { ...ancestorChecks, pass: Object.values(ancestorChecks).every((x) => x.is_ancestor) };

const planPath = 'planning/Xiadie_V2_v1.1/tasks/P01-U05.md';
const basePlan = git(['rev-parse', `${expectedBaseline}:${planPath}`], 'utf8').trim();
const targetPlan = git(['rev-parse', `${commit}:${planPath}`], 'utf8').trim();
checks.planUnchanged = { path: planPath, baseline_blob: basePlan, target_blob: targetPlan, pass: basePlan === targetPlan };
if (!checks.planUnchanged.pass) errors.push('author commit changed the planning baseline');

const result = { schema: 'p01-u05-independent-manifest-audit/v1', reviewed_commit: commit, result: errors.length === 0 ? 'pass' : 'fail', checks, errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;

