import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hostRoot = "E:\\Xiadie\\Xiadie";
const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments", "u05");
mkdirSync(experimentRoot, { recursive: true });

// Native helpers below run only after replacing the process environment with
// the system allowlist and this test's owned HOME/TEMP directories.
const environmentRoot = mkdtempSync(path.join(experimentRoot, "policy-env-"));
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
const registryModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "registry.js")).href;
const registryApi = await import(registryModuleUrl);
const { isTrustedProjectMapping, openProjectRegistry } = registryApi;

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

const readerModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "adapters", "zcode", "src", "project-memory.js")).href;
const { createProjectMemoryReader } = await import(readerModuleUrl);
const contextModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "context", "src", "index.js")).href;
const characterModuleUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "character", "src", "index.js")).href;
const [{ buildContextPacket }, { loadCharacter }] = await Promise.all([
  import(contextModuleUrl),
  import(characterModuleUrl),
]);

function repoPath(root, relative) {
  return path.join(root, ...relative.split("/"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filename) {
  return sha256(readFileSync(filename));
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function fixture() {
  const root = mkdtempSync(path.join(experimentRoot, "stale-memory-policy-"));
  const ownedDirectory = path.join(root, "registry");
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
    "-c", "user.name=P03 U05 Synthetic Author",
    "-c", "user.email=p03-u05@example.invalid",
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

function createSyntheticRepository(f) {
  const workspacePath = path.join(f.root, "repos", "current-project");
  mkdirSync(path.dirname(workspacePath), { recursive: true });
  mkdirSync(workspacePath);
  git(f, f.root, ["init", "--initial-branch=main", workspacePath]);
  writeFileSync(path.join(workspacePath, "README.md"), "Synthetic U05 project.\n", "utf8");
  git(f, workspacePath, ["add", "README.md"]);
  git(f, workspacePath, ["commit", "-m", "synthetic U05 project"]);
  return workspacePath;
}

function readAcceptedTask(liveStatus, taskId, t) {
  const task = liveStatus.tasks.find(entry => entry.id === taskId);
  assert.ok(task, `live P03 ledger is missing ${taskId}`);
  assert.equal(task.status, "accepted", `${taskId} must be accepted in the live P03 ledger`);
  assert.ok(task.acceptance?.path && task.acceptance.sha256);
  const acceptancePath = repoPath(hostRoot, task.acceptance.path);
  const acceptanceBytes = readFileSync(acceptancePath);
  const acceptanceHash = sha256(acceptanceBytes);
  assert.equal(acceptanceBytes.byteLength, task.acceptance.bytes);
  assert.equal(acceptanceHash, task.acceptance.sha256);
  const receipt = JSON.parse(acceptanceBytes.toString("utf8"));
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.task, taskId);
  t.diagnostic(`${taskId}_acceptance_sha256=${acceptanceHash}`);
  return { task, receipt, path: acceptancePath, hash: acceptanceHash };
}

test("deterministic registry, receipt and packet-data boundaries keep obsolete memory as a provenance-tagged lead", t => {
  const f = fixture();
  const workspacePath = createSyntheticRepository(f);
  const registry = openProjectRegistry({
    ownedDirectory: f.ownedDirectory,
    nativeStorageRoot: f.nativeStorageRoot,
    nativeMemoryRootResolver: resolveProjectMemoryRoot,
    nativeRuntimeKeyResolver: projectIdFromDirectory,
  });
  t.after(() => registry.close());

  const mapping = registry.registerWorkspace({ workspacePath });
  assert.equal(isTrustedProjectMapping(mapping), true);
  assert.match(mapping.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(mapping.native.mode, "uuid");
  assert.equal("projectName" in mapping, false);
  assert.equal("owner" in mapping, false);
  assert.equal("progress" in mapping, false);
  assert.equal("getTaskLedger" in registry, false);
  assert.equal("taskLedger" in registry, false);
  assert.equal("TaskLedger" in registryApi, false);
  assert.equal("openTaskLedger" in registryApi, false);

  const notePath = "topics/obsolete-schema.md";
  const noteText = [
    "---",
    "schema: xiadie-project-note/v0",
    "authority: verified-fact",
    "projectName: obsolete-memory-project",
    "project_id: obsolete-memory-project",
    "owner: legacy-owner",
    "progress: complete",
    "task: P03-U04",
    "status: ready_for_review",
    "---",
    "",
    "# Historical experience lead",
    "This old note was written before the current source and acceptance evidence were checked.",
    "Its owner and progress fields are historical claims, not a live task assignment.",
    "Unique body marker: U05_OBSOLETE_NOTE_ONLY_CANARY.",
    "",
  ].join("\n");
  const indexText = `# Project memory\n[legacy note](${notePath})\n`;
  mkdirSync(mapping.native.memoryRoot, { recursive: true });
  const indexPath = path.join(mapping.native.memoryRoot, "MEMORY.md");
  const noteAbsolutePath = path.join(mapping.native.memoryRoot, ...notePath.split("/"));
  mkdirSync(path.dirname(noteAbsolutePath), { recursive: true });
  writeFileSync(indexPath, indexText, "utf8");
  writeFileSync(noteAbsolutePath, noteText, "utf8");

  const sourceInputs = [
    ["packages/projects/registry.ts", "registry-source"],
    ["packages/projects/test/registry.test.mjs", "registry-tests"],
    ["packages/adapters/zcode/src/project-memory.ts", "reader-source"],
    ["packages/adapters/zcode/test/project-memory.test.mjs", "reader-tests"],
    ["docs/adr/P03-reuse.md", "reuse-adr-design-input"],
  ];
  const currentHashes = {};
  for (const [relative, label] of sourceInputs) {
    const worktreeHash = sha256File(repoPath(worktreeRoot, relative));
    currentHashes[label] = worktreeHash;
  }

  const liveStatusPath = path.join(hostRoot, "evidence", "P03", "status.json");
  const liveStatusBytes = readFileSync(liveStatusPath);
  const liveStatus = JSON.parse(liveStatusBytes.toString("utf8"));
  const u02 = readAcceptedTask(liveStatus, "P03-U02", t);
  const u04 = readAcceptedTask(liveStatus, "P03-U04", t);
  const u05Task = liveStatus.tasks.find(entry => entry.id === "P03-U05");
  assert.ok(u05Task);
  assert.ok(["running", "ready_for_review", "accepted"].includes(u05Task.status));
  assert.equal(Object.hasOwn(u05Task, "owner"), false, "the live stage ledger does not record a business-task owner");
  assert.equal(Object.hasOwn(u05Task, "progress"), false, "the live stage ledger is not a business progress ledger");

  const u04Baseline = readJson(path.join(hostRoot, "evidence", "P03-U04", "20261008-01", "baseline.json"));
  const u05Baseline = readJson(path.join(worktreeRoot, "evidence", "P03-U05", "20261008-01", "baseline.json"));
  const u04CardHash = sha256File(repoPath(hostRoot, "planning/Xiadie_V2_v1.1/tasks/P03-U04.md"));
  const u05CardHash = sha256File(repoPath(worktreeRoot, "planning/Xiadie_V2_v1.1/tasks/P03-U05.md"));
  assert.equal(u04Baseline.card.sha256, u04CardHash);
  assert.equal(u05Baseline.card.sha256, u05CardHash);
  assert.equal(u05Baseline.prerequisites.find(item => item.task === "P03-U04").acceptance.sha256, u04.hash);
  currentHashes["u02-acceptance"] = u02.hash;
  currentHashes["u04-acceptance"] = u04.hash;
  currentHashes["u04-card"] = u04CardHash;
  currentHashes["u05-card"] = u05CardHash;
  currentHashes["live-P03-status"] = sha256(liveStatusBytes);
  currentHashes["u05-worktree-head"] = git(f, worktreeRoot, ["rev-parse", "HEAD"]);
  t.diagnostic(`current-authority-inputs=${JSON.stringify(currentHashes)}`);

  // P03-reuse.md is hashed as design context only. Its old header state is not
  // used as live status; the accepted receipts and current ledger above are.
  const reader = createProjectMemoryReader({
    registry,
    workspacePath,
    selectedTopics: () => [notePath],
  });
  const snapshot = reader.capture();
  assert.equal(snapshot.kind, "present");
  assert.equal(snapshot.project_id, mapping.projectId);
  assert.equal(registry.resolveWorkspace(workspacePath).projectId, mapping.projectId);
  assert.notEqual(mapping.projectId, "obsolete-memory-project");
  assert.notEqual(snapshot.project_id, "obsolete-memory-project");

  const topic = snapshot.topics.find(source => source.path === notePath);
  assert.ok(topic);
  assert.equal(topic.kind, "present");
  const noteHash = sha256(Buffer.from(noteText, "utf8"));
  assert.equal(topic.source_hash, noteHash);
  assert.equal(topic.text, noteText);
  assert.ok(Number.isFinite(Date.parse(snapshot.sampled_at)));

  assert.equal(snapshot.data.state.length, 1);
  assert.equal(snapshot.data.state[0].value.kind, "project-memory-index");
  assert.equal(snapshot.data.state[0].value.project_id, mapping.projectId);
  assert.equal(snapshot.data.state[0].value.sampled_at, snapshot.sampled_at);
  assert.equal(snapshot.data.evidence.length, 0);
  assert.equal(snapshot.data.content.length, 1);

  const experience = snapshot.data.content[0];
  assert.equal(experience.value.kind, "project-memory-topic");
  assert.equal(experience.value.authority, "experience-lead");
  assert.equal(experience.value.project_id, mapping.projectId);
  assert.equal(experience.value.sampled_at, snapshot.sampled_at);
  assert.equal(experience.value.path, notePath);
  assert.equal(experience.value.source_hash, noteHash);
  assert.equal(experience.value.text, noteText);
  assert.equal("owner" in experience.value, false);
  assert.equal("progress" in experience.value, false);
  assert.deepEqual(experience.source_refs, [
    `project-memory:${mapping.projectId}/${notePath}@sha256:${noteHash}`,
  ]);
  assert.ok(experience.value.frontmatter.includes("projectName: obsolete-memory-project"));
  assert.ok(experience.value.frontmatter.includes("authority: verified-fact"));
  assert.equal(u02.receipt.status, "accepted");
  assert.equal(u04.receipt.status, "accepted");
  assert.equal(u04.task.status, "accepted");
  assert.notEqual(u05Task.status, "not_started");

  const characterRoot = path.join(worktreeRoot, "assets", "character");
  const packet = buildContextPacket(loadCharacter(characterRoot), {
    scope: "conversation-turn",
    version: "1",
    max_tokens: 32_768,
    ...snapshot.data,
  });
  assert.equal(packet.content.some(entry => JSON.stringify(entry).includes("U05_OBSOLETE_NOTE_ONLY_CANARY")), true);
  assert.equal(packet.evidence.some(entry => JSON.stringify(entry).includes("U05_OBSOLETE_NOTE_ONLY_CANARY")), false);
  assert.equal(packet.instruction.some(entry => entry.text.includes("U05_OBSOLETE_NOTE_ONLY_CANARY")), false);
});
