import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hostRoot = "E:\\Xiadie\\Xiadie";
const experimentRoot = "E:\\Xiadie\\Xiadie\\.runtime\\P03\\reviews\\u03-20261008\\unit-review-01\\experiments";
mkdirSync(experimentRoot, { recursive: true });

// Native imports below must not inherit the user's profile, credentials, or temp path.
const environmentRoot = mkdtempSync(path.join(experimentRoot, "registry-env-"));
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

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(testDirectory, "../../..");
const registryModuleUrl = pathToFileURL(path.join("E:\\Xiadie\\Xiadie\\.runtime\\P03\\reviews\\u03-20261008\\build-review-01\\dist", "packages", "projects", "registry.js")).href;
const { ProjectRegistryError, openProjectRegistry } = await import(registryModuleUrl);

const nativeSourceRoot = path.join(hostRoot, ".runtime", "P01", "desktop-source");
const tsxApiUrl = pathToFileURL(path.join(nativeSourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href;
const { register: registerTsx } = await import(tsxApiUrl);
registerTsx();
const memoryRootUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "core", "dist", "memory", "project-root.js")).href;
const nativePathsUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "app", "paths.js")).href;
const [{ resolveProjectMemoryRoot }, { projectIdFromDirectory }] = await Promise.all([
  import(memoryRootUrl),
  import(nativePathsUrl),
]);

const Database = (await import("better-sqlite3")).default;

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

function createCDriveFixtureRoot() {
  const base = "C:\\Users\\liyi\\.codex\\tmp\\P03-u03-review-d472ae9824394993a5558c4f610b3dac";
  const stat = lstatSync(base);
  assert.equal(stat.isDirectory(), true, "the dedicated C-drive fixture parent must already exist");
  assert.equal(stat.isSymbolicLink(), false, "the dedicated C-drive fixture parent must be physical");
  assert.equal(realpathSync.native(base).toLowerCase(), path.resolve(base).toLowerCase());
  let root;
  do { root = path.join(base, `P03-u03-${randomUUID()}`); } while (existsSync(root));
  mkdirSync(root);
  return root;
}

function assertInsideFixture(f, target) {
  const relative = path.relative(f.root, target);
  assert.notEqual(relative, "");
  assert.equal(path.isAbsolute(relative), false);
  assert.notEqual(relative, "..");
  assert.equal(relative.startsWith(`..${path.sep}`), false);
}

function directoryIdentity(directory) {
  const stat = statSync(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function git(f, cwd, args) {
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${f.noHooks}`,
    "-c", "user.name=P03 U03 Synthetic Author",
    "-c", "user.email=p03-u03@example.invalid",
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

function initRepository(f, directory, { bare = false } = {}) {
  mkdirSync(path.dirname(directory), { recursive: true });
  mkdirSync(directory, { recursive: true });
  git(f, f.root, ["init", ...(bare ? ["--bare"] : []), "--initial-branch=main", directory]);
  if (!bare) {
    writeFileSync(path.join(directory, "README.txt"), "synthetic U03 fixture\n", "utf8");
    git(f, directory, ["add", "README.txt"]);
    git(f, directory, ["commit", "-m", "synthetic fixture"]);
  }
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

function expectRegistryError(action, code) {
  assert.throws(action, error => error instanceof ProjectRegistryError && error.code === code,
    `expected ProjectRegistryError(${code})`);
}

function hashTree(root) {
  const entries = [];
  const visit = (directory, relative = "") => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const childRelative = path.join(relative, name);
      const stat = lstatSync(absolute);
      assert.equal(stat.isSymbolicLink(), false, `legacy fixture unexpectedly contains a link: ${childRelative}`);
      if (stat.isDirectory()) visit(absolute, childRelative);
      else {
        entries.push({
          path: childRelative.replaceAll(path.sep, "/"),
          sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        });
      }
    }
  };
  visit(root);
  return entries;
}

test("actual main and linked Git worktrees resolve to one project with a parent reference", t => {
  const f = fixture("linked-worktrees-");
  const mainPath = initRepository(f, path.join(f.root, "repo", "workspace"));
  const linkedPath = path.join(f.root, "linked", "workspace");
  mkdirSync(path.dirname(linkedPath), { recursive: true });
  git(f, mainPath, ["worktree", "add", "-b", "feature-u03", linkedPath]);

  const registry = openRegistry(f, t);
  const main = registry.registerWorkspace({ workspacePath: mainPath });
  const linked = registry.registerWorkspace({ workspacePath: linkedPath });

  assert.equal(linked.projectId, main.projectId);
  const bindings = registry.resolveWorkspace(mainPath).workspaces;
  assert.equal(bindings.length, 2);
  assert.equal(bindings.find(item => item.workspacePath === mainPath)?.kind, "main");
  const linkedBinding = bindings.find(item => item.workspacePath === linkedPath);
  assert.equal(linkedBinding?.kind, "linked");
  assert.equal(linkedBinding?.worktreeParent, main.projectId);
});

test("same-basename repositories, an actual directory copy, and same-remote forks keep separate UUIDs", t => {
  const f = fixture("same-name-copy-fork-");
  const origin = initRepository(f, path.join(f.root, "origin", "workspace.git"), { bare: true });
  const sourcePath = initRepository(f, path.join(f.root, "source", "same-name"));
  git(f, sourcePath, ["remote", "add", "origin", origin]);
  git(f, sourcePath, ["push", "-u", "origin", "main"]);

  const clonePath = path.join(f.root, "clone", "same-name");
  mkdirSync(path.dirname(clonePath), { recursive: true });
  git(f, f.root, ["clone", "--no-hardlinks", origin, clonePath]);
  const forkPath = path.join(f.root, "fork", "same-name");
  mkdirSync(path.dirname(forkPath), { recursive: true });
  git(f, f.root, ["clone", "--no-hardlinks", origin, forkPath]);
  const copyPath = path.join(f.root, "copy", "same-name");
  mkdirSync(path.dirname(copyPath), { recursive: true });
  cpSync(sourcePath, copyPath, { recursive: true, preserveTimestamps: true });

  const repositories = [sourcePath, clonePath, forkPath, copyPath];
  const headAndRemote = repositories.map(repository => ({
    head: git(f, repository, ["rev-parse", "HEAD"]),
    remote: git(f, repository, ["remote", "get-url", "origin"]),
  }));
  for (const observed of headAndRemote.slice(1)) assert.deepEqual(observed, headAndRemote[0]);
  const registry = openRegistry(f, t);
  const mappings = repositories.map(workspacePath => registry.registerWorkspace({ workspacePath }));
  assert.equal(new Set(mappings.map(mapping => mapping.projectId)).size, repositories.length);
  assert.equal(new Set(mappings.map(mapping => mapping.commonIdentity)).size, repositories.length);
});

test("UUID mappings persist when the SQLite registry is reopened", t => {
  const f = fixture("reopen-");
  const repository = initRepository(f, path.join(f.root, "repo", "persistent"));
  const first = openRegistry(f, t);
  const projectId = first.registerWorkspace({ workspacePath: repository }).projectId;
  first.close();

  const reopened = openProjectRegistry(registryOptions(f));
  t.after(() => reopened.close());
  assert.equal(reopened.resolveWorkspace(repository).projectId, projectId);
  assert.equal(reopened.get(projectId)?.projectId, projectId);
});

test("legacy memory adoption is explicit and preserves the canonical root and every file hash", t => {
  const f = fixture("legacy-adoption-");
  const repository = initRepository(f, path.join(f.root, "repo", "legacy-project"));
  const legacyRoot = resolveProjectMemoryRoot({ cliStorageRoot: f.nativeStorageRoot, workspacePath: repository });
  mkdirSync(path.join(legacyRoot, "topics"), { recursive: true });
  writeFileSync(path.join(legacyRoot, "MEMORY.md"), "# Existing legacy memory\nKeep byte identity.\n", "utf8");
  writeFileSync(path.join(legacyRoot, "topics", "source.bin"), Buffer.from([0, 1, 2, 0xff, 0x80]));
  const beforeFiles = hashTree(legacyRoot);
  const nativeProjects = path.dirname(path.dirname(legacyRoot));
  const beforeRoots = readdirSync(nativeProjects).sort();

  const registry = openRegistry(f, t);
  expectRegistryError(() => registry.registerWorkspace({ workspacePath: repository }), "LEGACY_ADOPTION_REQUIRED");
  assert.equal(registry.list().length, 0);
  assert.deepEqual(readdirSync(nativeProjects).sort(), beforeRoots);

  const adopted = registry.registerWorkspace({ workspacePath: repository, adoptLegacy: true });
  assert.equal(adopted.native.mode, "adopted-legacy");
  assert.equal(adopted.native.memoryRoot, legacyRoot);
  assert.deepEqual(hashTree(legacyRoot), beforeFiles);
  assert.deepEqual(readdirSync(nativeProjects).sort(), beforeRoots);
});

test("a replaced registered path raises an identity conflict and retains the prior project", t => {
  const f = fixture("replaced-path-");
  const repositoryPath = path.join(f.root, "repo", "same-path");
  const repository = initRepository(f, repositoryPath);
  const registry = openRegistry(f, t);
  const prior = registry.registerWorkspace({ workspacePath: repository });

  renameSync(repositoryPath, path.join(f.root, "repo", "old-original"));
  initRepository(f, repositoryPath);
  expectRegistryError(() => registry.registerWorkspace({ workspacePath: repositoryPath }), "IDENTITY_CONFLICT");
  assert.equal(registry.get(prior.projectId)?.projectId, prior.projectId);
  assert.equal(registry.list().length, 1);
});

test("copying a linked worktree without Git registration is rejected", t => {
  const f = fixture("copied-linked-worktree-");
  const mainPath = initRepository(f, path.join(f.root, "repo", "main"));
  const linkedPath = path.join(f.root, "registered", "linked");
  mkdirSync(path.dirname(linkedPath), { recursive: true });
  git(f, mainPath, ["worktree", "add", "-b", "linked-u03", linkedPath]);
  const copiedPath = path.join(f.root, "copied", "linked");
  mkdirSync(path.dirname(copiedPath), { recursive: true });
  cpSync(linkedPath, copiedPath, { recursive: true, preserveTimestamps: true });

  const registry = openRegistry(f, t);
  const main = registry.registerWorkspace({ workspacePath: mainPath });
  expectRegistryError(() => registry.registerWorkspace({ workspacePath: copiedPath }), "UNREGISTERED_WORKTREE");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get(main.projectId)?.projectId, main.projectId);
});

test("a moved repository requires explicit relocation and keeps its old mapping", t => {
  const f = fixture("moved-repository-");
  const oldPath = initRepository(f, path.join(f.root, "repo", "before-move"));
  const newPath = path.join(f.root, "repo", "after-move");
  const registry = openRegistry(f, t);
  const prior = registry.registerWorkspace({ workspacePath: oldPath });

  renameSync(oldPath, newPath);
  expectRegistryError(() => registry.resolveWorkspace(newPath), "RELOCATION_REQUIRED");
  expectRegistryError(() => registry.registerWorkspace({ workspacePath: newPath }), "RELOCATION_REQUIRED");
  assert.equal(registry.get(prior.projectId)?.projectId, prior.projectId);
  assert.equal(registry.list()[0]?.workspaces[0]?.workspacePath, oldPath);
});

test("a standalone repository copied from E to C receives a new UUID and preserves the E mapping", t => {
  const f = fixture("cross-drive-standalone-copy-");
  const sourcePath = initRepository(f, path.join(f.root, "repo", "standalone"));
  assertInsideFixture(f, sourcePath);
  const registry = openRegistry(f, t);
  const original = registry.registerWorkspace({ workspacePath: sourcePath });
  const originalMemoryPointer = original.native.memoryRoot;
  const originalHead = git(f, sourcePath, ["rev-parse", "HEAD"]);
  const originalFiles = hashTree(sourcePath);

  const cRoot = createCDriveFixtureRoot();
  const copiedPath = path.join(cRoot, "standalone-copy");
  cpSync(sourcePath, copiedPath, { recursive: true, preserveTimestamps: true });
  assert.equal(existsSync(sourcePath), true, "the E-drive original must remain in place");
  assert.equal(git(f, copiedPath, ["rev-parse", "HEAD"]), originalHead);
  assert.deepEqual(hashTree(copiedPath), originalFiles);

  const copied = registry.registerWorkspace({ workspacePath: copiedPath });
  assert.notEqual(copied.projectId, original.projectId);
  assert.notEqual(copied.commonIdentity, original.commonIdentity);
  assert.equal(registry.resolveWorkspace(sourcePath).projectId, original.projectId);
  assert.equal(registry.resolveWorkspace(copiedPath).projectId, copied.projectId);
  assert.equal(registry.get(original.projectId)?.native.memoryRoot, originalMemoryPointer);
  assert.deepEqual(hashTree(sourcePath), originalFiles);
});

test("a repaired cross-drive linked-worktree copy requires relocation and preserves its UUID and canonical pointer", t => {
  const f = fixture("cross-drive-linked-repair-");
  const mainPath = initRepository(f, path.join(f.root, "repo", "main"));
  const oldLinkedPath = path.join(f.root, "linked", "feature");
  mkdirSync(path.dirname(oldLinkedPath), { recursive: true });
  git(f, mainPath, ["worktree", "add", "-b", "feature-cross-drive", oldLinkedPath]);
  assertInsideFixture(f, mainPath);
  assertInsideFixture(f, oldLinkedPath);

  const registry = openRegistry(f, t);
  registry.registerWorkspace({ workspacePath: mainPath });
  const original = registry.registerWorkspace({ workspacePath: oldLinkedPath });
  const linkedBinding = original.workspaces.find(binding => binding.workspacePath === oldLinkedPath);
  assert.equal(linkedBinding?.kind, "linked");
  const originalMemoryPointer = original.native.memoryRoot;
  const originalPrivateIdentity = linkedBinding?.privateIdentity;
  assert.ok(originalPrivateIdentity);
  const originalPrivateGitDir = git(f, oldLinkedPath, ["rev-parse", "--absolute-git-dir"]);
  assert.equal(directoryIdentity(originalPrivateGitDir), originalPrivateIdentity);
  const oldFiles = hashTree(oldLinkedPath);

  const cRoot = createCDriveFixtureRoot();
  const repairedPath = path.join(cRoot, "linked-worktree-copy");
  cpSync(oldLinkedPath, repairedPath, { recursive: true, preserveTimestamps: true });
  assert.deepEqual(hashTree(repairedPath), oldFiles);

  const archivedOldPath = path.join(f.root, "archive", "linked-feature-before-repair");
  assertInsideFixture(f, archivedOldPath);
  mkdirSync(path.dirname(archivedOldPath), { recursive: true });
  renameSync(oldLinkedPath, archivedOldPath);
  assert.equal(existsSync(archivedOldPath), true, "the original E-drive worktree must remain as the owned archive");
  assert.equal(existsSync(oldLinkedPath), false, "the original E-drive worktree path must be vacant before repair");
  assert.deepEqual(hashTree(archivedOldPath), oldFiles);

  git(f, mainPath, ["worktree", "repair", repairedPath]);
  const repairedPrivateGitDir = git(f, repairedPath, ["rev-parse", "--absolute-git-dir"]);
  assert.equal(path.resolve(repairedPrivateGitDir).toLowerCase(), path.resolve(originalPrivateGitDir).toLowerCase());
  assert.equal(directoryIdentity(repairedPrivateGitDir), originalPrivateIdentity,
    "Git repair must reconnect the copied path to the registered private worktree directory");

  expectRegistryError(() => registry.resolveWorkspace(repairedPath), "RELOCATION_REQUIRED");
  expectRegistryError(() => registry.registerWorkspace({ workspacePath: repairedPath }), "RELOCATION_REQUIRED");
  assert.equal(registry.get(original.projectId)?.projectId, original.projectId);
  assert.equal(registry.get(original.projectId)?.native.memoryRoot, originalMemoryPointer);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]?.workspaces.find(binding => binding.kind === "linked")?.workspacePath, oldLinkedPath);
});

test("real Native runtime short-key collisions do not merge distinct Git projects", t => {
  const f = fixture("runtime-key-collision-");
  const longCommonPrefix = path.join(f.root, "q".repeat(96));
  const firstPath = initRepository(f, path.join(longCommonPrefix, "first"));
  const secondPath = initRepository(f, path.join(longCommonPrefix, "second"));
  const firstRuntimeKey = projectIdFromDirectory(firstPath);
  const secondRuntimeKey = projectIdFromDirectory(secondPath);
  assert.equal(firstRuntimeKey, secondRuntimeKey, "fixture must collide under the pinned Native 80-character key algorithm");

  const registry = openRegistry(f, t);
  const first = registry.registerWorkspace({ workspacePath: firstPath });
  const second = registry.registerWorkspace({ workspacePath: secondPath });
  assert.notEqual(first.projectId, second.projectId);
  assert.notEqual(first.commonIdentity, second.commonIdentity);
  assert.equal(first.workspaces[0]?.nativeRuntimeKey, second.workspaces[0]?.nativeRuntimeKey);
  assert.equal(registry.list().length, 2);
});

test("a canonical Native memory-key collision errors without leaving a partial mapping", t => {
  const f = fixture("memory-key-collision-");
  const firstPath = initRepository(f, path.join(f.root, "first", "workspace"));
  const secondPath = initRepository(f, path.join(f.root, "second", "workspace"));
  const collidingResolver = input => input.workspaceIdentity === undefined
    ? resolveProjectMemoryRoot(input)
    : path.join(f.nativeStorageRoot, "memories", "projects", "collision-0123456789abcdef", "memory");
  const registry = openRegistry(f, t, { nativeMemoryRootResolver: collidingResolver });
  const first = registry.registerWorkspace({ workspacePath: firstPath });

  expectRegistryError(() => registry.registerWorkspace({ workspacePath: secondPath }), "MEMORY_CONFLICT");
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get(first.projectId)?.projectId, first.projectId);
  expectRegistryError(() => registry.resolveWorkspace(secondPath), "NOT_REGISTERED");
});

test("an unknown existing SQLite database is preserved byte for byte", t => {
  const f = fixture("unknown-database-");
  const filename = path.join(f.ownedDirectory, "project-registry.sqlite");
  const unrelated = new Database(filename);
  unrelated.exec("CREATE TABLE unrelated (value TEXT NOT NULL); INSERT INTO unrelated VALUES ('preserve me');");
  unrelated.close();
  const before = readFileSync(filename);

  expectRegistryError(() => openProjectRegistry(registryOptions(f)), "UNSUPPORTED_DATABASE");
  assert.deepEqual(readFileSync(filename), before);
});

test("junction and symbolic directory roots are rejected", async t => {
  const f = fixture("link-paths-");
  const junctionPath = path.join(f.root, "owned-junction");
  symlinkSync(f.ownedDirectory, junctionPath, "junction");
  expectRegistryError(() => openProjectRegistry(registryOptions(f, { ownedDirectory: junctionPath })), "UNSAFE_PATH");
  expectRegistryError(() => openProjectRegistry(registryOptions(f, { nativeStorageRoot: junctionPath })), "UNSAFE_PATH");

  await t.test("symbolic directory link", subtest => {
    const symbolicPath = path.join(f.root, "owned-symbolic-link");
    try {
      symlinkSync(f.ownedDirectory, symbolicPath, "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "UNKNOWN") {
        subtest.skip("the Windows host does not allow this synthetic directory symlink");
        return;
      }
      throw error;
    }
    expectRegistryError(() => openProjectRegistry(registryOptions(f, { ownedDirectory: symbolicPath })), "UNSAFE_PATH");
  });
});

test("a missing UUID memory location remains a pointer and is never created", t => {
  const f = fixture("pointer-only-");
  const repository = initRepository(f, path.join(f.root, "repo", "pointer-only"));
  const registry = openRegistry(f, t);
  const mapping = registry.registerWorkspace({ workspacePath: repository });

  assert.equal(mapping.native.mode, "uuid");
  assert.equal(existsSync(mapping.native.memoryRoot), false);
  assert.equal(existsSync(path.join(f.nativeStorageRoot, "memories")), false);
});
