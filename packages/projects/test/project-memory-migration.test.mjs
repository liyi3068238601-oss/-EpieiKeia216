import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hostRoot = "E:\\Xiadie\\Xiadie";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(testDirectory, "../../..");
const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments", "u06");
mkdirSync(experimentRoot, { recursive: true });

// Native imports and child processes are pinned to this test's own profile and
// temp directories. Every mutable repository/registry/memory root stays below
// experimentRoot; the pinned Native helper imports below are pure resolvers.
const environmentRoot = mkdtempSync(path.join(experimentRoot, "migration-env-"));
const syntheticHome = path.join(environmentRoot, "home");
const syntheticTemp = path.join(environmentRoot, "temp");
const syntheticAppData = path.join(syntheticHome, "AppData", "Roaming");
const syntheticLocalAppData = path.join(syntheticHome, "AppData", "Local");
const noGlobalGitConfig = path.join(environmentRoot, "disabled-global-git-config");
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
  GIT_CONFIG_GLOBAL: noGlobalGitConfig,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, safeEnvironment);

const registryUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "registry.js")).href;
const { ProjectRegistryError, openProjectRegistry } = await import(registryUrl);
const exportUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "export.js")).href;
const { exportProjectMemory, readProjectMemoryExport } = await import(exportUrl);
const relocateUrl = pathToFileURL(path.join(worktreeRoot, "dist", "packages", "projects", "relocate.js")).href;
const { importProjectMemory, relocateProjectMemory } = await import(relocateUrl);
const Database = (await import("better-sqlite3")).default;

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
    "-c", "user.name=P03 U06 Synthetic Author",
    "-c", "user.email=p03-u06@example.invalid",
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

function createRepository(f, directory) {
  mkdirSync(path.dirname(directory), { recursive: true });
  mkdirSync(directory, { recursive: true });
  git(f, f.root, ["init", "--initial-branch=main", directory]);
  writeFileSync(path.join(directory, "README.md"), "Synthetic P03-U06 repository.\n", "utf8");
  git(f, directory, ["add", "README.md"]);
  git(f, directory, ["commit", "-m", "synthetic project"]);
  return directory;
}

function registryOptions(f, overrides = {}) {
  return {
    ownedDirectory: f.ownedDirectory,
    nativeStorageRoot: f.nativeStorageRoot,
    nativeMemoryRootResolver: resolveProjectMemoryRoot,
    nativeRuntimeKeyResolver: projectIdFromDirectory,
    ...overrides,
  };
}

function openRegistry(f, t, overrides = {}) {
  const registry = openProjectRegistry(registryOptions(f, overrides));
  t.after(() => registry.close());
  return registry;
}

function seedSchemaOneRegistry(f, workspacePath) {
  const registry = openProjectRegistry(registryOptions(f));
  const mapping = registry.registerWorkspace({ workspacePath });
  registry.close();

  const filename = path.join(f.ownedDirectory, "project-registry.sqlite");
  const legacy = new Database(filename);
  try {
    legacy.exec("DROP TABLE project_relocations; PRAGMA user_version=1;");
    assert.equal(legacy.pragma("user_version", { simple: true }), 1);
  } finally {
    legacy.close();
  }
  return { filename, mapping };
}

function expectRegistryError(action, code) {
  assert.throws(action, error => error instanceof ProjectRegistryError && error.code === code,
    `expected ProjectRegistryError(${code})`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashTree(root) {
  const entries = [];
  const visit = (directory, relative = "") => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const childRelative = path.join(relative, name);
      const stat = lstatSync(absolute);
      assert.equal(stat.isSymbolicLink(), false, `fixture unexpectedly contains a link: ${childRelative}`);
      if (stat.isDirectory()) visit(absolute, childRelative);
      else {
        entries.push({
          path: childRelative.replaceAll(path.sep, "/"),
          size: stat.size,
          sha256: sha256(readFileSync(absolute)),
        });
      }
    }
  };
  visit(root);
  return entries;
}

function writeMemoryCorpus(memoryRoot, { includeLarge = true, includePathEdgeCases = false } = {}) {
  const nested = path.join(memoryRoot, "topics", "nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(memoryRoot, "MEMORY.md"), "# Synthetic project memory\n", "utf8");
  if (includePathEdgeCases) {
    const prototypeNamedDirectory = path.join(memoryRoot, "__proto__");
    mkdirSync(prototypeNamedDirectory);
    mkdirSync(path.join(memoryRoot, "empty-retained"));
    writeFileSync(path.join(prototypeNamedDirectory, "archive.bin"), Buffer.from([0x00, 0x80, 0xff, 0x7f]));
  }
  if (includeLarge) {
    // This topic is deliberately absent from MEMORY.md's index. Export must
    // preserve the entire archive tree, not only topics selected for reading.
    writeFileSync(path.join(memoryRoot, "topics", "unselected-large.md"), Buffer.alloc(40 * 1024 + 19, 0x61));
  }
  writeFileSync(path.join(nested, "raw.bin"), Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x00, 0xc3, 0x28]));
  // Invalid UTF-8 and malformed frontmatter are archive bytes, not parsed data.
  writeFileSync(path.join(nested, "malformed-frontmatter.md"), Buffer.from([
    0x2d, 0x2d, 0x2d, 0x0a, 0x73, 0x63, 0x68, 0x65, 0x6d, 0x61, 0x3a, 0x20,
    0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a, 0x23, 0x20, 0x52, 0x61, 0x77, 0x0a,
  ]));
}

function exportRequest(registry, mapping, destination, authorization = {
  projectId: mapping.projectId,
  action: "export",
  confirmed: true,
}) {
  return exportProjectMemory({
    registry,
    projectId: mapping.projectId,
    expectedRevision: mapping.revision,
    destination,
    authorization,
  });
}

test("export round-trips the complete raw memory tree, mapping snapshot, and SHA manifest", t => {
  const f = fixture("full-roundtrip");
  const workspacePath = createRepository(f, path.join(f.root, "repos", "project"));
  const registry = openRegistry(f, t);
  const mapping = registry.registerWorkspace({ workspacePath });
  mkdirSync(mapping.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(mapping.native.memoryRoot, { includePathEdgeCases: true });
  const before = hashTree(mapping.native.memoryRoot);
  const destinationParent = path.join(f.root, "exports");
  mkdirSync(destinationParent);
  const destination = path.join(destinationParent, "project-memory-export");

  expectRegistryError(() => exportRequest(registry, mapping, destination, {
    projectId: mapping.projectId,
    action: "export",
    confirmed: false,
  }), "AUTHORIZATION_REQUIRED");
  assert.equal(existsSync(destination), false, "an unconfirmed export must not create a bundle directory");

  const exported = exportRequest(registry, mapping, destination);
  assert.equal(exported.status, "exported");
  assert.equal(exported.projectId, mapping.projectId);
  assert.equal(exported.sourceRevision, mapping.revision);
  assert.equal(exported.manifest.memoryState, "present");
  assert.equal(exported.manifest.fileCount, before.length);
  assert.equal(exported.manifest.files.length, before.length);
  assert.equal(exported.manifest.mappingSha256, exported.mappingSha256);
  assert.equal(sha256(readFileSync(path.join(destination, "manifest.json"))), exported.manifestSha256);
  assert.equal(sha256(readFileSync(path.join(destination, "mapping.json"))), exported.mappingSha256);
  assert.deepEqual(exported.manifest.files.map(({ path: filePath, size, sha256: digest }) => ({
    path: filePath, size, sha256: digest,
  })), before);
  assert.equal(before.some(entry => entry.path === "topics/unselected-large.md" && entry.size > 32 * 1024), true);
  assert.equal(before.some(entry => entry.path === "topics/nested/raw.bin"), true);
  assert.equal(before.some(entry => entry.path === "topics/nested/malformed-frontmatter.md"), true);
  assert.equal(exported.manifest.directories.includes("__proto__"), true,
    "a safe own-property name must remain a normal directory in the exported inventory");
  assert.equal(exported.manifest.directories.includes("empty-retained"), true,
    "empty directories are part of the complete memory-tree inventory");
  assert.deepEqual(readFileSync(path.join(destination, "memory", "__proto__", "archive.bin")),
    Buffer.from([0x00, 0x80, 0xff, 0x7f]), "the __proto__ directory payload must round-trip byte-for-byte");
  assert.equal(existsSync(path.join(destination, "memory", "empty-retained")), true,
    "the export must materialize an empty directory listed in its manifest");

  const validated = readProjectMemoryExport(destination);
  assert.equal(validated.status, "valid");
  assert.equal(validated.projectId, mapping.projectId);
  assert.equal(validated.manifestSha256, exported.manifestSha256);
  assert.deepEqual(validated.mappingSnapshot, mapping);
  assert.equal(Object.isFrozen(validated), true);
  for (const item of before) {
    const exportedBytes = readFileSync(path.join(destination, "memory", ...item.path.split("/")));
    const sourceBytes = readFileSync(path.join(mapping.native.memoryRoot, ...item.path.split("/")));
    assert.deepEqual(exportedBytes, sourceBytes, `raw bytes differ for ${item.path}`);
  }
  assert.deepEqual(hashTree(mapping.native.memoryRoot), before, "export must leave Native memory bytes unchanged");
});

test("missing Native memory exports an explicit absent manifest without creating memory", t => {
  const f = fixture("absent-memory");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "empty-project"));
  const registry = openRegistry(f, t);
  const mapping = registry.registerWorkspace({ workspacePath });
  assert.equal(existsSync(mapping.native.memoryRoot), false);

  const destinationParent = path.join(f.root, "exports");
  mkdirSync(destinationParent);
  const exported = exportRequest(registry, mapping, path.join(destinationParent, "absent"));

  assert.equal(exported.status, "exported");
  assert.equal(exported.manifest.memoryState, "absent");
  assert.equal(exported.manifest.fileCount, 0);
  assert.deepEqual(exported.manifest.files, []);
  assert.equal(existsSync(mapping.native.memoryRoot), false);
  assert.equal(readProjectMemoryExport(exported.bundleRoot).manifest.memoryState, "absent");
});

test("manifest and payload tampering invalidate an otherwise valid export", t => {
  const f = fixture("tamper-export");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "tamper-source"));
  const registry = openRegistry(f, t);
  const mapping = registry.registerWorkspace({ workspacePath });
  mkdirSync(mapping.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(mapping.native.memoryRoot, { includeLarge: false });
  const parent = path.join(f.root, "exports");
  mkdirSync(parent);
  const originalRoot = path.join(parent, "valid");
  exportRequest(registry, mapping, originalRoot);

  const payloadCopy = path.join(parent, "tampered-payload");
  cpSync(originalRoot, payloadCopy, { recursive: true });
  writeFileSync(path.join(payloadCopy, "memory", "MEMORY.md"), "# changed after export\n", "utf8");
  assert.throws(() => readProjectMemoryExport(payloadCopy), error => error instanceof ProjectRegistryError);

  const manifestCopy = path.join(parent, "tampered-manifest");
  cpSync(originalRoot, manifestCopy, { recursive: true });
  const manifestPath = path.join(manifestCopy, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files[0].sha256 = "0".repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.throws(() => readProjectMemoryExport(manifestCopy), error => error instanceof ProjectRegistryError);
});

test("ordinary copies get a new UUID while an owner-confirmed bundle import preserves UUID with new Git identities", t => {
  const source = fixture("import-source");
  const sourceWorkspace = createRepository(source, path.join(source.root, "repos", "same-name"));
  const sourceRegistry = openRegistry(source, t);
  const sourceMapping = sourceRegistry.registerWorkspace({ workspacePath: sourceWorkspace });
  mkdirSync(sourceMapping.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(sourceMapping.native.memoryRoot, { includeLarge: false });
  const sourceBytes = hashTree(sourceMapping.native.memoryRoot);
  const bundleParent = path.join(source.root, "exports");
  mkdirSync(bundleParent);
  const exported = exportRequest(sourceRegistry, sourceMapping, path.join(bundleParent, "bundle"));

  const target = fixture("import-target");
  const ordinaryCopyPath = path.join(target.root, "ordinary-copy", "same-name");
  const importCopyPath = path.join(target.root, "import-copy", "same-name");
  mkdirSync(path.dirname(ordinaryCopyPath), { recursive: true });
  mkdirSync(path.dirname(importCopyPath), { recursive: true });
  cpSync(sourceWorkspace, ordinaryCopyPath, { recursive: true, preserveTimestamps: true });
  cpSync(sourceWorkspace, importCopyPath, { recursive: true, preserveTimestamps: true });

  const ordinaryRegistry = openRegistry(target, t);
  const ordinary = ordinaryRegistry.registerWorkspace({ workspacePath: ordinaryCopyPath });
  assert.notEqual(ordinary.projectId, sourceMapping.projectId);
  assert.notEqual(ordinary.commonIdentity, sourceMapping.commonIdentity);

  const importOwnedDirectory = path.join(target.root, "import-registry");
  mkdirSync(importOwnedDirectory);
  const importRegistry = openProjectRegistry(registryOptions(target, { ownedDirectory: importOwnedDirectory }));
  t.after(() => importRegistry.close());
  const validBundle = readProjectMemoryExport(exported.bundleRoot);
  const targetMemoryRoot = path.join(target.nativeStorageRoot, "memories", "projects", sourceMapping.native.key, "memory");
  const authorization = {
    projectId: sourceMapping.projectId,
    manifestSha256: validBundle.manifestSha256,
    action: "import",
    confirmed: true,
  };

  expectRegistryError(() => importProjectMemory({
    registry: importRegistry,
    bundleRoot: exported.bundleRoot,
    workspacePath: importCopyPath,
    nativeStorageRoot: target.nativeStorageRoot,
    authorization: { ...authorization, projectId: randomUUID() },
  }), "AUTHORIZATION_REQUIRED");
  expectRegistryError(() => importProjectMemory({
    registry: importRegistry,
    bundleRoot: exported.bundleRoot,
    workspacePath: importCopyPath,
    nativeStorageRoot: target.nativeStorageRoot,
    authorization: { ...authorization, manifestSha256: "0".repeat(64) },
  }), "AUTHORIZATION_REQUIRED");
  assert.equal(importRegistry.list().length, 0);
  assert.equal(existsSync(targetMemoryRoot), false, "authorization failures must not create an active or partial root");

  const imported = importProjectMemory({
    registry: importRegistry,
    bundleRoot: exported.bundleRoot,
    workspacePath: importCopyPath,
    nativeStorageRoot: target.nativeStorageRoot,
    authorization,
  });
  assert.equal(imported.status, "imported");
  assert.equal(imported.sourceRetained, true);
  assert.equal(imported.manifestSha256, validBundle.manifestSha256);
  assert.equal(imported.mapping.projectId, sourceMapping.projectId);
  assert.equal(imported.mapping.revision, sourceMapping.revision + 1);
  assert.notEqual(imported.mapping.commonIdentity, sourceMapping.commonIdentity);
  assert.equal(imported.mapping.native.storageRoot, target.nativeStorageRoot);
  assert.deepEqual(hashTree(imported.targetMemoryRoot), sourceBytes);
  assert.deepEqual(hashTree(sourceMapping.native.memoryRoot), sourceBytes);
  assert.deepEqual(imported.mapping.workspaces.map(binding => binding.workspacePath), [importCopyPath]);

  const history = importRegistry.history(sourceMapping.projectId);
  assert.equal(history.length, 1);
  assert.equal(history[0].operation, "import");
  assert.equal(history[0].previousRevision, sourceMapping.revision);
  assert.equal(history[0].revision, imported.mapping.revision);
  assert.equal(history[0].before, null);
  assert.deepEqual(history[0].after, imported.mapping);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history[0]), true);
  assert.equal(importRegistry.list().length, 1);

  const db = new Database(path.join(importOwnedDirectory, "project-registry.sqlite"), { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ["project_relocations", "projects", "workspaces"]);
    assert.equal(tables.some(name => /memory|knowledge|topic/i.test(name)), false,
      "migration metadata must not become a SQLite knowledge mirror");
  } finally {
    db.close();
  }
});

test("confirmed same-machine main-workspace rename keeps project UUID and Native pointer", t => {
  const f = fixture("main-rename");
  const oldPath = createRepository(f, path.join(f.root, "repos", "before"));
  const newPath = path.join(f.root, "repos", "after");
  const registry = openRegistry(f, t);
  const prior = registry.registerWorkspace({ workspacePath: oldPath });

  expectRegistryError(() => registry.confirmWorkspaceRelocation({
    projectId: prior.projectId,
    expectedRevision: prior.revision,
    oldWorkspacePath: oldPath,
    newWorkspacePath: oldPath,
    confirmed: false,
  }), "AUTHORIZATION_REQUIRED");
  assert.deepEqual(registry.get(prior.projectId), prior);
  renameSync(oldPath, newPath);

  const moved = registry.confirmWorkspaceRelocation({
    projectId: prior.projectId,
    expectedRevision: prior.revision,
    oldWorkspacePath: oldPath,
    newWorkspacePath: newPath,
    confirmed: true,
  });
  assert.equal(moved.projectId, prior.projectId);
  assert.equal(moved.revision, prior.revision + 1);
  assert.equal(moved.native.memoryRoot, prior.native.memoryRoot);
  assert.equal(moved.workspaces.length, 1);
  assert.equal(moved.workspaces[0].workspacePath, newPath);
  assert.equal(registry.resolveWorkspace(newPath).projectId, prior.projectId);
  assert.equal(existsSync(oldPath), false);
  const [record] = registry.history(prior.projectId);
  assert.equal(record.operation, "workspace");
  assert.deepEqual(record.before, prior);
  assert.deepEqual(record.after, moved);
  assert.ok(Number.isFinite(Date.parse(record.occurredAt)));
});

test("linked-worktree relocation is refused before Git repair and accepted after repair", t => {
  const f = fixture("linked-repair");
  const mainPath = createRepository(f, path.join(f.root, "repos", "main"));
  const oldLinkedPath = path.join(f.root, "linked", "feature");
  const newLinkedPath = path.join(f.root, "linked", "feature-moved");
  mkdirSync(path.dirname(oldLinkedPath), { recursive: true });
  git(f, mainPath, ["worktree", "add", "-b", "u06-linked", oldLinkedPath]);
  const registry = openRegistry(f, t);
  const main = registry.registerWorkspace({ workspacePath: mainPath });
  const linked = registry.registerWorkspace({ workspacePath: oldLinkedPath });
  assert.equal(linked.projectId, main.projectId);
  assert.equal(linked.workspaces.find(binding => binding.workspacePath === oldLinkedPath)?.kind, "linked");

  renameSync(oldLinkedPath, newLinkedPath);
  assert.throws(() => registry.confirmWorkspaceRelocation({
    projectId: linked.projectId,
    expectedRevision: linked.revision,
    oldWorkspacePath: oldLinkedPath,
    newWorkspacePath: newLinkedPath,
    confirmed: true,
  }), error => error instanceof ProjectRegistryError,
  "a copied or moved linked checkout cannot be accepted until Git registers the new path");
  assert.deepEqual(registry.get(linked.projectId), linked);

  git(f, mainPath, ["worktree", "repair", newLinkedPath]);
  const repaired = registry.confirmWorkspaceRelocation({
    projectId: linked.projectId,
    expectedRevision: linked.revision,
    oldWorkspacePath: oldLinkedPath,
    newWorkspacePath: newLinkedPath,
    confirmed: true,
  });
  assert.equal(repaired.projectId, linked.projectId);
  assert.equal(repaired.revision, linked.revision + 1);
  assert.equal(repaired.native.memoryRoot, linked.native.memoryRoot);
  assert.ok(repaired.workspaces.some(binding => binding.workspacePath === mainPath && binding.kind === "main"));
  assert.ok(repaired.workspaces.some(binding => binding.workspacePath === newLinkedPath && binding.kind === "linked"));
  assert.equal(repaired.workspaces.some(binding => binding.workspacePath === oldLinkedPath), false);
});

test("same-name projects stay independent when one complete memory tree moves to a new Native root", t => {
  const f = fixture("two-same-name-projects");
  const firstPath = createRepository(f, path.join(f.root, "first", "same-name"));
  const secondPath = createRepository(f, path.join(f.root, "second", "same-name"));
  const registry = openRegistry(f, t);
  const first = registry.registerWorkspace({ workspacePath: firstPath });
  const second = registry.registerWorkspace({ workspacePath: secondPath });
  assert.notEqual(first.projectId, second.projectId);
  assert.notEqual(first.native.key, second.native.key);
  mkdirSync(first.native.memoryRoot, { recursive: true });
  mkdirSync(second.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(first.native.memoryRoot);
  writeFileSync(path.join(second.native.memoryRoot, "MEMORY.md"), "# Other same-name project\n", "utf8");
  const firstBytes = hashTree(first.native.memoryRoot);
  const secondBytes = hashTree(second.native.memoryRoot);
  const newStorageRoot = path.join(f.root, "new-native-cli");
  mkdirSync(newStorageRoot);

  const moved = relocateProjectMemory({
    registry,
    projectId: first.projectId,
    expectedRevision: first.revision,
    nativeStorageRoot: newStorageRoot,
    authorization: { projectId: first.projectId, action: "relocate-memory", confirmed: true },
  });

  assert.equal(moved.status, "relocated");
  assert.equal(moved.sourceRetained, true);
  assert.equal(moved.mapping.projectId, first.projectId);
  assert.equal(moved.mapping.revision, first.revision + 1);
  assert.equal(moved.mapping.native.storageRoot, newStorageRoot);
  assert.deepEqual(hashTree(moved.targetMemoryRoot), firstBytes);
  assert.deepEqual(hashTree(first.native.memoryRoot), firstBytes, "old Native bytes remain as an inactive archive");
  assert.deepEqual(hashTree(second.native.memoryRoot), secondBytes);
  assert.equal(registry.get(second.projectId).native.memoryRoot, second.native.memoryRoot,
    "moving one project must not rewrite a same-name peer or the registry default");
  const activePointers = registry.list().filter(mapping => mapping.projectId === first.projectId);
  assert.equal(activePointers.length, 1);
  assert.equal(activePointers[0].native.memoryRoot, moved.targetMemoryRoot);
  const [record] = registry.history(first.projectId);
  assert.equal(record.operation, "native-storage");
  assert.equal(record.previousRevision, first.revision);
  assert.equal(record.revision, moved.mapping.revision);
  assert.deepEqual(record.before, first);
  assert.deepEqual(record.after, moved.mapping);

  registry.close();
  const reopened = openProjectRegistry(registryOptions(f));
  t.after(() => reopened.close());
  assert.deepEqual(reopened.history(first.projectId), [record],
    "relocation history must survive closing and reopening the SQLite registry");
  assert.deepEqual(reopened.get(first.projectId), moved.mapping);
});

test("existing export and Native targets return diffs and preserve every original byte", t => {
  const f = fixture("existing-target-conflict");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "conflict-project"));
  const registry = openRegistry(f, t);
  const mapping = registry.registerWorkspace({ workspacePath });
  mkdirSync(mapping.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(mapping.native.memoryRoot, { includeLarge: false });
  const sourceBefore = hashTree(mapping.native.memoryRoot);

  const exportParent = path.join(f.root, "exports");
  const existingBundle = path.join(exportParent, "already-owned");
  mkdirSync(existingBundle, { recursive: true });
  const sentinel = path.join(existingBundle, "owner.txt");
  writeFileSync(sentinel, "owned export must not be replaced\n", "utf8");
  const sentinelBefore = readFileSync(sentinel);
  const exportConflict = exportRequest(registry, mapping, existingBundle);
  assert.equal(exportConflict.status, "conflict");
  assert.ok(exportConflict.conflicts.some(item => item.path === "owner.txt"));
  assert.deepEqual(readFileSync(sentinel), sentinelBefore);

  const newStorageRoot = path.join(f.root, "conflicting-native-root");
  mkdirSync(newStorageRoot);
  const existingMemory = path.join(newStorageRoot, "memories", "projects", mapping.native.key, "memory");
  mkdirSync(existingMemory, { recursive: true });
  writeFileSync(path.join(existingMemory, "MEMORY.md"), "# Different owner\n", "utf8");
  const targetBefore = hashTree(existingMemory);
  const relocation = relocateProjectMemory({
    registry,
    projectId: mapping.projectId,
    expectedRevision: mapping.revision,
    nativeStorageRoot: newStorageRoot,
    authorization: { projectId: mapping.projectId, action: "relocate-memory", confirmed: true },
  });
  assert.equal(relocation.status, "conflict");
  assert.ok(relocation.conflicts.length > 0);
  const memoryDiff = relocation.conflicts.find(item => item.path === "memory/MEMORY.md" && item.reason === "content-differs");
  assert.equal(memoryDiff?.expectedSha256, sourceBefore.find(item => item.path === "MEMORY.md")?.sha256);
  assert.equal(memoryDiff?.currentSha256, targetBefore.find(item => item.path === "MEMORY.md")?.sha256);
  assert.equal(registry.get(mapping.projectId).native.memoryRoot, mapping.native.memoryRoot);
  assert.deepEqual(hashTree(mapping.native.memoryRoot), sourceBefore);
  assert.deepEqual(hashTree(existingMemory), targetBefore);
});

test("registry CAS rejects a second owner and a post-write verifier failure rolls SQLite back", t => {
  const f = fixture("registry-cas");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "cas-project"));
  const firstRegistry = openRegistry(f, t);
  const original = firstRegistry.registerWorkspace({ workspacePath });
  const secondRegistry = openProjectRegistry(registryOptions(f));
  t.after(() => secondRegistry.close());
  assert.deepEqual(secondRegistry.get(original.projectId), original);
  const targetA = path.join(f.root, "native-a");
  const targetB = path.join(f.root, "native-b");
  const targetC = path.join(f.root, "native-c");
  mkdirSync(targetA);
  mkdirSync(targetB);
  mkdirSync(targetC);

  let firstVerifyCalls = 0;
  const updated = firstRegistry.relocateNativeStorage({
    projectId: original.projectId,
    expectedRevision: original.revision,
    nativeStorageRoot: targetA,
    confirmed: true,
    verifyTarget: () => { firstVerifyCalls += 1; },
  });
  assert.equal(firstVerifyCalls, 2, "Native target verification brackets the pointer transaction");
  assert.equal(updated.revision, original.revision + 1);

  let staleVerifyCalls = 0;
  expectRegistryError(() => secondRegistry.relocateNativeStorage({
    projectId: original.projectId,
    expectedRevision: original.revision,
    nativeStorageRoot: targetB,
    confirmed: true,
    verifyTarget: () => { staleVerifyCalls += 1; },
  }), "STALE_REVISION");
  assert.equal(staleVerifyCalls, 0, "stale CAS must fail before inspecting or copying a target");
  assert.equal(secondRegistry.get(original.projectId).native.memoryRoot, updated.native.memoryRoot);

  const failure = new Error("synthetic metadata verification failure");
  let rollbackVerifyCalls = 0;
  assert.throws(() => firstRegistry.relocateNativeStorage({
    projectId: original.projectId,
    expectedRevision: updated.revision,
    nativeStorageRoot: targetC,
    confirmed: true,
    verifyTarget: () => {
      rollbackVerifyCalls += 1;
      if (rollbackVerifyCalls === 2) throw failure;
    },
  }), error => error === failure);
  assert.equal(rollbackVerifyCalls, 2);
  assert.deepEqual(firstRegistry.get(original.projectId), updated,
    "throwing after the metadata update must restore the prior SQL mapping");
  assert.equal(firstRegistry.history(original.projectId).length, 1,
    "rolled-back metadata must not leave a relocation history record");

  const asyncTarget = path.join(f.root, "native-async");
  mkdirSync(asyncTarget);
  expectRegistryError(() => firstRegistry.relocateNativeStorage({
    projectId: original.projectId,
    expectedRevision: updated.revision,
    nativeStorageRoot: asyncTarget,
    confirmed: true,
    verifyTarget: async () => undefined,
  }), "INVALID_INPUT");
  assert.deepEqual(firstRegistry.get(original.projectId), updated,
    "an asynchronous verifier cannot commit a pointer update that completes after the transaction");
  assert.equal(firstRegistry.history(original.projectId).length, 1);
});

test("copy, tree-race, verify, and metadata faults retain source and leave targets inactive", t => {
  const scenarios = ["copy", "post-copy", "source-race", "verify", "metadata"];
  for (const scenario of scenarios) {
    const f = fixture(`fault-${scenario}`);
    const workspacePath = createRepository(f, path.join(f.root, "repo", "fault-project"));
    const registry = openRegistry(f, t);
    const mapping = registry.registerWorkspace({ workspacePath });
    mkdirSync(mapping.native.memoryRoot, { recursive: true });
    writeMemoryCorpus(mapping.native.memoryRoot, { includeLarge: false });
    const sourceBefore = hashTree(mapping.native.memoryRoot);
    const targetStorageRoot = path.join(f.root, "fault-target");
    mkdirSync(targetStorageRoot);
    const targetMemoryRoot = path.join(targetStorageRoot, "memories", "projects", mapping.native.key, "memory");
    const injected = new Error(`synthetic ${scenario} failure`);
    const faults = {};
    if (scenario === "copy") faults.afterFileCopy = event => {
      assert.equal(event.copiedFiles, 1);
      throw injected;
    };
    if (scenario === "post-copy") faults.afterCopy = () => { throw injected; };
    if (scenario === "source-race") faults.afterCopy = () => {
      writeFileSync(path.join(mapping.native.memoryRoot, "topics", "racing-write.md"), "arrived during copy\n", "utf8");
    };
    if (scenario === "verify") faults.afterVerify = () => { throw injected; };
    if (scenario === "metadata") faults.afterMetadataWrite = () => { throw injected; };

    assert.throws(() => relocateProjectMemory({
      registry,
      projectId: mapping.projectId,
      expectedRevision: mapping.revision,
      nativeStorageRoot: targetStorageRoot,
      authorization: { projectId: mapping.projectId, action: "relocate-memory", confirmed: true },
      faults,
    }), error => error instanceof ProjectRegistryError || error === injected);
    assert.equal(registry.get(mapping.projectId).native.memoryRoot, mapping.native.memoryRoot,
      `${scenario} failure must keep the old active mapping`);
    assert.equal(existsSync(targetMemoryRoot), true, `${scenario} phase should retain its owned partial target`);
    assert.equal(registry.list().filter(item => item.native.memoryRoot === targetMemoryRoot).length, 0,
      `${scenario} target must remain inactive`);
    assert.equal(registry.history(mapping.projectId).length, 0,
      `${scenario} failure must not persist relocation history`);
    if (scenario === "source-race") {
      assert.equal(existsSync(path.join(mapping.native.memoryRoot, "topics", "racing-write.md")), true,
        "the concurrent source edit is retained");
    } else {
      assert.deepEqual(hashTree(mapping.native.memoryRoot), sourceBefore, `${scenario} must preserve source bytes`);
    }
    if (scenario === "copy") {
      const partial = hashTree(targetMemoryRoot);
      assert.equal(partial.length, 1, "mid-copy failure must retain the file already copied");
      assert.ok(partial.length < sourceBefore.length, "the retained target must show that copying stopped early");
    }
    if (scenario === "post-copy") assert.deepEqual(hashTree(targetMemoryRoot), sourceBefore);
  }
});

test("non-throwing verify-hook edits to source, target, and import bundle abort metadata writes", t => {
  const scenarios = ["afterVerify-source", "afterMetadata-source", "afterMetadata-target"];
  for (const scenario of scenarios) {
    const f = fixture(`verify-race-${scenario}`);
    const workspacePath = createRepository(f, path.join(f.root, "repo", "verify-race-project"));
    const registry = openRegistry(f, t);
    const mapping = registry.registerWorkspace({ workspacePath });
    mkdirSync(mapping.native.memoryRoot, { recursive: true });
    writeMemoryCorpus(mapping.native.memoryRoot, { includeLarge: false });
    const sourceBefore = hashTree(mapping.native.memoryRoot);
    const targetStorageRoot = path.join(f.root, "verify-race-target");
    mkdirSync(targetStorageRoot);
    const targetMemoryRoot = path.join(targetStorageRoot, "memories", "projects", mapping.native.key, "memory");
    const mutatesSource = scenario !== "afterMetadata-target";
    const faults = scenario === "afterVerify-source"
      ? { afterVerify: () => writeFileSync(path.join(mapping.native.memoryRoot, "MEMORY.md"), "# source changed\n", "utf8") }
      : scenario === "afterMetadata-source"
        ? { afterMetadataWrite: () => writeFileSync(path.join(mapping.native.memoryRoot, "MEMORY.md"), "# source changed after SQL update\n", "utf8") }
        : { afterMetadataWrite: () => writeFileSync(path.join(targetMemoryRoot, "MEMORY.md"), "# target changed\n", "utf8") };

    assert.throws(() => relocateProjectMemory({
      registry,
      projectId: mapping.projectId,
      expectedRevision: mapping.revision,
      nativeStorageRoot: targetStorageRoot,
      authorization: { projectId: mapping.projectId, action: "relocate-memory", confirmed: true },
      faults,
    }), error => error instanceof ProjectRegistryError,
    `${scenario} must recheck observed bytes even when its callback does not throw`);
    assert.equal(registry.get(mapping.projectId).native.memoryRoot, mapping.native.memoryRoot);
    assert.equal(registry.history(mapping.projectId).length, 0);
    assert.equal(registry.list().filter(item => item.native.memoryRoot === targetMemoryRoot).length, 0);
    if (mutatesSource) {
      assert.match(readFileSync(path.join(mapping.native.memoryRoot, "MEMORY.md"), "utf8"), /source changed/);
      assert.deepEqual(hashTree(targetMemoryRoot), sourceBefore,
        "the attempted target remains an inactive copy of the pre-race source");
    } else {
      assert.deepEqual(hashTree(mapping.native.memoryRoot), sourceBefore);
      assert.notDeepEqual(hashTree(targetMemoryRoot), sourceBefore,
        "the target edit remains visible while the SQL mapping rolls back");
    }
  }

  const source = fixture("import-bundle-race-source");
  const sourceWorkspace = createRepository(source, path.join(source.root, "repo", "bundle-race-project"));
  const sourceRegistry = openRegistry(source, t);
  const sourceMapping = sourceRegistry.registerWorkspace({ workspacePath: sourceWorkspace });
  mkdirSync(sourceMapping.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(sourceMapping.native.memoryRoot, { includeLarge: false });
  const sourceBefore = hashTree(sourceMapping.native.memoryRoot);
  const exportsDirectory = path.join(source.root, "exports");
  mkdirSync(exportsDirectory);
  const exported = exportRequest(sourceRegistry, sourceMapping, path.join(exportsDirectory, "authorized-bundle"));

  const target = fixture("import-bundle-race-target");
  const targetWorkspace = path.join(target.root, "repo-copy", "bundle-race-project");
  mkdirSync(path.dirname(targetWorkspace), { recursive: true });
  cpSync(sourceWorkspace, targetWorkspace, { recursive: true, preserveTimestamps: true });
  const targetRegistry = openRegistry(target, t);
  const targetMemoryRoot = path.join(target.nativeStorageRoot, "memories", "projects", sourceMapping.native.key, "memory");
  const validBundle = readProjectMemoryExport(exported.bundleRoot);
  const importAuthorization = {
    projectId: sourceMapping.projectId,
    manifestSha256: validBundle.manifestSha256,
    action: "import",
    confirmed: true,
  };
  const relativeNativeRoot = `relative-u06-import-${randomUUID()}`;
  const resolvedRelativeNativeRoot = path.resolve(relativeNativeRoot);
  assert.equal(existsSync(resolvedRelativeNativeRoot), false);
  expectRegistryError(() => importProjectMemory({
    registry: targetRegistry,
    bundleRoot: exported.bundleRoot,
    workspacePath: targetWorkspace,
    nativeStorageRoot: relativeNativeRoot,
    authorization: importAuthorization,
  }), "INVALID_INPUT");
  assert.equal(existsSync(resolvedRelativeNativeRoot), false,
    "relative storage roots must be rejected before path.resolve can turn them into owned roots");

  assert.throws(() => importProjectMemory({
    registry: targetRegistry,
    bundleRoot: exported.bundleRoot,
    workspacePath: targetWorkspace,
    nativeStorageRoot: target.nativeStorageRoot,
    authorization: importAuthorization,
    faults: {
      afterMetadataWrite: () => writeFileSync(
        path.join(exported.bundleRoot, "memory", "MEMORY.md"), "# bundle changed after metadata write\n", "utf8",
      ),
    },
  }), error => error instanceof ProjectRegistryError,
  "an authorized manifest or payload change during the SQLite transaction must abort import");
  assert.equal(targetRegistry.list().length, 0);
  assert.deepEqual(targetRegistry.history(sourceMapping.projectId), []);
  assert.equal(existsSync(targetMemoryRoot), true, "the complete imported target remains inactive after rollback");
  assert.deepEqual(hashTree(targetMemoryRoot), sourceBefore);
  assert.deepEqual(hashTree(sourceMapping.native.memoryRoot), sourceBefore,
    "the original Native source tree remains available after bundle tampering");
});

test("relative Native storage targets are rejected before normalization", t => {
  const f = fixture("relative-native-root");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "relative-root-project"));
  const registry = openRegistry(f, t);
  const mapping = registry.registerWorkspace({ workspacePath });
  mkdirSync(mapping.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(mapping.native.memoryRoot, { includeLarge: false });
  const sourceBefore = hashTree(mapping.native.memoryRoot);
  const relativeRoot = `relative-u06-relocate-${randomUUID()}`;
  const resolved = path.resolve(relativeRoot);
  assert.equal(existsSync(resolved), false);

  expectRegistryError(() => relocateProjectMemory({
    registry,
    projectId: mapping.projectId,
    expectedRevision: mapping.revision,
    nativeStorageRoot: relativeRoot,
    authorization: { projectId: mapping.projectId, action: "relocate-memory", confirmed: true },
  }), "INVALID_INPUT");
  assert.equal(existsSync(resolved), false);
  assert.deepEqual(registry.get(mapping.projectId), mapping);
  assert.deepEqual(hashTree(mapping.native.memoryRoot), sourceBefore);
  assert.deepEqual(registry.history(mapping.projectId), []);
});

test("unsafe junctions, hard links, path depth, and file-size limits are rejected", async t => {
  await t.test("junction below the memory root", subtest => {
    const f = fixture("unsafe-junction");
    const workspacePath = createRepository(f, path.join(f.root, "repo", "junction-project"));
    const registry = openRegistry(f, subtest);
    const mapping = registry.registerWorkspace({ workspacePath });
    mkdirSync(mapping.native.memoryRoot, { recursive: true });
    const outside = path.join(f.root, "outside");
    const junction = path.join(mapping.native.memoryRoot, "linked-directory");
    mkdirSync(outside);
    try {
      symlinkSync(outside, junction, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        subtest.skip("the Windows host does not allow a synthetic junction here");
        return;
      }
      throw error;
    }
    const parent = path.join(f.root, "exports");
    mkdirSync(parent);
    assert.throws(() => exportRequest(registry, mapping, path.join(parent, "must-reject")),
      error => error instanceof ProjectRegistryError && error.code === "UNSAFE_PATH");
    assert.equal(readdirSync(outside).length, 0);
  });

  await t.test("hard-linked aliases", subtest => {
    const f = fixture("unsafe-hardlink");
    const workspacePath = createRepository(f, path.join(f.root, "repo", "hardlink-project"));
    const registry = openRegistry(f, subtest);
    const mapping = registry.registerWorkspace({ workspacePath });
    mkdirSync(mapping.native.memoryRoot, { recursive: true });
    const original = path.join(mapping.native.memoryRoot, "MEMORY.md");
    writeFileSync(original, "synthetic hard-link target\n", "utf8");
    try {
      linkSync(original, path.join(mapping.native.memoryRoot, "alias.md"));
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN", "ENOTSUP"].includes(error?.code)) {
        subtest.skip("the Windows host does not allow a synthetic hard link here");
        return;
      }
      throw error;
    }
    const parent = path.join(f.root, "exports");
    mkdirSync(parent);
    assert.equal(lstatSync(original).nlink, 2);
    assert.throws(() => exportRequest(registry, mapping, path.join(parent, "must-reject")),
      error => error instanceof ProjectRegistryError && error.code === "UNSAFE_PATH");
  });

  await t.test("Unicode normalization aliases", subtest => {
    const f = fixture("unsafe-name-alias");
    const workspacePath = createRepository(f, path.join(f.root, "repo", "alias-project"));
    const registry = openRegistry(f, subtest);
    const mapping = registry.registerWorkspace({ workspacePath });
    mkdirSync(mapping.native.memoryRoot, { recursive: true });
    const composed = path.join(mapping.native.memoryRoot, "caf\u00e9.txt");
    const decomposed = path.join(mapping.native.memoryRoot, "cafe\u0301.txt");
    writeFileSync(composed, "first spelling\n", "utf8");
    writeFileSync(decomposed, "second spelling\n", "utf8");
    const names = readdirSync(mapping.native.memoryRoot);
    if (names.length !== 2) {
      subtest.skip("the host filesystem normalizes these two synthetic names to one entry");
      return;
    }
    const parent = path.join(f.root, "exports");
    mkdirSync(parent);
    assert.throws(() => exportRequest(registry, mapping, path.join(parent, "must-reject")),
      error => error instanceof ProjectRegistryError && error.code === "UNSAFE_PATH");
  });

  await t.test("maximum supported depth and 5 MiB file boundary", subtest => {
    const f = fixture("limits-at-boundary");
    const workspacePath = createRepository(f, path.join(f.root, "repo", "boundary-project"));
    const registry = openRegistry(f, subtest);
    const mapping = registry.registerWorkspace({ workspacePath });
    mkdirSync(mapping.native.memoryRoot, { recursive: true });
    const depthParts = Array.from({ length: 16 }, (_, index) => `d${String(index + 1).padStart(2, "0")}`);
    const deepest = path.join(mapping.native.memoryRoot, ...depthParts);
    mkdirSync(deepest, { recursive: true });
    writeFileSync(path.join(deepest, "boundary.txt"), "depth sixteen\n", "utf8");
    writeFileSync(path.join(mapping.native.memoryRoot, "max-size.bin"), Buffer.alloc(5 * 1024 * 1024, 0x5a));
    const parent = path.join(f.root, "exports");
    mkdirSync(parent);
    const accepted = exportRequest(registry, mapping, path.join(parent, "within-limits"));
    assert.equal(accepted.status, "exported");

    const tooDeep = path.join(deepest, "d17");
    mkdirSync(tooDeep);
    writeFileSync(path.join(tooDeep, "over-depth.txt"), "too deep\n", "utf8");
    assert.throws(() => exportRequest(registry, mapping, path.join(parent, "depth-over")),
      error => error instanceof ProjectRegistryError);
  });

  await t.test("one byte above the 5 MiB file cap", subtest => {
    const f = fixture("limits-over-file");
    const workspacePath = createRepository(f, path.join(f.root, "repo", "over-limit-project"));
    const registry = openRegistry(f, subtest);
    const mapping = registry.registerWorkspace({ workspacePath });
    mkdirSync(mapping.native.memoryRoot, { recursive: true });
    writeFileSync(path.join(mapping.native.memoryRoot, "over.bin"), Buffer.alloc(5 * 1024 * 1024 + 1, 0x6b));
    const parent = path.join(f.root, "exports");
    mkdirSync(parent);
    assert.throws(() => exportRequest(registry, mapping, path.join(parent, "must-reject")),
      error => error instanceof ProjectRegistryError);
  });

  await t.test("1024-file and 64 MiB tree limits accept the boundary and reject the next byte or file", subtest => {
    const countFixture = fixture("limits-file-count");
    const countWorkspace = createRepository(countFixture, path.join(countFixture.root, "repo", "count-project"));
    const countRegistry = openRegistry(countFixture, subtest);
    const countMapping = countRegistry.registerWorkspace({ workspacePath: countWorkspace });
    const notesDirectory = path.join(countMapping.native.memoryRoot, "notes");
    mkdirSync(notesDirectory, { recursive: true });
    for (let index = 0; index < 1024; index += 1) {
      writeFileSync(path.join(notesDirectory, `note-${String(index).padStart(4, "0")}.bin`), Buffer.alloc(0));
    }
    const countExportParent = path.join(countFixture.root, "exports");
    mkdirSync(countExportParent);
    const countExport = exportRequest(countRegistry, countMapping, path.join(countExportParent, "exactly-1024"));
    assert.equal(countExport.manifest.fileCount, 1024);
    writeFileSync(path.join(notesDirectory, "note-1024.bin"), Buffer.alloc(0));
    assert.throws(() => exportRequest(countRegistry, countMapping, path.join(countExportParent, "over-1024")),
      error => error instanceof ProjectRegistryError && error.code === "UNSAFE_PATH");

    const bytesFixture = fixture("limits-total-bytes");
    const bytesWorkspace = createRepository(bytesFixture, path.join(bytesFixture.root, "repo", "bytes-project"));
    const bytesRegistry = openRegistry(bytesFixture, subtest);
    const bytesMapping = bytesRegistry.registerWorkspace({ workspacePath: bytesWorkspace });
    mkdirSync(bytesMapping.native.memoryRoot, { recursive: true });
    const maxFile = Buffer.alloc(5 * 1024 * 1024, 0x31);
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(path.join(bytesMapping.native.memoryRoot, `large-${String(index).padStart(2, "0")}.bin`), maxFile);
    }
    writeFileSync(path.join(bytesMapping.native.memoryRoot, "last-four-mib.bin"), Buffer.alloc(4 * 1024 * 1024, 0x32));
    const bytesExportParent = path.join(bytesFixture.root, "exports");
    mkdirSync(bytesExportParent);
    const bytesExport = exportRequest(bytesRegistry, bytesMapping, path.join(bytesExportParent, "exactly-64-mib"));
    assert.equal(bytesExport.manifest.totalBytes, 64 * 1024 * 1024);
    writeFileSync(path.join(bytesMapping.native.memoryRoot, "over-by-one.bin"), Buffer.from([0x33]));
    assert.throws(() => exportRequest(bytesRegistry, bytesMapping, path.join(bytesExportParent, "over-64-mib")),
      error => error instanceof ProjectRegistryError && error.code === "UNSAFE_PATH");
  });
});

test("more than 4096 empty memory directories is rejected before creating the export destination", t => {
  const f = fixture("limits-directory-count");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "directory-count-project"));
  const registry = openRegistry(f, t);
  const mapping = registry.registerWorkspace({ workspacePath });
  mkdirSync(mapping.native.memoryRoot, { recursive: true });
  for (let index = 0; index < 4097; index += 1) {
    mkdirSync(path.join(mapping.native.memoryRoot, `empty-${String(index).padStart(4, "0")}`));
  }

  const destinationParent = path.join(f.root, "exports");
  mkdirSync(destinationParent);
  const destination = path.join(destinationParent, "must-not-be-created");
  assert.throws(() => exportRequest(registry, mapping, destination),
    error => error instanceof ProjectRegistryError && error.code === "UNSAFE_PATH");
  assert.equal(readdirSync(mapping.native.memoryRoot).length, 4097,
    "the fixture should contain only the deliberately oversized empty-directory tree");
  assert.equal(existsSync(destination), false,
    "the directory-count bound must be enforced before output creation");
});

test("schema 1 migrates transactionally to schema 2 while preserving mappings and keeping memory outside SQLite", t => {
  const f = fixture("schema-migration");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "schema-one-project"));
  const { filename, mapping: initial } = seedSchemaOneRegistry(f, workspacePath);
  mkdirSync(initial.native.memoryRoot, { recursive: true });
  writeMemoryCorpus(initial.native.memoryRoot, { includeLarge: false });
  const memoryBefore = hashTree(initial.native.memoryRoot);

  const migrated = openProjectRegistry(registryOptions(f));
  t.after(() => migrated.close());
  assert.deepEqual(migrated.get(initial.projectId), initial,
    "schema migration must preserve every existing mapping field and revision");
  assert.equal(migrated.resolveWorkspace(workspacePath).projectId, initial.projectId);
  assert.deepEqual(hashTree(initial.native.memoryRoot), memoryBefore,
    "the metadata migration must not rewrite Native memory bytes");
  assert.deepEqual(migrated.history(initial.projectId), [], "legacy mappings have no invented relocation history");
  const check = new Database(filename, { readonly: true });
  try {
    assert.equal(check.pragma("user_version", { simple: true }), 2);
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ["project_relocations", "projects", "workspaces"]);
  } finally {
    check.close();
  }
});

test("schema-1 database with matching column names but missing accepted constraints is rejected without mutation", t => {
  const f = fixture("schema-columns-only-impostor");
  const filename = path.join(f.ownedDirectory, "project-registry.sqlite");
  const impostor = new Database(filename);
  try {
    // A marker and the expected column inventory alone do not establish that
    // this is the accepted registry schema. Deliberately omit constraints,
    // foreign keys, strict typing, and uniqueness.
    impostor.exec(`
      CREATE TABLE projects (
        project_id TEXT,
        revision INTEGER,
        common_dir TEXT,
        common_identity TEXT,
        storage_root TEXT,
        native_key TEXT,
        canonical_key TEXT,
        mode TEXT
      );
      CREATE TABLE workspaces (
        path_key TEXT,
        workspace_path TEXT,
        project_id TEXT,
        common_dir TEXT,
        private_dir TEXT,
        common_identity TEXT,
        private_identity TEXT,
        kind TEXT,
        native_runtime_key TEXT,
        native_path_memory_key TEXT
      );
      PRAGMA application_id=${0x58495052};
      PRAGMA user_version=1;
    `);
  } finally {
    impostor.close();
  }

  const before = readFileSync(filename);
  expectRegistryError(() => openProjectRegistry(registryOptions(f)), "UNSUPPORTED_DATABASE");
  assert.deepEqual(readFileSync(filename), before,
    "rejecting a schema impostor must leave its original SQLite bytes unchanged");

  const check = new Database(filename, { readonly: true });
  try {
    assert.equal(check.pragma("user_version", { simple: true }), 1);
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ["projects", "workspaces"], "rejection must not create the relocation audit table");
  } finally {
    check.close();
  }
});

test("valid schema-1 database with an unexpected explicit index is rejected without migration", t => {
  const f = fixture("schema-extra-index");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "schema-one-project"));
  const { filename } = seedSchemaOneRegistry(f, workspacePath);
  const legacy = new Database(filename);
  try {
    legacy.exec("CREATE INDEX unexpected_project_identity_lookup ON projects(common_identity);");
  } finally {
    legacy.close();
  }

  const before = readFileSync(filename);
  expectRegistryError(() => openProjectRegistry(registryOptions(f)), "UNSUPPORTED_DATABASE");
  assert.deepEqual(readFileSync(filename), before,
    "rejecting an otherwise valid schema-1 database with an extra index must be byte-preserving");

  const check = new Database(filename, { readonly: true });
  try {
    assert.equal(check.pragma("user_version", { simple: true }), 1,
      "rejection must happen before the schema version is advanced");
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ["projects", "workspaces"], "rejection must not create the relocation audit table");
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='unexpected_project_identity_lookup'").get().count, 1,
      "the original unexpected index should remain untouched");
  } finally {
    check.close();
  }
});

test("schema-1 database with a foreign-key orphan is rejected before migration without mutation", t => {
  const f = fixture("schema-orphan-workspace");
  const workspacePath = createRepository(f, path.join(f.root, "repo", "schema-one-project"));
  const { filename } = seedSchemaOneRegistry(f, workspacePath);
  const legacy = new Database(filename);
  try {
    legacy.exec("PRAGMA foreign_keys=OFF;");
    legacy.prepare(`
      INSERT INTO workspaces (
        path_key, workspace_path, project_id, common_dir, private_dir,
        common_identity, private_identity, kind, native_runtime_key, native_path_memory_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "orphan-path-key",
      path.join(f.root, "repo", "orphan-workspace"),
      "missing-project-id",
      "orphan-common-dir",
      "orphan-private-dir",
      "orphan-common-identity",
      "orphan-private-identity",
      "main",
      "synthetic-runtime-key",
      "synthetic-memory-key",
    );
    assert.equal(legacy.pragma("integrity_check", { simple: true }), "ok",
      "the setup should isolate a foreign-key violation that integrity_check does not detect");
    const violations = legacy.pragma("foreign_key_check");
    assert.equal(violations.length, 1);
    assert.equal(violations[0].table, "workspaces");
  } finally {
    legacy.close();
  }

  const before = readFileSync(filename);
  expectRegistryError(() => openProjectRegistry(registryOptions(f)), "CORRUPT_DATABASE");
  assert.deepEqual(readFileSync(filename), before,
    "foreign-key validation must reject before schema migration changes the SQLite file");

  const check = new Database(filename, { readonly: true });
  try {
    assert.equal(check.pragma("user_version", { simple: true }), 1,
      "a rejected schema-1 database must remain at its legacy version");
    assert.equal(check.pragma("integrity_check", { simple: true }), "ok");
    assert.equal(check.pragma("foreign_key_check").length, 1,
      "the original orphan should remain available for diagnosis");
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    assert.deepEqual(tables, ["projects", "workspaces"], "rejection must not create the relocation audit table");
  } finally {
    check.close();
  }
});
