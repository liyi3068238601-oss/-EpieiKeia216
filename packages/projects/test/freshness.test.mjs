import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hostRoot = "E:\\Xiadie\\Xiadie";
const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments", "u08");
mkdirSync(experimentRoot, { recursive: true });

// Git, SQLite, and Native path helpers operate only on owned synthetic fixtures.
const environmentRoot = mkdtempSync(path.join(experimentRoot, "freshness-env-"));
const syntheticHome = path.join(environmentRoot, "home");
const syntheticTemp = path.join(environmentRoot, "temp");
const syntheticAppData = path.join(syntheticHome, "AppData", "Roaming");
const syntheticLocalAppData = path.join(syntheticHome, "AppData", "Local");
mkdirSync(syntheticTemp, { recursive: true });
mkdirSync(syntheticAppData, { recursive: true });
mkdirSync(syntheticLocalAppData, { recursive: true });
const inherited = process.env;
const safeEnvironment = {};
for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
  if (typeof inherited[name] === "string") safeEnvironment[name] = inherited[name];
}
Object.assign(safeEnvironment, {
  HOME: syntheticHome,
  USERPROFILE: syntheticHome,
  APPDATA: syntheticAppData,
  LOCALAPPDATA: syntheticLocalAppData,
  TEMP: syntheticTemp,
  TMP: syntheticTemp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(environmentRoot, "disabled-global-git-config"),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, safeEnvironment);

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(testDirectory, "../../..");
const moduleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "freshness.js")).href;
const { FreshnessError, appendVerifiedRevision, assessFreshness, authorizeRevisionProposal,
  captureFreshnessSnapshot, revisionHistoryDigest } = await import(moduleUrl);

const nativeSourceRoot = path.join(hostRoot, ".runtime", "P01", "desktop-source");
const tsxApiUrl = pathToFileURL(path.join(nativeSourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href;
const { register: registerTsx } = await import(tsxApiUrl);
registerTsx();
const nativeMemoryRootUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "core", "dist", "memory", "project-root.js")).href;
const nativePathsUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "app", "paths.js")).href;
const [{ resolveProjectMemoryRoot }, { projectIdFromDirectory }] = await Promise.all([
  import(nativeMemoryRootUrl),
  import(nativePathsUrl),
]);
const registryModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "registry.js")).href;
const { openProjectRegistry } = await import(registryModuleUrl);

function fixture(label) {
  const root = mkdtempSync(path.join(experimentRoot, `${label}-`));
  const ownedDirectory = path.join(root, "owned-registry");
  const nativeStorageRoot = path.join(root, "native-cli");
  const noHooks = path.join(root, "empty-hooks");
  mkdirSync(ownedDirectory);
  mkdirSync(nativeStorageRoot);
  mkdirSync(noHooks);
  return { root, ownedDirectory, nativeStorageRoot, noHooks };
}

function git(f, cwd, args) {
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${f.noHooks}`,
    "-c", "user.name=P03 U08 Synthetic Author",
    "-c", "user.email=p03-u08@example.invalid",
    "-c", "commit.gpgSign=false",
    "-C", cwd,
    ...args,
  ], {
    cwd: f.root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
    throw new Error(`Synthetic Git command failed (${args.join(" ")}): ${detail}`);
  }
  return result.stdout.trim();
}

function openRegistry(f, t) {
  const registry = openProjectRegistry({
    ownedDirectory: f.ownedDirectory,
    nativeStorageRoot: f.nativeStorageRoot,
    nativeMemoryRootResolver: resolveProjectMemoryRoot,
    nativeRuntimeKeyResolver: projectIdFromDirectory,
  });
  t.after(() => registry.close());
  return registry;
}

function addProject(f, registry, name) {
  const workspacePath = path.join(f.root, "repos", name, "same-name");
  mkdirSync(workspacePath, { recursive: true });
  git(f, f.root, ["init", "--initial-branch=main", workspacePath]);
  mkdirSync(path.join(workspacePath, "docs"), { recursive: true });
  writeFileSync(path.join(workspacePath, "README.md"), "synthetic U08 project\n", "utf8");
  writeFileSync(path.join(workspacePath, "docs", "evidence.md"), "# Evidence v1\nRAW_EVIDENCE_V1\n", "utf8");
  git(f, workspacePath, ["add", "--all"]);
  git(f, workspacePath, ["commit", "-m", "synthetic U08 baseline"]);
  const mapping = registry.registerWorkspace({ workspacePath });
  return { workspacePath, mapping, evidencePath: path.join(workspacePath, "docs", "evidence.md") };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function expectFreshnessError(action, code) {
  assert.throws(action, error => error instanceof FreshnessError && error.code === code,
    `expected FreshnessError(${code})`);
}

async function expectFreshnessReject(action, code) {
  await assert.rejects(action, error => error instanceof FreshnessError && error.code === code,
    `expected FreshnessError(${code})`);
}

function observation(registry, project) {
  return captureFreshnessSnapshot({
    registry,
    workspacePath: project.workspacePath,
    evidencePaths: ["docs/evidence.md"],
  });
}

function registryMutatingBeforeSecondResolve(registry, mutate) {
  let calls = 0;
  return {
    registry: {
      resolveWorkspace(workspacePath) {
        calls += 1;
        if (calls === 2) mutate();
        return registry.resolveWorkspace(workspacePath);
      },
    },
    get calls() { return calls; },
  };
}

function commitFile(f, project, filename, content, message) {
  writeFileSync(path.join(project.workspacePath, filename), content, "utf8");
  git(f, project.workspacePath, ["add", filename]);
  git(f, project.workspacePath, ["commit", "-m", message]);
}

function createHistory(content = "Old experience lead; recheck before using.") {
  const noteId = "u08-note-synthetic-01";
  const revision = Object.freeze({
    revisionId: "u08-revision-0001",
    content,
    contentSha256: sha256(Buffer.from(content, "utf8")),
    authority: "experience-lead",
  });
  return Object.freeze({ noteId, revisions: Object.freeze([revision]) });
}

function createHistoryWithMetadata(snapshot) {
  const base = createHistory();
  const prior = base.revisions[0];
  return {
    ...base,
    metadata: { source: "synthetic-import", review: { labels: ["retained", "verified"], details: { sequence: 3 } } },
    revisions: [{
      ...prior,
      metadata: { editor: { role: "experience-lead", tags: ["historical", "keep"] } },
      evidence: {
        ...snapshot,
        metadata: { capture: { source: "synthetic-prior-check", labels: ["retain"] } },
        refs: snapshot.refs.map(ref => ({ ...ref, metadata: { origin: "fixture", nested: { retained: true } } })),
      },
      acceptance: {
        acceptanceId: prior.revisionId,
        command: [process.execPath, "-e", "process.exit(0)"],
        exitCode: 0,
        verifiedOutputSha256: "a".repeat(64),
        proposalSha256: "b".repeat(64),
        metadata: { verifier: { source: "synthetic-fixture", retained: true } },
      },
    }],
  };
}

function assertRecursivelyFrozen(value, label = "value") {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, `${label} is frozen`);
  for (const [key, child] of Object.entries(value)) assertRecursivelyFrozen(child, `${label}.${key}`);
}

function createProposal(history, currentObservation, content, replacementRevisionId) {
  return Object.freeze({
    noteId: history.noteId,
    baseRevisionId: history.revisions.at(-1).revisionId,
    baseNoteSha256: history.revisions.at(-1).contentSha256,
    baseHistorySha256: revisionHistoryDigest(history),
    content,
    observation: currentObservation,
    ...(replacementRevisionId === undefined ? {} : { replacementRevisionId }),
  });
}

const VERIFY_SCRIPT = String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const path = require("node:path");
const [workspace, serializedRefs, proposalSha256] = process.argv.slice(1);
const root = path.resolve(workspace);
const gitHead = execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
  encoding: "utf8", windowsHide: true, env: process.env,
}).trim().toLowerCase();
const evidenceRefs = JSON.parse(serializedRefs).map(({ path: relative }) => {
  if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("unsafe synthetic evidence path");
  const absolute = path.resolve(root, ...relative.split("/"));
  const inside = path.relative(root, absolute);
  if (path.isAbsolute(inside) || inside === ".." || inside.startsWith(".." + path.sep) || realpathSync.native(absolute) !== absolute) throw new Error("evidence escaped synthetic workspace");
  const stat = lstatSync(absolute, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error("evidence is not an independent regular file");
  return { path: relative, sourceSha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") };
});
process.stdout.write(JSON.stringify({ proposalSha256, gitHead, evidenceRefs }));
`;

function createRealChildVerifier(project, acceptanceId = `u08-acceptance-${randomUUID()}`) {
  const calls = [];
  const verify = async (proposal, proposalSha256) => {
    const args = ["-e", VERIFY_SCRIPT, project.workspacePath, JSON.stringify(proposal.observation.snapshot.refs), proposalSha256];
    const result = spawnSync(process.execPath, args, {
      cwd: project.workspacePath,
      env: process.env,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
    calls.push({ args, status: result.status, error: result.error?.code ?? null,
      verifiedOutputSha256: sha256(result.stdout ?? Buffer.alloc(0)) });
    if (result.error !== undefined || result.status !== 0) {
      return {
        acceptanceId,
        command: [process.execPath, ...args],
        exitCode: result.status ?? 1,
        proposalSha256,
        baseRevisionId: proposal.baseRevisionId,
        baseNoteSha256: proposal.baseNoteSha256,
        baseHistorySha256: proposal.baseHistorySha256,
        verifiedOutputSha256: sha256(result.stdout ?? Buffer.alloc(0)),
        projectId: proposal.observation.snapshot.projectId,
        gitHead: proposal.observation.snapshot.gitHead,
        evidenceRefs: proposal.observation.snapshot.refs,
        ...(proposal.replacementRevisionId === undefined ? {} : { replacementRevisionId: proposal.replacementRevisionId }),
      };
    }
    const verified = JSON.parse(result.stdout.toString("utf8"));
    return {
      acceptanceId,
      command: [process.execPath, ...args],
      exitCode: result.status,
      proposalSha256: verified.proposalSha256,
      baseRevisionId: proposal.baseRevisionId,
      baseNoteSha256: proposal.baseNoteSha256,
      baseHistorySha256: proposal.baseHistorySha256,
      verifiedOutputSha256: sha256(result.stdout),
      projectId: proposal.observation.snapshot.projectId,
      gitHead: verified.gitHead,
      evidenceRefs: verified.evidenceRefs,
      ...(proposal.replacementRevisionId === undefined ? {} : { replacementRevisionId: proposal.replacementRevisionId }),
    };
  };
  return { calls, verify };
}

test("real registry/Git/raw-byte observations distinguish unchanged age, recheck and unknown", t => {
  assert.equal(process.versions.node, "24.14.0", "U08 uses the fixed Node 24.14 runtime");
  t.diagnostic("Synthetic owned registry, real Git and raw file observations; no model, installed application, or production profile");
  const f = fixture("freshness-observation-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "alpha");
  const before = observation(registry, project);
  assert.equal(before.state, "observed");
  assert.equal(before.snapshot.projectId, project.mapping.projectId);
  assert.equal(before.snapshot.gitHead, git(f, project.workspacePath, ["rev-parse", "HEAD"]));
  assert.deepEqual(before.snapshot.refs, [{
    path: "docs/evidence.md",
    sourceSha256: sha256(readFileSync(project.evidencePath)),
  }]);
  assert.equal(Number.isNaN(Date.parse(before.snapshot.sampledAt)), false);
  assert.equal("owner" in before.snapshot, false);
  assert.equal("progress" in before.snapshot, false);
  const forgedTime = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: ["docs/evidence.md"], sampledAt: "1900-01-01T00:00:00.000Z" });
  assert.equal(forgedTime.state, "observed");
  assert.notEqual(forgedTime.snapshot.sampledAt, "1900-01-01T00:00:00.000Z",
    "a caller cannot replace the observer's actual sample time");

  const threeYearsAgo = new Date(Date.now() - 3 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const oldUntrustedSnapshot = Object.freeze({ ...before.snapshot, sampledAt: threeYearsAgo });
  const agedAssessment = assessFreshness(oldUntrustedSnapshot, before);
  assert.deepEqual(agedAssessment, { state: "current", changes: [], unknownRefs: [] },
    "matching raw evidence and Git HEAD remain current across a three-year observation gap");

  commitFile(f, project, "README.md", "synthetic unrelated update\n", "advance Git HEAD only");
  const headChanged = observation(registry, project);
  assert.equal(headChanged.state, "observed");
  assert.notEqual(headChanged.snapshot.gitHead, before.snapshot.gitHead);
  assert.equal(headChanged.snapshot.refs[0].sourceSha256, before.snapshot.refs[0].sourceSha256);
  const headAssessment = assessFreshness(before.snapshot, headChanged);
  assert.equal(headAssessment.state, "needs_recheck");
  assert.ok(headAssessment.changes.some(change => change.kind === "git_head_changed"));

  writeFileSync(project.evidencePath, "# Evidence v2\nRAW_EVIDENCE_V2\n", "utf8");
  const bytesChanged = observation(registry, project);
  assert.equal(bytesChanged.state, "observed");
  assert.equal(bytesChanged.snapshot.gitHead, headChanged.snapshot.gitHead);
  assert.notEqual(bytesChanged.snapshot.refs[0].sourceSha256, headChanged.snapshot.refs[0].sourceSha256);
  const bytesAssessment = assessFreshness(headChanged.snapshot, bytesChanged);
  assert.equal(bytesAssessment.state, "needs_recheck");
  assert.ok(bytesAssessment.changes.some(change => change.kind === "evidence_hash_changed" && change.path === "docs/evidence.md"));

  const missing = path.join(project.workspacePath, "docs", "missing.md");
  const missingObservation = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath, evidencePaths: ["docs/missing.md"] });
  assert.equal(missingObservation.state, "unknown");
  assert.equal(missingObservation.reason, "MISSING_EVIDENCE");
  assert.deepEqual(missingObservation.unknownRefs, [{ path: "docs/missing.md", reason: "MISSING_EVIDENCE" }]);
  assert.equal(assessFreshness(bytesChanged.snapshot, missingObservation).state, "unknown");
  const incomplete = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath, evidencePaths: [] });
  assert.equal(incomplete.state, "unknown");
  assert.equal(incomplete.reason, "INCOMPLETE_OBSERVATION");
  assert.deepEqual(incomplete.unknownRefs, [{ path: "<evidencePaths>", reason: "INCOMPLETE_OBSERVATION" }]);
  assert.equal(assessFreshness(bytesChanged.snapshot, incomplete).state, "unknown");
  assert.equal(assessFreshness({ ...bytesChanged.snapshot, refs: [] }, bytesChanged).state, "unknown");
  assert.equal(assessFreshness({ ...bytesChanged.snapshot, refs: [
    ...bytesChanged.snapshot.refs,
    { path: "docs/extra.md", sourceSha256: "a".repeat(64) },
  ] }, bytesChanged).state, "unknown", "extra or missing evidence references cannot silently match");
  assert.equal(assessFreshness({ ...bytesChanged.snapshot, projectId: randomUUID() }, bytesChanged).state, "unknown");
  const escapedPathObservation = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: ["../outside.md"] });
  assert.equal(escapedPathObservation.state, "unknown");
  assert.equal(escapedPathObservation.reason, "INVALID_EVIDENCE_PATH");
  assert.deepEqual(escapedPathObservation.unknownRefs, [{ path: "../outside.md", reason: "INVALID_EVIDENCE_PATH" }]);
  const externalEvidence = path.join(f.root, "outside-evidence.md");
  const linkedEvidence = path.join(project.workspacePath, "docs", "hardlink.md");
  writeFileSync(externalEvidence, "synthetic external bytes\n", "utf8");
  linkSync(externalEvidence, linkedEvidence);
  const hardlinkObservation = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: ["docs/hardlink.md"] });
  assert.equal(hardlinkObservation.reason, "UNSAFE_EVIDENCE_PATH");
  assert.deepEqual(hardlinkObservation.unknownRefs, [{ path: "docs/hardlink.md", reason: "UNSAFE_EVIDENCE_PATH" }]);
  assert.equal(readFileSync(externalEvidence, "utf8"), "synthetic external bytes\n");
  assert.equal(existsSync(missing), false, "missing evidence is never fabricated");
});

test("Windows aliases, private files, non-NFC names and junction paths remain unknown", t => {
  const f = fixture("freshness-path-aliases-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "path-aliases");

  const caseAlias = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: ["DOCS/evidence.md"] });
  assert.equal(existsSync(path.join(project.workspacePath, "DOCS", "evidence.md")), true,
    "the differently cased spelling resolves to the existing Windows file");
  assert.equal(caseAlias.state, "unknown");

  const envPath = path.join(project.workspacePath, ".env");
  writeFileSync(envPath, "SYNTHETIC_PRIVATE_FIXTURE=1\n", "utf8");
  assert.equal(existsSync(envPath), true);
  const envObservation = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: [".env"] });
  assert.equal(envObservation.state, "unknown");

  const gitConfig = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: [".git/config"] });
  assert.equal(existsSync(path.join(project.workspacePath, ".git", "config")), true);
  assert.equal(gitConfig.state, "unknown");

  const decomposedName = "cafe\u0301.md";
  const decomposedPath = path.join(project.workspacePath, "docs", decomposedName);
  writeFileSync(decomposedPath, "synthetic decomposed Unicode filename\n", "utf8");
  assert.equal(existsSync(decomposedPath), true, "the decomposed Unicode fixture exists on disk");
  const nonNfc = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: [`docs/${decomposedName}`] });
  assert.equal(nonNfc.state, "unknown");

  const junctionPath = path.join(project.workspacePath, "docs", "evidence-alias");
  symlinkSync(path.join(project.workspacePath, "docs"), junctionPath, "junction");
  assert.equal(existsSync(path.join(junctionPath, "evidence.md")), true,
    "the owned directory junction reaches the real fixture evidence file");
  const junctionAlias = captureFreshnessSnapshot({ registry, workspacePath: project.workspacePath,
    evidencePaths: ["docs/evidence-alias/evidence.md"] });
  assert.equal(junctionAlias.state, "unknown");
});

test("a real source write and Git commit before the final registry resolution cannot produce a mixed snapshot", t => {
  t.diagnostic("Fault injection changes an owned synthetic repository before registry resolution #2; registry resolution, Git, and file reads are real, with no claim of an OS-scheduled race.");
  const f = fixture("freshness-capture-head-race-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "capture-head-race");
  const beforeHead = git(f, project.workspacePath, ["rev-parse", "HEAD"]);
  const beforeHash = sha256(readFileSync(project.evidencePath));
  const fault = registryMutatingBeforeSecondResolve(registry, () => {
    writeFileSync(project.evidencePath, "# Evidence changed during capture\nCAPTURE_HEAD_RACE\n", "utf8");
    git(f, project.workspacePath, ["add", "docs/evidence.md"]);
    git(f, project.workspacePath, ["commit", "-m", "mutate evidence before final resolution"]);
  });

  const captured = observation(fault.registry, project);

  assert.ok(fault.calls >= 2, "fault injection ran before a later real registry resolution");
  assert.notEqual(git(f, project.workspacePath, ["rev-parse", "HEAD"]), beforeHead,
    "fault injection advanced the synthetic repository HEAD");
  assert.notEqual(sha256(readFileSync(project.evidencePath)), beforeHash,
    "fault injection replaced the raw evidence bytes");
  assert.equal(captured.state, "unknown");
  assert.equal("snapshot" in captured, false, "a mixed Git/evidence version is never exposed as a snapshot");
});

test("a raw-byte-only mutation at final registry resolution cannot produce a mixed snapshot", t => {
  t.diagnostic("Fault injection rewrites owned synthetic evidence before registry resolution #2 without committing; registry resolution, Git and raw-byte reads are real, with no claim of an OS-scheduled race.");
  const f = fixture("freshness-capture-hash-race-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "capture-hash-race");
  const beforeHead = git(f, project.workspacePath, ["rev-parse", "HEAD"]);
  const beforeHash = sha256(readFileSync(project.evidencePath));
  const fault = registryMutatingBeforeSecondResolve(registry, () => {
    writeFileSync(project.evidencePath, "# Evidence changed during capture\nCAPTURE_HASH_RACE\n", "utf8");
  });

  const captured = observation(fault.registry, project);

  assert.ok(fault.calls >= 2, "fault injection ran before a later real registry resolution");
  assert.equal(git(f, project.workspacePath, ["rev-parse", "HEAD"]), beforeHead,
    "the raw-byte fault did not advance synthetic Git HEAD");
  assert.notEqual(sha256(readFileSync(project.evidencePath)), beforeHash,
    "fault injection replaced the raw evidence bytes");
  assert.equal(captured.state, "unknown");
  assert.equal("snapshot" in captured, false, "changed raw bytes are never exposed as an observed snapshot");
});

const ACL_HELPER = String.raw`param(
  [Parameter(Mandatory=$true)][ValidateSet('get','deny','restore')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Target,
  [string]$SavedDaclBase64
)
$ErrorActionPreference = 'Stop'
$sections = [System.Security.AccessControl.AccessControlSections]::Access
switch ($Action) {
  'get' {
    $acl = Get-Acl -LiteralPath $Target
    $sddl = $acl.GetSecurityDescriptorSddlForm($sections)
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($sddl)))
  }
  'deny' {
    $acl = Get-Acl -LiteralPath $Target
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($user, [System.Security.AccessControl.FileSystemRights]::ReadData, [System.Security.AccessControl.AccessControlType]::Deny)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Target -AclObject $acl
  }
  'restore' {
    $saved = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($SavedDaclBase64))
    $acl = Get-Acl -LiteralPath $Target
    $acl.SetSecurityDescriptorSddlForm($saved, $sections)
    Set-Acl -LiteralPath $Target -AclObject $acl
  }
}`;

function runAclHelper(f, scriptPath, action, target, savedDaclBase64 = "") {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-Action", action, "-Target", target, "-SavedDaclBase64", savedDaclBase64,
  ], {
    cwd: f.root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Synthetic ACL ${action} operation failed (exit ${result.status ?? "spawn"})`);
  }
  return result.stdout.trim();
}

test("an actual synthetic Windows ACL denial remains unknown and is restored", t => {
  const f = fixture("freshness-unreadable-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "acl");
  const scriptPath = path.join(f.root, "owned-acl-helper.ps1");
  writeFileSync(scriptPath, ACL_HELPER, "utf8");
  const originalHash = sha256(readFileSync(project.evidencePath));
  const savedDacl = runAclHelper(f, scriptPath, "get", project.evidencePath);
  try {
    runAclHelper(f, scriptPath, "deny", project.evidencePath);
    const denied = observation(registry, project);
    assert.equal(denied.state, "unknown");
    assert.equal(denied.reason, "UNREADABLE_EVIDENCE");
    assert.deepEqual(denied.unknownRefs, [{ path: "docs/evidence.md", reason: "UNREADABLE_EVIDENCE" }]);
  } finally {
    runAclHelper(f, scriptPath, "restore", project.evidencePath, savedDacl);
  }
  const restoredDacl = runAclHelper(f, scriptPath, "get", project.evidencePath);
  assert.equal(sha256(Buffer.from(restoredDacl, "utf8")), sha256(Buffer.from(savedDacl, "utf8")),
    "the exact fixture DACL is restored without printing its descriptor or SID");
  assert.equal(sha256(readFileSync(project.evidencePath)), originalHash, "restoring fixture ACL preserves raw evidence bytes");
  assert.equal(observation(registry, project).state, "observed", "a later real observation succeeds after restoration");
});

test("only a real child-verified, exact Host acceptance appends immutable experience revisions", async t => {
  t.diagnostic("Trusted Host is a synthetic callback backed by a real fixed-Node child checking synthetic Git and raw bytes; no model or installed app runs");
  const f = fixture("freshness-revisions-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "revision");
  const current = observation(registry, project);
  const history = createHistoryWithMetadata(current.snapshot);
  const originalHistory = structuredClone(history);
  const proposal = createProposal(history, current, "Rechecked against current synthetic evidence.");
  assert.equal(proposal.baseHistorySha256, revisionHistoryDigest(history),
    "the proposal binds the complete validated JSON history prefix");
  let clonedObservationVerifierCalled = false;
  await expectFreshnessReject(() => authorizeRevisionProposal({ ...proposal, observation: structuredClone(current) }, async () => {
    clonedObservationVerifierCalled = true;
    return null;
  }), "INVALID_OBSERVATION");
  assert.equal(clonedObservationVerifierCalled, false, "serialized observation data cannot reach the Host acceptance callback");
  const realHost = createRealChildVerifier(project);
  const receipt = await authorizeRevisionProposal(proposal, realHost.verify);
  assert.equal(realHost.calls.length, 1);
  assert.equal(realHost.calls[0].status, 0, "trusted fixture Host completed an actual Node child process");
  const clonedReceipt = { ...receipt };
  expectFreshnessError(() => appendVerifiedRevision(history, proposal, clonedReceipt), "INVALID_RECEIPT");
  const revised = appendVerifiedRevision(history, proposal, receipt);
  assert.equal(revised.revisions.length, 2);
  assert.deepEqual(revised.revisions[0], history.revisions[0], "prior text/hash remains byte-for-byte historical data");
  assert.equal(revised.revisions[1].revisionId.startsWith("u08-acceptance-"), true);
  assert.equal(revised.revisions[1].content, proposal.content);
  assert.equal(revised.revisions[1].contentSha256, sha256(Buffer.from(proposal.content, "utf8")));
  assert.equal(revised.revisions[1].authority, "experience-lead");
  assert.equal(revised.revisions[1].acceptance.exitCode, 0);
  assert.equal(revised.revisions[1].acceptance.verifiedOutputSha256, realHost.calls[0].verifiedOutputSha256);
  assert.match(revised.revisions[1].acceptance.verifiedOutputSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(revised.revisions[1].evidence, current.snapshot);
  assert.equal(revised.revisions[1].supersedesRevisionId, undefined, "ordinary revision does not replace prior history");
  assert.deepEqual(revised.metadata, history.metadata, "top-level history metadata is retained exactly");
  assert.deepEqual(revised.revisions[0].metadata, history.revisions[0].metadata,
    "old revision metadata remains unchanged");
  assert.deepEqual(revised.revisions[0].evidence.metadata, history.revisions[0].evidence.metadata,
    "nested evidence metadata remains unchanged");
  assert.deepEqual(revised.revisions[0].acceptance.metadata, history.revisions[0].acceptance.metadata,
    "old acceptance metadata remains unchanged");
  assert.notEqual(revised.metadata, history.metadata, "returned top-level metadata is a deep clone");
  assert.notEqual(revised.metadata.review, history.metadata.review,
    "nested top-level metadata is also cloned");
  assert.notEqual(revised.revisions[0].metadata, history.revisions[0].metadata,
    "returned revision metadata is a deep clone");
  assert.notEqual(revised.revisions[0].evidence, history.revisions[0].evidence,
    "returned evidence is a deep clone");
  assert.notEqual(revised.revisions[0].evidence.refs[0], history.revisions[0].evidence.refs[0],
    "returned evidence references are deep clones");
  assert.notEqual(revised.revisions[0].evidence.refs[0].metadata.nested,
    history.revisions[0].evidence.refs[0].metadata.nested,
    "nested evidence metadata is a deep clone");
  assert.notEqual(revised.revisions[0].acceptance.metadata.verifier,
    history.revisions[0].acceptance.metadata.verifier,
    "nested acceptance metadata is a deep clone");
  assert.notEqual(revised.revisions[0].acceptance.command, history.revisions[0].acceptance.command,
    "returned acceptance commands are deep clones");
  assertRecursivelyFrozen(revised, "revised history");
  assert.equal("owner" in revised, false);
  assert.equal("progress" in revised, false);
  assert.deepEqual(history, originalHistory, "append operation does not mutate its caller's history");
  expectFreshnessError(() => appendVerifiedRevision(revised, proposal, receipt), "INVALID_RECEIPT");

  const failureProposal = createProposal(history, current, "Must not append without Host acceptance.");
  await expectFreshnessReject(() => authorizeRevisionProposal(failureProposal, async () => null), "HOST_REJECTED");
  await expectFreshnessReject(() => authorizeRevisionProposal(failureProposal, async () => ({ verified: true })), "INVALID_HOST_ACCEPTANCE");
  await expectFreshnessReject(() => authorizeRevisionProposal(failureProposal, async (value, proposalSha256) => ({
    acceptanceId: `u08-missing-output-${randomUUID()}`,
    command: [process.execPath, "-e", "process.stdout.write('unchecked')"],
    exitCode: 0,
    proposalSha256,
    baseRevisionId: value.baseRevisionId,
    baseNoteSha256: value.baseNoteSha256,
    baseHistorySha256: value.baseHistorySha256,
    projectId: value.observation.snapshot.projectId,
    gitHead: value.observation.snapshot.gitHead,
    evidenceRefs: value.observation.snapshot.refs,
  })), "INVALID_HOST_ACCEPTANCE");
  const failedChildVerifier = async (value, proposalSha256) => {
    const args = ["-e", "process.exit(19)"];
    const failed = spawnSync(process.execPath, args, { cwd: project.workspacePath, env: process.env, windowsHide: true, timeout: 10_000 });
    return {
      acceptanceId: `u08-failed-child-${randomUUID()}`,
      command: [process.execPath, ...args],
      exitCode: failed.status ?? 1,
      proposalSha256,
      baseRevisionId: value.baseRevisionId,
      baseNoteSha256: value.baseNoteSha256,
      baseHistorySha256: value.baseHistorySha256,
      verifiedOutputSha256: sha256(failed.stdout ?? Buffer.alloc(0)),
      projectId: value.observation.snapshot.projectId,
      gitHead: value.observation.snapshot.gitHead,
      evidenceRefs: value.observation.snapshot.refs,
    };
  };
  await expectFreshnessReject(() => authorizeRevisionProposal(failureProposal, failedChildVerifier), "INVALID_HOST_ACCEPTANCE");
  const mismatchedVerifier = createRealChildVerifier(project).verify;
  await expectFreshnessReject(() => authorizeRevisionProposal(failureProposal, async (value, proposalSha256) => {
    const accepted = await mismatchedVerifier(value, proposalSha256);
    return { ...accepted, proposalSha256: "0".repeat(64) };
  }), "INVALID_HOST_ACCEPTANCE");
  assert.deepEqual(history, originalHistory, "rejected or failed verifiers never append or alter history");

  const racedBaseProposal = Object.freeze({
    ...createProposal(revised, current, "CAS must bind the latest revision identity."),
    baseRevisionId: history.revisions[0].revisionId,
  });
  const racedBaseReceipt = await authorizeRevisionProposal(racedBaseProposal, createRealChildVerifier(project).verify);
  expectFreshnessError(() => appendVerifiedRevision(revised, racedBaseProposal, racedBaseReceipt), "HISTORY_MISMATCH");
  assert.equal(revised.revisions.length, 2, "a stale base revision cannot replace a same-snapshot history");

  const duplicateProposal = createProposal(revised, current, "A new text cannot reuse an old Host acceptance.");
  assert.equal(duplicateProposal.baseHistorySha256, revisionHistoryDigest(revised),
    "duplicate acceptance is checked against the exact prefix that already contains its ID");
  const duplicateReceipt = await authorizeRevisionProposal(duplicateProposal,
    createRealChildVerifier(project, revised.revisions.at(-1).revisionId).verify);
  expectFreshnessError(() => appendVerifiedRevision(revised, duplicateProposal, duplicateReceipt), "DUPLICATE_ACCEPTANCE");
  assert.equal(revised.revisions.length, 2);

  const replacementProposal = createProposal(revised, current, "Explicitly replaces only the latest accepted revision.", revised.revisions.at(-1).revisionId);
  const replacementReceipt = await authorizeRevisionProposal(replacementProposal, createRealChildVerifier(project).verify);
  const replaced = appendVerifiedRevision(revised, replacementProposal, replacementReceipt);
  assert.equal(replaced.revisions.length, 3);
  assert.deepEqual(replaced.revisions.slice(0, 2), revised.revisions);
  assert.equal(replaced.revisions[2].supersedesRevisionId, revised.revisions[1].revisionId);
  assert.equal(replaced.revisions[0].content, history.revisions[0].content, "supersession never deletes original experience");
});

test("history validation rejects malformed prefixes without consuming the receipt", async t => {
  const f = fixture("freshness-history-prefix-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "history-prefix");
  const current = observation(registry, project);
  const initial = createHistory();
  const initialProposal = createProposal(initial, current, "First accepted synthetic revision.");
  const initialReceipt = await authorizeRevisionProposal(initialProposal, createRealChildVerifier(project).verify);
  const prefix = appendVerifiedRevision(initial, initialProposal, initialReceipt);
  const originalPrefix = structuredClone(prefix);
  const proposal = createProposal(prefix, current, "Append only if the exact complete prefix remains intact.");
  assert.equal(proposal.baseHistorySha256, revisionHistoryDigest(prefix),
    "the proposal digest covers the complete existing two-revision history");
  const receipt = await authorizeRevisionProposal(proposal, createRealChildVerifier(project).verify);

  const badHash = structuredClone(prefix);
  badHash.revisions[0].contentSha256 = "0".repeat(64);
  const nullRevision = structuredClone(prefix);
  nullRevision.revisions[0] = null;
  const repeatedId = structuredClone(prefix);
  repeatedId.revisions.push(structuredClone(repeatedId.revisions[0]));
  const wrongAuthority = structuredClone(prefix);
  wrongAuthority.revisions[0].authority = "assistant";
  const forwardSupersedes = structuredClone(prefix);
  forwardSupersedes.revisions[0].supersedesRevisionId = prefix.revisions[1].revisionId;
  const changedMetadata = structuredClone(prefix);
  changedMetadata.revisions[0].metadata = { addedAfterProposal: { source: "synthetic concurrent edit", labels: ["new"] } };
  assert.deepEqual(changedMetadata.revisions.at(-1), prefix.revisions.at(-1),
    "the latest revision fields are unchanged while an earlier revision gains metadata");
  assert.notEqual(revisionHistoryDigest(changedMetadata), proposal.baseHistorySha256,
    "extra JSON metadata changes the digest even when all revision fields remain the same");

  for (const [label, candidate] of [
    ["bad content hash", badHash],
    ["null revision", nullRevision],
    ["repeated revision ID", repeatedId],
    ["wrong authority", wrongAuthority],
    ["forward supersedes reference", forwardSupersedes],
    ["extra prefix metadata", changedMetadata],
  ]) {
    expectFreshnessError(() => appendVerifiedRevision(candidate, proposal, receipt), "HISTORY_MISMATCH");
    t.diagnostic(`${label} is rejected as HISTORY_MISMATCH`);
  }

  assert.deepEqual(prefix, originalPrefix, "rejected history candidates do not alter the accepted prefix");
  const recovered = appendVerifiedRevision(prefix, proposal, receipt);
  assert.equal(recovered.revisions.length, 3,
    "the same receipt remains usable after malformed and changed-prefix histories are rejected");
  assert.deepEqual(recovered.revisions.slice(0, 2), prefix.revisions,
    "appending after recovery preserves every prior revision field");
});

test("a source race during Host verification invalidates the observation before append", async t => {
  const f = fixture("freshness-verification-race-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "race");
  const history = createHistory();
  const initialHistory = structuredClone(history);
  const before = observation(registry, project);
  const preCallbackProposal = createProposal(history, before, "The proposal must not reach Host after a preflight race.");
  writeFileSync(project.evidencePath, "# Evidence changed before Host\nPRE_CALLBACK_RACE\n", "utf8");
  let verifierCallsBeforeCallback = 0;
  await expectFreshnessReject(() => authorizeRevisionProposal(preCallbackProposal, async () => {
    verifierCallsBeforeCallback += 1;
    return null;
  }), "STALE_OBSERVATION");
  assert.equal(verifierCallsBeforeCallback, 0, "pre-callback drift is rejected before trusted Host work starts");

  const duringObservation = observation(registry, project);
  const duringProposal = createProposal(history, duringObservation, "The proposed note cites bytes changed during Host work.");
  const childHost = createRealChildVerifier(project);
  const mutatingVerifier = async (value, proposalSha256) => {
    const accepted = await childHost.verify(value, proposalSha256);
    writeFileSync(project.evidencePath, "# Evidence changed during Host\nCALLBACK_RACE\n", "utf8");
    return accepted;
  };
  await expectFreshnessReject(() => authorizeRevisionProposal(duringProposal, mutatingVerifier), "STALE_OBSERVATION");
  assert.equal(childHost.calls[0].status, 0);
  assert.deepEqual(history, initialHistory, "source drift during verification leaves prior history intact");

  const beforeAppend = observation(registry, project);
  const appendProposal = createProposal(history, beforeAppend, "The source changes after verified receipt issuance.");
  const appendReceipt = await authorizeRevisionProposal(appendProposal, createRealChildVerifier(project).verify);
  const originalEvidenceBytes = readFileSync(project.evidencePath);
  writeFileSync(project.evidencePath, "# Evidence changed before append\nPRE_APPEND_RACE\n", "utf8");
  expectFreshnessError(() => appendVerifiedRevision(history, appendProposal, appendReceipt), "STALE_OBSERVATION");
  assert.deepEqual(history, initialHistory, "append-time source drift does not consume the old note or append stale content");
  writeFileSync(project.evidencePath, originalEvidenceBytes);
  const recovered = appendVerifiedRevision(history, appendProposal, appendReceipt);
  assert.equal(recovered.revisions.length, 2, "the stale append failure leaves its receipt available after exact evidence recovery");
});

test("real registry relocation during Host verification invalidates unchanged byte evidence", async t => {
  const f = fixture("freshness-mapping-race-");
  const registry = openRegistry(f, t);
  const project = addProject(f, registry, "mapping-race");
  const history = createHistory();
  const before = observation(registry, project);
  const proposal = createProposal(history, before, "The mapping must remain the admitted mapping during verification.");
  const targetRoot = path.join(f.root, "relocated-native-cli");
  mkdirSync(targetRoot);
  const host = createRealChildVerifier(project);
  await expectFreshnessReject(() => authorizeRevisionProposal(proposal, async (value, digest) => {
    const accepted = await host.verify(value, digest);
    const priorMapping = registry.resolveWorkspace(project.workspacePath);
    const relocated = registry.relocateNativeStorage({ projectId: priorMapping.projectId,
      expectedRevision: priorMapping.revision, nativeStorageRoot: targetRoot, confirmed: true,
      verifyTarget: () => {
        assert.equal(existsSync(targetRoot), true);
        assert.equal(existsSync(path.join(targetRoot, "memories")), false,
          "this fixture has no Native notes to copy; verification does not fabricate them");
      } });
    assert.equal(relocated.revision, priorMapping.revision + 1);
    assert.equal(relocated.projectId, priorMapping.projectId);
    return accepted;
  }), "STALE_OBSERVATION");
  assert.equal(host.calls[0].status, 0);
  const after = observation(registry, project);
  assert.equal(after.state, "observed");
  assert.equal(after.snapshot.projectId, before.snapshot.projectId);
  assert.equal(after.snapshot.gitHead, before.snapshot.gitHead);
  assert.deepEqual(after.snapshot.refs, before.snapshot.refs);
  assert.equal(assessFreshness(before.snapshot, after).state, "current",
    "ordinary freshness still compares evidence across an authorized stable-ID relocation");
  assert.equal(history.revisions.length, 1, "the race issues no usable revision receipt or history write");
});
