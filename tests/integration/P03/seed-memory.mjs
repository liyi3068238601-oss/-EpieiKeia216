import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openProjectRegistry } from "../../../dist/packages/projects/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const HOST_ROOT = "E:\\Xiadie\\Xiadie";
const NATIVE_SOURCE = path.join(HOST_ROOT, ".runtime/P01/desktop-source");
const NATIVE_PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const SELECTED_TOPIC = "p03-topic.md";
const UNSELECTED_TOPIC = "p03-unselected.md";
const FOREIGN_TOPIC = "p03-foreign.md";
const WORKSPACE_AGENTS = "Use Read only on the exact synthetic file requested for this test. Project memory selection is checked by the Host; reject unselected and foreign memory topics. Do not write any project file.\n";
const WORKSPACE_README = "P01_ONLY_READ_VALUE=orchid-42\n";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function absolute(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(code);
  return path.resolve(value);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function envValue(environment, expectedName) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === expectedName.toLowerCase());
  return key === undefined ? undefined : environment[key];
}

function safeSystemEnvironment(specEnvironment) {
  const result = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = envValue(specEnvironment, name);
    if (typeof value === "string") result[name] = value;
  }
  if (typeof result.PATH !== "string" || typeof result.SystemRoot !== "string") throw new Error("P03_SAFE_GIT_ENV_INVALID");
  return result;
}

function git(repository, args, env, hooksPath) {
  return execFileSync("git", ["-c", `core.hooksPath=${hooksPath}`, "-c", "core.fsmonitor=false", "-C", repository, ...args], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function assertPhysicalDirectory(filename, root, code) {
  const info = await lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
  const physical = await realpath(filename);
  if (!isInside(root, physical)) throw new Error(code);
  return physical;
}

async function ensureDirectoryTree(root, target) {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("P03_FIXTURE_PATH_OUTSIDE_PROFILE");
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("P03_FIXTURE_DIRECTORY_UNSAFE");
    const physical = await realpath(current);
    if (!isInside(root, physical) || pathKey(physical) !== pathKey(current)) throw new Error("P03_FIXTURE_DIRECTORY_UNSAFE");
  }
}

async function assertOnlyWorkspaceFixtureFiles(workspacePath, expectedFiles) {
  const names = (await readdir(workspacePath)).sort();
  assert.deepEqual(names, [".git", ...expectedFiles].sort(), "The synthetic workspace contains unexpected files");
  const gitDirectory = path.join(workspacePath, ".git");
  const info = await lstat(gitDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("P03_WORKSPACE_GIT_DIRECTORY_INVALID");
  for (const [name, expected] of [["AGENTS.md", WORKSPACE_AGENTS], ["readme.txt", WORKSPACE_README]]) {
    const filename = path.join(workspacePath, name);
    const fileInfo = await lstat(filename);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("P03_WORKSPACE_FIXTURE_FILE_INVALID");
    assert.deepEqual(await readFile(filename), Buffer.from(expected, "utf8"), `Unexpected synthetic workspace fixture: ${name}`);
  }
}

function prepareGitEnvironment(specEnvironment, homePath, globalConfigPath) {
  return {
    ...safeSystemEnvironment(specEnvironment),
    HOME: homePath,
    USERPROFILE: homePath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "P03 Synthetic Fixture",
    GIT_AUTHOR_EMAIL: "p03-fixture@example.invalid",
    GIT_COMMITTER_NAME: "P03 Synthetic Fixture",
    GIT_COMMITTER_EMAIL: "p03-fixture@example.invalid",
  };
}

function configureLocalGit(repository, env, hooksPath) {
  git(repository, ["config", "--local", "user.name", "P03 Synthetic Fixture"], env, hooksPath);
  git(repository, ["config", "--local", "user.email", "p03-fixture@example.invalid"], env, hooksPath);
  git(repository, ["config", "--local", "core.hooksPath", hooksPath], env, hooksPath);
  git(repository, ["config", "--local", "core.fsmonitor", "false"], env, hooksPath);
}

async function commitExistingWorkspace(workspacePath, env, hooksPath) {
  await assertOnlyWorkspaceFixtureFiles(workspacePath, ["AGENTS.md", "readme.txt"]);
  const top = git(workspacePath, ["rev-parse", "--show-toplevel"], env, hooksPath);
  if (pathKey(top) !== pathKey(workspacePath)) throw new Error("P03_WORKSPACE_GIT_ROOT_MISMATCH");
  let hasHead = false;
  try {
    git(workspacePath, ["rev-parse", "--verify", "HEAD"], env, hooksPath);
    hasHead = true;
  } catch { /* P01 owns a fresh initialized repository without a commit. */ }
  if (hasHead) throw new Error("P03_WORKSPACE_GIT_ALREADY_COMMITTED");
  const status = git(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"], env, hooksPath)
    .split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(status, ["?? AGENTS.md", "?? readme.txt"], "The synthetic workspace has unexpected Git changes");
  configureLocalGit(workspacePath, env, hooksPath);
  git(workspacePath, ["add", "--", "AGENTS.md", "readme.txt"], env, hooksPath);
  git(workspacePath, ["commit", "--quiet", "-m", "P03 synthetic workspace fixture"], env, hooksPath);
  return git(workspacePath, ["rev-parse", "HEAD"], env, hooksPath);
}

async function createForeignWorkspace(profileRoot, env, hooksPath) {
  const workspacePath = path.join(profileRoot, "foreign-workspace");
  await mkdir(workspacePath);
  git(path.dirname(workspacePath), ["init", "--quiet", "--initial-branch=main", workspacePath], env, hooksPath);
  await assertPhysicalDirectory(workspacePath, profileRoot, "P03_FOREIGN_WORKSPACE_INVALID");
  const readmePath = path.join(workspacePath, "README.md");
  await writeFile(readmePath, "P03 foreign synthetic project.\n", { encoding: "utf8", flag: "wx" });
  configureLocalGit(workspacePath, env, hooksPath);
  git(workspacePath, ["add", "--", "README.md"], env, hooksPath);
  git(workspacePath, ["commit", "--quiet", "-m", "P03 synthetic foreign project"], env, hooksPath);
  return { workspacePath, commit: git(workspacePath, ["rev-parse", "HEAD"], env, hooksPath) };
}

async function writeMemoryFile(memoryRoot, relative, content, profileRoot) {
  const filename = path.resolve(memoryRoot, ...relative.split("/"));
  if (!isInside(memoryRoot, filename) || !isInside(profileRoot, filename)) throw new Error("P03_MEMORY_FILE_OUTSIDE_PROFILE");
  await writeFile(filename, content, { encoding: "utf8", flag: "wx" });
  const info = await lstat(filename);
  const physical = await realpath(filename);
  if (!info.isFile() || info.isSymbolicLink() || !isInside(profileRoot, physical) || pathKey(physical) !== pathKey(filename)) {
    throw new Error("P03_MEMORY_FILE_INVALID");
  }
  const bytes = await readFile(filename);
  return { path: physical, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function loadNativeHelpers() {
  const sourceRoot = await realpath(NATIVE_SOURCE);
  const sourceCommit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(sourceCommit, NATIVE_PIN, "P03 fixture helpers require the pinned Native source");
  assert.equal(execFileSync("git", ["-C", sourceRoot, "status", "--porcelain"], { encoding: "utf8" }).trim(), "",
    "Pinned Native source must remain clean and read-only");
  const tsxApi = await import(pathToFileURL(path.join(sourceRoot, "node_modules/tsx/dist/esm/api/index.mjs")).href);
  if (typeof tsxApi.register !== "function") throw new Error("P03_TSX_REGISTER_UNAVAILABLE");
  tsxApi.register();
  const rootModule = await import(pathToFileURL(path.join(sourceRoot, "apps/zcode-cli/packages/core/dist/memory/project-root.js")).href);
  const pathsModule = await import(pathToFileURL(path.join(sourceRoot, "apps/zcode-cli/packages/bootstrap/dist/app/paths.js")).href);
  assert.equal(typeof rootModule.resolveProjectMemoryRoot, "function");
  assert.equal(typeof pathsModule.getCliStorageRoot, "function");
  assert.equal(typeof pathsModule.projectIdFromDirectory, "function");
  return { resolveProjectMemoryRoot: rootModule.resolveProjectMemoryRoot,
    getCliStorageRoot: pathsModule.getCliStorageRoot, projectIdFromDirectory: pathsModule.projectIdFromDirectory };
}

async function seed(specPath, outputPath) {
  const specFile = absolute(specPath, "P03_SPEC_PATH_INVALID");
  const outputFile = absolute(outputPath, "P03_RECEIPT_PATH_INVALID");
  const spec = JSON.parse(await readFile(specFile, "utf8"));
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("P03_SPEC_INVALID");
  const outputDirectory = await realpath(absolute(spec.out, "P03_OUTPUT_DIRECTORY_INVALID"));
  if (pathKey(path.dirname(outputFile)) !== pathKey(outputDirectory) || isInside(path.join(outputDirectory, "profile"), outputFile)) {
    throw new Error("P03_RECEIPT_PATH_INVALID");
  }
  const profileRoot = await assertPhysicalDirectory(path.join(outputDirectory, "profile"), outputDirectory, "P03_PROFILE_INVALID");
  const workspacePath = await assertPhysicalDirectory(absolute(spec.workspace, "P03_WORKSPACE_INVALID"), profileRoot, "P03_WORKSPACE_INVALID");
  if (pathKey(workspacePath) !== pathKey(path.join(profileRoot, "workspace"))) throw new Error("P03_WORKSPACE_INVALID");
  const homePath = await assertPhysicalDirectory(absolute(spec.profile_paths?.home, "P03_HOME_INVALID"), profileRoot, "P03_HOME_INVALID");
  const environment = spec.env;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("P03_PROFILE_ENV_INVALID");

  const helpers = await loadNativeHelpers();
  const storageBase = absolute(envValue(environment, "ZCODE_STORAGE_DIR"), "P03_NATIVE_STORAGE_ENV_INVALID");
  const profileStorage = await assertPhysicalDirectory(storageBase, profileRoot, "P03_NATIVE_STORAGE_ENV_INVALID");
  if (pathKey(profileStorage) !== pathKey(path.join(profileRoot, "storage"))) throw new Error("P03_NATIVE_STORAGE_ENV_INVALID");
  const storageRoot = path.resolve(helpers.getCliStorageRoot(profileStorage));
  if (pathKey(storageRoot) !== pathKey(path.join(profileRoot, "storage", "cli"))) throw new Error("P03_NATIVE_STORAGE_ROOT_MISMATCH");

  const registryDirectory = path.join(profileRoot, "p03-registry");
  await mkdir(registryDirectory);
  const registryDirectoryReal = await assertPhysicalDirectory(registryDirectory, profileRoot, "P03_REGISTRY_DIRECTORY_INVALID");
  const registryPath = path.join(registryDirectoryReal, "project-registry.sqlite");
  const emptyGlobalConfig = path.join(registryDirectoryReal, ".disabled-global-git-config");
  await writeFile(emptyGlobalConfig, "", { encoding: "utf8", flag: "wx" });
  const hooksPath = path.join(registryDirectoryReal, "empty-hooks");
  await mkdir(hooksPath);
  const hooksReal = await assertPhysicalDirectory(hooksPath, profileRoot, "P03_EMPTY_HOOKS_INVALID");
  await ensureDirectoryTree(profileRoot, storageRoot);

  const gitEnvironment = prepareGitEnvironment(environment, homePath, emptyGlobalConfig);
  const workspaceCommit = await commitExistingWorkspace(workspacePath, gitEnvironment, hooksReal);
  const foreign = await createForeignWorkspace(profileRoot, gitEnvironment, hooksReal);

  let registry;
  const sourceFiles = [];
  let primaryMapping;
  let foreignMapping;
  let primaryMemoryRoot;
  let foreignMemoryRoot;
  try {
    registry = openProjectRegistry({
      ownedDirectory: registryDirectoryReal,
      nativeStorageRoot: storageRoot,
      nativeMemoryRootResolver: helpers.resolveProjectMemoryRoot,
      nativeRuntimeKeyResolver: helpers.projectIdFromDirectory,
    });
    primaryMapping = registry.registerWorkspace({ workspacePath });
    foreignMapping = registry.registerWorkspace({ workspacePath: foreign.workspacePath });
    primaryMemoryRoot = path.resolve(helpers.resolveProjectMemoryRoot({
      cliStorageRoot: storageRoot, workspacePath, workspaceIdentity: primaryMapping.projectId,
    }));
    foreignMemoryRoot = path.resolve(helpers.resolveProjectMemoryRoot({
      cliStorageRoot: storageRoot, workspacePath: foreign.workspacePath, workspaceIdentity: foreignMapping.projectId,
    }));
    assert.equal(pathKey(primaryMapping.native.storageRoot), pathKey(storageRoot));
    assert.equal(pathKey(foreignMapping.native.storageRoot), pathKey(storageRoot));
    assert.equal(pathKey(primaryMapping.native.memoryRoot), pathKey(primaryMemoryRoot));
    assert.equal(pathKey(foreignMapping.native.memoryRoot), pathKey(foreignMemoryRoot));
    assert.notEqual(primaryMapping.projectId, foreignMapping.projectId);

    await ensureDirectoryTree(profileRoot, primaryMemoryRoot);
    await ensureDirectoryTree(profileRoot, foreignMemoryRoot);
    sourceFiles.push(await writeMemoryFile(primaryMemoryRoot, "MEMORY.md",
      "# P03 project memory\n\n[Selected experience topic](p03-topic.md)\n\n[Unselected sibling topic](p03-unselected.md)\n", profileRoot));
    sourceFiles.push(await writeMemoryFile(primaryMemoryRoot, SELECTED_TOPIC,
      "---\nschema: xiadie-project-note/v0\nauthority: experience-lead\n---\n\n# Selected experience\n\nP03_ONLY_READ_VALUE orchid-42\n", profileRoot));
    sourceFiles.push(await writeMemoryFile(primaryMemoryRoot, UNSELECTED_TOPIC,
      "---\nschema: xiadie-project-note/v0\nauthority: experience-lead\n---\n\n# Unselected sibling\n\nP03_UNSELECTED_READ_VALUE cobalt-19\n", profileRoot));
    sourceFiles.push(await writeMemoryFile(foreignMemoryRoot, "MEMORY.md",
      "# Foreign P03 project memory\n\n[Foreign topic](p03-foreign.md)\n", profileRoot));
    sourceFiles.push(await writeMemoryFile(foreignMemoryRoot, FOREIGN_TOPIC,
      "---\nschema: xiadie-project-note/v0\nauthority: experience-lead\n---\n\n# Foreign project topic\n\nP03_FOREIGN_READ_VALUE violet-17\n", profileRoot));
  } finally {
    registry?.close();
  }

  const registryInfo = await lstat(registryPath);
  const registryRealPath = await realpath(registryPath);
  if (!registryInfo.isFile() || registryInfo.isSymbolicLink() || !isInside(profileRoot, registryRealPath)) {
    throw new Error("P03_REGISTRY_DATABASE_INVALID");
  }
  const selectedTopic = sourceFiles.find((entry) => pathKey(entry.path) === pathKey(path.join(primaryMemoryRoot, SELECTED_TOPIC)));
  const unselectedTopic = sourceFiles.find((entry) => pathKey(entry.path) === pathKey(path.join(primaryMemoryRoot, UNSELECTED_TOPIC)));
  const foreignTopic = sourceFiles.find((entry) => pathKey(entry.path) === pathKey(path.join(foreignMemoryRoot, FOREIGN_TOPIC)));
  assert.ok(selectedTopic && unselectedTopic && foreignTopic);

  // The parent creates this log once for all Native CLI processes in the
  // scenario. Runtime Hosts may append only to its explicit physical identity.
  const auditFilePath = path.join(profileRoot, "p03-memory-audit.jsonl");
  const auditHandle = await open(auditFilePath, "wx", 0o600);
  let auditIdentity;
  try {
    const info = await auditHandle.stat({ bigint: true });
    assert.ok(info.isFile() && info.nlink === 1n);
    assert.equal(pathKey(await realpath(auditFilePath)), pathKey(auditFilePath));
    auditIdentity = { dev: String(info.dev), ino: String(info.ino) };
  } finally {
    await auditHandle.close();
  }

  const receipt = {
    schemaVersion: 1,
    workspacePath,
    workspaceCommit,
    projectId: primaryMapping.projectId,
    projectMemoryRoot: primaryMemoryRoot,
    selectedTopicRelative: SELECTED_TOPIC,
    selectedTopicPath: selectedTopic.path,
    selectedTopicBytes: selectedTopic.bytes,
    selectedTopicSha256: selectedTopic.sha256,
    unselectedTopicRelative: UNSELECTED_TOPIC,
    unselectedTopicPath: unselectedTopic.path,
    foreignWorkspacePath: foreign.workspacePath,
    foreignWorkspaceCommit: foreign.commit,
    foreignProjectId: foreignMapping.projectId,
    foreignMemoryRoot,
    foreignTopicRelative: FOREIGN_TOPIC,
    foreignTopicPath: foreignTopic.path,
    registryDirectory: registryDirectoryReal,
    registryPath: registryRealPath,
    storageRoot,
    sourceFiles,
    auditFile: { path: auditFilePath, identity: auditIdentity },
    nativeSourceCommit: NATIVE_PIN,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeFile(outputFile, receiptBytes, { encoding: "utf8", flag: "wx" });
  return { output: outputFile, bytes: receiptBytes.byteLength, sha256: sha256(receiptBytes), projectId: receipt.projectId,
    foreignProjectId: receipt.foreignProjectId, registryPath: receipt.registryPath, storageRoot: receipt.storageRoot };
}

async function main(argv) {
  if (argv.length !== 4 || argv[0] !== "--spec" || argv[2] !== "--output") {
    throw new Error("USAGE: --spec <desktop-ui.spec.json> --output <newreceipt.json>");
  }
  return seed(argv[1], argv[3]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    const code = typeof error?.message === "string" && /^[A-Z0-9_:-]+$/.test(error.message) ? error.message : "P03_MEMORY_SEED_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
