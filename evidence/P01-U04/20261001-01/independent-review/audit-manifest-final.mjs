import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = process.cwd();
const review = path.join(root, ".runtime", "P01", "review-u04");
const commit = "122d3028385469a3704249f8df17e013cf880456";
const baseline = "11c0cbc8248b7bb407458b3995057fd7881d708d";
const manifestRel = "evidence/P01-U04/20261001-01/manifest.json";
const sidecarRel = "evidence/P01-U04/20261001-01/manifest.sha256";
const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestRel), "utf8"));
const hash = (b) => createHash("sha256").update(b).digest("hex");
const git = (args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + String(r.stderr).trim());
  return r.stdout.trim();
};
const mismatches = [];
const seen = new Set();
const rootPrefix = path.resolve(root) + path.sep;
const details = [];

if (git(["rev-parse", commit + "^"]) !== baseline) mismatches.push({ kind: "parent", expected: baseline, actual: git(["rev-parse", commit + "^"]) });
if (!Array.isArray(manifest.files) || manifest.file_count !== 57 || manifest.files.length !== 57) {
  mismatches.push({ kind: "manifest-count", declared: manifest.file_count, actual: Array.isArray(manifest.files) ? manifest.files.length : null });
}
for (const item of manifest.files ?? []) {
  const rel = item.path;
  if (typeof rel !== "string" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || seen.has(rel)) {
    mismatches.push({ kind: "manifest-path", path: rel });
    continue;
  }
  seen.add(rel);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(rootPrefix)) {
    mismatches.push({ kind: "manifest-escape", path: rel });
    continue;
  }
  try {
    const bytes = fs.readFileSync(abs);
    const actualSha = hash(bytes);
    const localBlob = git(["hash-object", "--no-filters", "--", abs]);
    const commitBlob = git(["rev-parse", commit + ":" + rel]);
    details.push({ path: rel, bytes: bytes.length, sha256: actualSha, localBlob, commitBlob });
    if (bytes.length !== item.bytes || actualSha !== item.sha256) mismatches.push({ kind: "disk-manifest", path: rel, expectedBytes: item.bytes, actualBytes: bytes.length, expectedSha256: item.sha256, actualSha256: actualSha });
    if (localBlob !== commitBlob) mismatches.push({ kind: "git-blob", path: rel, localBlob, commitBlob });
  } catch (e) {
    mismatches.push({ kind: "read-or-git", path: rel, error: String(e) });
  }
}
const changed = git(["diff", "--name-only", "--no-renames", baseline, commit]).split(/\r?\n/).filter(Boolean);
const exclusions = new Set([manifestRel, sidecarRel]);
const expectedTargets = changed.filter((p) => !exclusions.has(p)).sort();
const actualTargets = [...seen].sort();
if (JSON.stringify(expectedTargets) !== JSON.stringify(actualTargets)) {
  mismatches.push({ kind: "manifest-completeness", changedCount: changed.length, expectedCount: expectedTargets.length, actualCount: actualTargets.length, missing: expectedTargets.filter((p) => !seen.has(p)), unexpected: actualTargets.filter((p) => !expectedTargets.includes(p)) });
}
for (const rel of [manifestRel, sidecarRel]) {
  const abs = path.join(root, rel);
  if (git(["hash-object", "--no-filters", "--", abs]) !== git(["rev-parse", commit + ":" + rel])) mismatches.push({ kind: "git-blob", path: rel });
}
const manifestSha = hash(fs.readFileSync(path.join(root, manifestRel)));
const sidecar = fs.readFileSync(path.join(root, sidecarRel), "utf8").trim();
const sidecarMatch = /^([0-9a-f]{64})\s+manifest\.json$/.exec(sidecar);
if (!sidecarMatch || sidecarMatch[1] !== manifestSha) mismatches.push({ kind: "manifest-sidecar", expected: manifestSha, actual: sidecar });

const sourceRel = "docs/research/P01/persona-from-mofox-v3.md";
const sourceBytes = fs.readFileSync(path.join(root, sourceRel));
const sourceSha = hash(sourceBytes);
const sourceBlob = git(["hash-object", "--no-filters", "--", path.join(root, sourceRel)]);
const sourceCommitBlob = git(["rev-parse", commit + ":" + sourceRel]);
const persona = JSON.parse(fs.readFileSync(path.join(root, "assets/character/xiadie/v3/persona.json"), "utf8"));
const sourceLines = sourceBytes.toString("utf8").split(/\r?\n/);
const sectionMarkers = {
  identity: "### 身份",
  voice: "### 表达",
  values: "### 性格与价值",
  boundaries: "### 边界与事实",
  canon: "### 少量背景细节",
  examples: "## 虚构风格示例",
};
function extractSection(marker) {
  const start = sourceLines.indexOf(marker);
  if (start < 0) return null;
  let end = start + 1;
  while (end < sourceLines.length && !/^#{2,3} /.test(sourceLines[end])) end += 1;
  return sourceLines.slice(start + 1, end).join("\n").trim();
}
const sectionChecks = [];
for (const [name, marker] of Object.entries(sectionMarkers)) {
  const field = persona.fields?.[name];
  const expectedText = extractSection(marker);
  const equalText = expectedText !== null && field?.text === expectedText;
  sectionChecks.push({ field: name, sourceSection: marker.replace(/^#+ /, ""), exactTextMatch: equalText, utf8Bytes: field && typeof field.text === "string" ? Buffer.byteLength(field.text, "utf8") : null, sourcePath: field?.source?.path ?? null, sourceSha256: field?.source?.sha256 ?? null, license: field?.license ?? null, fiction: field?.fiction ?? null });
  if (!equalText) mismatches.push({ kind: "source-extraction", field: name, markerFound: expectedText !== null });
}
if (sourceSha !== "d17b290e585cc8954321e4a0e6881823dcd221e6dff8e82223a506090ab3433f" || sourceBlob !== sourceCommitBlob) mismatches.push({ kind: "approved-source-hash", expected: "d17b290e585cc8954321e4a0e6881823dcd221e6dff8e82223a506090ab3433f", actual: sourceSha, sourceBlob, sourceCommitBlob });
const consentMarkers = ["用户已明确选择采用这一精简版", "本地使用", "不声明这些设定为本项目原创", "不声明已取得公开发行所需的角色权利", "尚未向官方资料逐条核验", "以下是本次新写的表达样本"];
const consentChecks = consentMarkers.map((phrase) => ({ phrase, found: sourceLines.join("\n").includes(phrase) }));
if (consentChecks.some((x) => !x.found)) mismatches.push({ kind: "source-rights-disclosure", failed: consentChecks.filter((x) => !x.found).map((x) => x.phrase) });

const output = {
  schema: "p01-u04-review-manifest/v1",
  commit,
  baseline,
  manifest: { declaredFiles: manifest.file_count, enumeratedFiles: manifest.files.length, changedFiles: changed.length, authorChangedTargetsCovered: expectedTargets.length, verifiedDiskAndGitBlobs: details.length, manifestSha256: manifestSha, sidecarMatches: sidecarMatch?.[1] === manifestSha },
  approvedSource: { path: sourceRel, sha256: sourceSha, localGitBlobMatchesCommit: sourceBlob === sourceCommitBlob, sixFieldsExtractExactly: sectionChecks.every((x) => x.exactTextMatch), fields: sectionChecks, localUseAndFictionDisclosures: consentChecks },
  mismatches,
  result: mismatches.length === 0 ? "pass" : "needs_changes"
};
fs.writeFileSync(path.join(review, "manifest-verification.json"), JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(output, null, 2));
if (mismatches.length !== 0) process.exitCode = 1;