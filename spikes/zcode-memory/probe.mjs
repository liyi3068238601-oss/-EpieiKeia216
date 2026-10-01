import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function readArg(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1]) throw new Error("Missing value for " + name);
  return args[index + 1];
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

const workspaceRoot = resolve(readArg("--root") ?? resolve(scriptDir, "../.."));
const attemptRoot = resolve(workspaceRoot, "evidence/P00-U08/20261001-01");
const allowedOutputRoots = [
  resolve(workspaceRoot, "evidence/P00-U08"),
  resolve(workspaceRoot, "evidence/P00-U11"),
];
const outputDir = resolve(
  readArg("--output-dir") ?? join(attemptRoot, "runs", "run-" + Date.now()),
);
if (!allowedOutputRoots.some((root) => isWithin(root, outputDir))) {
  throw new Error("--output-dir must be inside evidence/P00-U08 or evidence/P00-U11");
}

const cliRoot = resolve(workspaceRoot, ".runtime/P00/zcode/source/apps/zcode-cli");
const coreDist = join(cliRoot, "packages/core/dist");
const adaptersDist = join(cliRoot, "packages/adapters/dist");
const sourceRoot = resolve(workspaceRoot, ".runtime/P00/zcode/source/apps/zcode-cli");
const pinnedSourceRoot = resolve(workspaceRoot, ".runtime/P00/zcode/source");
const expectedSourceCommit = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";

function captureSourceGitState() {
  const commands = [];
  for (const args of [["rev-parse", "HEAD"], ["status", "--porcelain"]]) {
    const result = spawnSync("git", args, { cwd: pinnedSourceRoot, encoding: "utf8" });
    commands.push({
      executable: "git",
      args,
      cwd: pinnedSourceRoot,
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error("Cannot verify pinned ZCode source checkout: git " + args.join(" "));
    }
  }
  return {
    head: commands[0].stdout.trim(),
    status: commands[1].stdout,
    commands,
  };
}

const sourceGitBefore = captureSourceGitState();
if (sourceGitBefore.head !== expectedSourceCommit || sourceGitBefore.status !== "") {
  throw new Error(
    "Pinned ZCode source must be at " +
      expectedSourceCommit +
      " and clean; got HEAD=" +
      sourceGitBefore.head +
      " status=" +
      JSON.stringify(sourceGitBefore.status),
  );
}

const imports = {
  executor: join(coreDist, "tool/executor/impl.js"),
  registry: join(coreDist, "tool/registry.js"),
  permission: join(coreDist, "permission/service.js"),
  write: join(coreDist, "tool/handlers/write.js"),
  edit: join(coreDist, "tool/handlers/edit.js"),
  read: join(coreDist, "tool/handlers/read.js"),
  persistentMemory: join(coreDist, "subagent/persistent-memory.js"),
  projectMemoryRoot: join(coreDist, "memory/project-root.js"),
  childPolicy: join(coreDist, "subagent/tool-policy.js"),
  fileSystem: join(adaptersDist, "fs/index.js"),
};

for (const [name, path] of Object.entries(imports)) {
  await stat(path).catch(() => {
    throw new Error("Missing pinned runtime entry " + name + ": " + path);
  });
}

await mkdir(dirname(outputDir), { recursive: true });
await mkdir(outputDir);
await writeFile(
  join(outputDir, ".gitignore"),
  "fixtures/\nuser-storage/\nmain-memory-storage/\n",
  "utf8",
);

const modules = {};
for (const [name, path] of Object.entries(imports)) {
  modules[name] = await import(pathToFileURL(path).href);
}

const { ToolExecutorImpl } = modules.executor;
const { ToolRegistryImpl } = modules.registry;
const { PermissionService, defaultPermissionConfig } = modules.permission;
const { writeToolEntry } = modules.write;
const { editToolEntry } = modules.edit;
const { readToolEntry } = modules.read;
const { loadPersistentAgentMemory, projectPersistentAgentMemoryTools } = modules.persistentMemory;
const { resolveProjectMemoryRoot } = modules.projectMemoryRoot;
const { filterSubagentChildToolNames } = modules.childPolicy;
const { createNodeFileSystemAdapter } = modules.fileSystem;

const fileSystemPort = createNodeFileSystemAdapter();
const fixtureRoot = join(outputDir, "fixtures");
const fixtureRepo = join(fixtureRoot, "seed-repository");
const userStorageRoot = join(outputDir, "user-storage");
const mainMemoryStorageRoot = join(outputDir, "main-memory-storage");
const worktreeA = join(fixtureRoot, "worktree-a", "TwinProject");
const worktreeB = join(fixtureRoot, "worktree-b", "TwinProject");
const movedA = join(fixtureRoot, "moved", "TwinProject");
const memoryRuntime = {
  enabled: true,
  use: true,
  storageRoot: userStorageRoot,
};
const sameAgentName = "Memory Keeper";
const gitCommands = [];

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  const row = {
    executable: "git",
    args,
    cwd,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  gitCommands.push(row);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("Git fixture command failed (" + result.status + "): " + args.join(" "));
  }
  return row;
}

await mkdir(dirname(worktreeA), { recursive: true });
await mkdir(dirname(worktreeB), { recursive: true });
await mkdir(fixtureRepo, { recursive: true });
await writeFile(join(fixtureRepo, "fixture.txt"), "Synthetic U08 git worktree fixture.\n");
runGit(
  ["-c", "user.name=P00-U08 fixture", "-c", "user.email=p00-u08@example.invalid", "init", "-q"],
  fixtureRepo,
);
runGit(["add", "fixture.txt"], fixtureRepo);
runGit(
  [
    "-c",
    "user.name=P00-U08 fixture",
    "-c",
    "user.email=p00-u08@example.invalid",
    "commit",
    "-m",
    "Create isolated U08 fixture",
  ],
  fixtureRepo,
);
runGit(["worktree", "add", "--detach", worktreeA, "HEAD"], fixtureRepo);
runGit(["worktree", "add", "--detach", worktreeB, "HEAD"], fixtureRepo);

function profile(scope, extra = {}) {
  return {
    name: sameAgentName,
    description: "Synthetic P00-U08 memory scope fixture",
    disallowedTools: [],
    memory: scope,
    source: "project",
    systemPrompt: "Synthetic test profile. No user or character data.",
    tools: ["Read"],
    ...extra,
  };
}

function projectTools(agentProfile) {
  const projected = projectPersistentAgentMemoryTools({
    memory: memoryRuntime,
    subagents: { profiles: [agentProfile] },
  });
  return projected.subagents.profiles[0];
}

async function loadMemory(agentProfile, root) {
  return loadPersistentAgentMemory({
    fileSystemPort,
    memory: memoryRuntime,
    profile: agentProfile,
    workspaceRoot: root,
  });
}

function makeExecutor(options) {
  const registry = new ToolRegistryImpl();
  const available = options.availableTools ?? ["Read", "Write", "Edit"];
  const entries = { Read: readToolEntry, Write: writeToolEntry, Edit: editToolEntry };
  for (const toolName of available) {
    if (entries[toolName]) registry.register(entries[toolName], { silentDuplicateWarning: true });
  }

  const permissionService = new PermissionService({
    ...defaultPermissionConfig,
    allowedTools: new Set(),
    disallowedTools: new Set(options.disallowedTools ?? []),
  });
  const events = [];
  const executor = new ToolExecutorImpl({
    registry,
    permissionService,
    fileSystemPort,
    emitEvent: async (event) => events.push(event),
    sessionId: "p00-u08-memory-probe",
    workingDirectory: options.workspaceRoot,
    workspaceRoot: options.workspaceRoot,
    getMemoryRoot: () => options.memoryRoot,
    getMode: () => options.mode ?? "plan",
    readFileState: new Map(),
  });
  return { executor, events, registry };
}

let callSequence = 0;
async function execute(executor, name, input) {
  callSequence += 1;
  return executor.execute({
    id: "u08-" + String(callSequence).padStart(3, "0"),
    name,
    input,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error("ASSERTION_FAILED: " + message);
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

const matrix = [];
const scopeRoots = { A: {}, B: {} };
const profileProjection = {};
for (const scope of ["user", "project", "local"]) {
  const unprojected = profile(scope);
  const projected = projectTools(unprojected);
  profileProjection[scope] = {
    before: unprojected.tools,
    after: projected.tools,
    disallowedTools: projected.disallowedTools,
  };
  assert(
    projected.tools.includes("Write") && projected.tools.includes("Edit"),
    "memory-enabled " + scope + " profile should project Write and Edit",
  );
  for (const [key, workspaceRoot] of [["A", worktreeA], ["B", worktreeB]]) {
    const state = await loadMemory(projected, workspaceRoot);
    assert(state && state.rootDir, key + "/" + scope + " memory root should resolve");
    scopeRoots[key][scope] = state.rootDir;
    matrix.push({
      project: key,
      projectBasename: "TwinProject",
      scope,
      agentName: sameAgentName,
      rootDir: state.rootDir,
      promptMentionsRoot: state.prompt.includes(state.rootDir),
    });
  }
}

assert(scopeRoots.A.user === scopeRoots.B.user, "user scope should be shared across projects");
assert(scopeRoots.A.project !== scopeRoots.B.project, "same-name projects should isolate project scope");
assert(scopeRoots.A.local !== scopeRoots.B.local, "same-name projects should isolate local scope");

const writes = [];
for (const [projectKey, workspaceRoot] of [["A", worktreeA], ["B", worktreeB]]) {
  for (const scope of ["user", "project", "local"]) {
    const content = "P00-U08 synthetic " + scope + " marker from " + projectKey + "\n";
    const leaf = scope === "user" ? "user-from-" + projectKey + ".md" : "scope-marker.md";
    const filePath = join(scopeRoots[projectKey][scope], leaf);
    const { executor } = makeExecutor({
      workspaceRoot,
      memoryRoot: scopeRoots[projectKey][scope],
      mode: "plan",
    });
    const result = await execute(executor, "Write", { file_path: filePath, content });
    assert(result.success, "Plan+memory Write must succeed for " + projectKey + "/" + scope);
    assert((await fileText(filePath)) === content, "real FS bytes must match " + projectKey + "/" + scope);
    writes.push({
      project: projectKey,
      scope,
      path: filePath,
      success: result.success,
      output: result.output,
      error: result.error ?? null,
      actualText: await fileText(filePath),
    });
  }
}

assert(
  (await fileText(join(scopeRoots.A.project, "scope-marker.md"))) !==
    (await fileText(join(scopeRoots.B.project, "scope-marker.md"))),
  "project scope markers must not bleed across same-name projects",
);
assert(
  (await fileText(join(scopeRoots.A.local, "scope-marker.md"))) !==
    (await fileText(join(scopeRoots.B.local, "scope-marker.md"))),
  "local scope markers must not bleed across same-name projects",
);
assert(
  (await fileText(join(scopeRoots.A.user, "user-from-A.md"))) !== null &&
    (await fileText(join(scopeRoots.B.user, "user-from-B.md"))) !== null,
  "user scope must be visible from the shared root",
);

const outsidePlanPath = join(worktreeA, "outside-memory-plan-denied.md");
const outsideExecutor = makeExecutor({
  workspaceRoot: worktreeA,
  memoryRoot: scopeRoots.A.project,
  mode: "plan",
}).executor;
const outsideResult = await execute(outsideExecutor, "Write", {
  file_path: outsidePlanPath,
  content: "must stay absent\n",
});
assert(!outsideResult.success, "Plan-mode Write outside memory must be denied");
assert((await fileText(outsidePlanPath)) === null, "Plan-mode denial must leave no file");

const explicitWritePath = join(scopeRoots.A.project, "explicit-deny.md");
const explicitExecutor = makeExecutor({
  workspaceRoot: worktreeA,
  memoryRoot: scopeRoots.A.project,
  mode: "plan",
  disallowedTools: ["Write", "Edit"],
}).executor;
const explicitWriteResult = await execute(explicitExecutor, "Write", {
  file_path: explicitWritePath,
  content: "must stay absent\n",
});
assert(!explicitWriteResult.success, "explicit disallowedTools must deny memory Write");
assert((await fileText(explicitWritePath)) === null, "explicit Write denial must leave no file");

const editTarget = join(scopeRoots.A.project, "scope-marker.md");
const editBefore = await fileText(editTarget);
const explicitEditResult = await execute(explicitExecutor, "Edit", {
  file_path: editTarget,
  old_string: "synthetic project marker from A",
  new_string: "tampered",
});
assert(!explicitEditResult.success, "explicit disallowedTools must deny memory Edit");
const editAfterBeforeMove = await fileText(editTarget);
assert(editAfterBeforeMove === editBefore, "explicit Edit denial must leave bytes unchanged");

const readOnlyProfile = profile("project", {
  tools: ["Read"],
  disallowedTools: ["Write", "Edit"],
});
const projectedReadOnly = projectTools(readOnlyProfile);
const childVisibleTools = filterSubagentChildToolNames(
  projectedReadOnly.tools,
  projectedReadOnly.disallowedTools,
);
assert(
  projectedReadOnly.tools.includes("Write") && projectedReadOnly.tools.includes("Edit"),
  "persistent-memory projection adds Write/Edit even to a tools:Read-only profile",
);
assert(
  !childVisibleTools.includes("Write") && !childVisibleTools.includes("Edit"),
  "explicit child disallow rules must filter memory Write/Edit",
);
const childExecutor = makeExecutor({
  workspaceRoot: worktreeA,
  memoryRoot: scopeRoots.A.project,
  mode: "plan",
  availableTools: childVisibleTools,
}).executor;
const filteredWritePath = join(scopeRoots.A.project, "filtered-child-deny.md");
const filteredChildResult = await execute(childExecutor, "Write", {
  file_path: filteredWritePath,
  content: "must stay absent\n",
});
assert(!filteredChildResult.success, "executor must reject a tool removed by child filtering");
assert((await fileText(filteredWritePath)) === null, "filtered child Write must leave no file");

const noMemoryProfile = { ...profile("project"), memory: undefined };
const noMemoryProjected = projectTools(noMemoryProfile);
assert(
  !noMemoryProjected.tools.includes("Write") && !noMemoryProjected.tools.includes("Edit"),
  "profiles without memory must not receive persistent-memory Write/Edit",
);

const collisionA = await loadMemory(
  projectTools(profile("project", { name: "Researcher/QA" })),
  worktreeB,
);
const collisionB = await loadMemory(
  projectTools(profile("project", { name: "Researcher:QA" })),
  worktreeB,
);
assert(
  collisionA.rootDir === collisionB.rootDir,
  "distinct profile names that sanitize to the same key currently collide",
);

await mkdir(dirname(movedA), { recursive: true });
runGit(["worktree", "move", worktreeA, movedA], fixtureRepo);
const movedRoots = {};
for (const scope of ["user", "project", "local"]) {
  const movedState = await loadMemory(projectTools(profile(scope)), movedA);
  movedRoots[scope] = movedState.rootDir;
}
assert(
  movedRoots.project === join(movedA, ".zcode", "agent-memory", "Memory-Keeper"),
  "project scope should resolve beneath the moved workspace",
);
assert(
  movedRoots.local === join(movedA, ".zcode", "agent-memory-local", "Memory-Keeper"),
  "local scope should resolve beneath the moved workspace",
);
assert(movedRoots.user === scopeRoots.A.user, "user scope should survive workspace move unchanged");
assert(
  (await fileText(join(movedRoots.project, "scope-marker.md"))) ===
    "P00-U08 synthetic project marker from A\n",
  "project scope marker should move with its containing workspace",
);
assert(
  (await fileText(join(movedRoots.local, "scope-marker.md"))) ===
    "P00-U08 synthetic local marker from A\n",
  "local scope marker should move with its containing workspace",
);
assert(
  (await fileText(join(scopeRoots.B.project, "scope-marker.md"))) ===
    "P00-U08 synthetic project marker from B\n",
  "other same-name worktree must remain isolated after move",
);

const mainRootWithoutIdentityBeforeMove = resolveProjectMemoryRoot({
  cliStorageRoot: mainMemoryStorageRoot,
  workspacePath: worktreeA,
});
const mainRootWithoutIdentityMoved = resolveProjectMemoryRoot({
  cliStorageRoot: mainMemoryStorageRoot,
  workspacePath: movedA,
});
const mainRootWithoutIdentityB = resolveProjectMemoryRoot({
  cliStorageRoot: mainMemoryStorageRoot,
  workspacePath: worktreeB,
});
const mainRootWithIdentityMoved = resolveProjectMemoryRoot({
  cliStorageRoot: mainMemoryStorageRoot,
  workspaceIdentity: "u08-fixture-project-stable-id",
  workspacePath: movedA,
});
const mainRootWithIdentityB = resolveProjectMemoryRoot({
  cliStorageRoot: mainMemoryStorageRoot,
  workspaceIdentity: "u08-fixture-project-stable-id",
  workspacePath: worktreeB,
});
const mainRootWithDifferentIdentity = resolveProjectMemoryRoot({
  cliStorageRoot: mainMemoryStorageRoot,
  workspaceIdentity: "u08-fixture-project-other-id",
  workspacePath: worktreeB,
});
assert(
  mainRootWithoutIdentityMoved !== mainRootWithoutIdentityB,
  "main memory root without identity should separate distinct worktree paths",
);
assert(
  mainRootWithoutIdentityBeforeMove !== mainRootWithoutIdentityMoved,
  "main memory root without identity should change when the workspace path moves",
);
assert(
  mainRootWithIdentityMoved === mainRootWithIdentityB,
  "same explicit workspaceIdentity should share main memory root across worktrees",
);
assert(
  mainRootWithIdentityMoved !== mainRootWithDifferentIdentity,
  "different explicit workspaceIdentity values should isolate main memory roots",
);

const otherNamedProfile = await loadMemory(
  projectTools(profile("project", { name: "Memory Observer" })),
  movedA,
);
assert(
  otherNamedProfile.rootDir !== movedRoots.project,
  "different agent names should resolve distinct project memory roots",
);

const sourceFiles = [
  "packages/core/src/subagent/persistent-memory.ts",
  "packages/core/src/subagent/persistent-memory-prompt.ts",
  "packages/core/src/subagent/profile.ts",
  "packages/core/src/subagent/tool-policy.ts",
  "packages/core/src/memory/project-root.ts",
  "packages/core/src/runtime/helpers/project-memory.ts",
  "packages/core/src/tool/executor/impl.ts",
  "packages/core/src/tool/executor/permission-flow.ts",
  "packages/core/src/tool/executor/memory-file-permission.ts",
  "packages/core/src/permission/service.ts",
  "packages/core/src/tool/handlers/write.ts",
  "packages/core/src/tool/handlers/edit.ts",
  "packages/core/src/tool/handlers/read.ts",
  "packages/core/src/tool/path-policy.ts",
  "packages/core/src/memory/memory-file-path.ts",
  "packages/core/src/tool/registry.ts",
  "packages/adapters/src/fs/index.ts",
];
const sourceHashes = [];
for (const relativePath of sourceFiles) {
  const path = join(sourceRoot, relativePath);
  sourceHashes.push({
    path: ".runtime/P00/zcode/source/apps/zcode-cli/" + relativePath.replaceAll("\\", "/"),
    sha256: await sha256(path),
  });
}
const runtimeHashes = [];
for (const [name, path] of Object.entries(imports)) {
  runtimeHashes.push({
    module: name,
    path: relative(workspaceRoot, path).replaceAll("\\", "/"),
    sha256: await sha256(path),
  });
}
const sourceGitAfter = captureSourceGitState();
if (sourceGitAfter.head !== expectedSourceCommit || sourceGitAfter.status !== "") {
  throw new Error(
    "Pinned ZCode source changed during U08 probe; got HEAD=" +
      sourceGitAfter.head +
      " status=" +
      JSON.stringify(sourceGitAfter.status),
  );
}

const results = {
  schemaVersion: 1,
  status: "passed",
  sourceCommit: expectedSourceCommit,
  sourceGitBefore,
  sourceGitAfter,
  sourceTreeUnchanged:
    sourceGitBefore.head === sourceGitAfter.head && sourceGitBefore.status === sourceGitAfter.status,
  workspaceRoot,
  outputDir,
  run: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    externalModelCalls: 0,
    installs: 0,
  },
  scopeMatrix: matrix,
  profileProjection,
  assertions: {
    sameNameProjectsShareUserRoot: scopeRoots.A.user === scopeRoots.B.user,
    sameNameProjectsSeparateProjectRoots: scopeRoots.A.project !== scopeRoots.B.project,
    sameNameProjectsSeparateLocalRoots: scopeRoots.A.local !== scopeRoots.B.local,
    projectAndLocalMarkersIsolated: true,
    userScopeShared: true,
    planModeAllowsMarkdownMemoryWrite: true,
    planModeDeniesWorkspaceWriteOutsideMemory: !outsideResult.success,
    explicitDisallowedWriteAndEditDenied: !explicitWriteResult.success && !explicitEditResult.success,
    childFilterRemovesWriteAndEdit: !childVisibleTools.includes("Write") && !childVisibleTools.includes("Edit"),
    executorRejectsFilteredChildWrite: !filteredChildResult.success,
    movingWorkspaceCarriesProjectAndLocalMemory: true,
    movingWorkspacePreservesUserScope: true,
    worktreesWithoutIdentityHaveDifferentMainMemoryRoots:
      mainRootWithoutIdentityMoved !== mainRootWithoutIdentityB,
    mainMemoryWorkspacePathChangeWithoutIdentity:
      mainRootWithoutIdentityBeforeMove !== mainRootWithoutIdentityMoved,
    explicitWorkspaceIdentitySharesMainRootAcrossWorktrees:
      mainRootWithIdentityMoved === mainRootWithIdentityB,
    distinctWorkspaceIdentitySeparatesMainRoots:
      mainRootWithIdentityMoved !== mainRootWithDifferentIdentity,
    differentAgentNamesSeparateProjectMemoryRoots:
      otherNamedProfile.rootDir !== movedRoots.project,
    sanitizedProfileNameCollisionObserved: collisionA.rootDir === collisionB.rootDir,
  },
  writes,
  negativeCases: {
    planOutsideMemory: {
      path: outsidePlanPath,
      success: outsideResult.success,
      output: outsideResult.output,
      error: outsideResult.error ?? null,
      actualText: await fileText(outsidePlanPath),
    },
    explicitWrite: {
      path: explicitWritePath,
      success: explicitWriteResult.success,
      output: explicitWriteResult.output,
      error: explicitWriteResult.error ?? null,
      actualText: await fileText(explicitWritePath),
    },
    explicitEdit: {
      path: editTarget,
      before: editBefore,
      success: explicitEditResult.success,
      output: explicitEditResult.output,
      error: explicitEditResult.error ?? null,
      afterBeforeMove: editAfterBeforeMove,
      afterAtMovedPath: await fileText(join(movedRoots.project, "scope-marker.md")),
    },
    filteredChildWrite: {
      path: filteredWritePath,
      visibleTools: childVisibleTools,
      success: filteredChildResult.success,
      output: filteredChildResult.output,
      error: filteredChildResult.error ?? null,
      actualText: await fileText(filteredWritePath),
    },
  },
  move: {
    originalWorkspace: worktreeA,
    movedWorkspace: movedA,
    oldWorkspaceExists: await stat(worktreeA).then(() => true, () => false),
    movedRoots,
  },
  profileNameCollision: {
    names: ["Researcher/QA", "Researcher:QA"],
    sameResolvedRoot: collisionA.rootDir === collisionB.rootDir,
    rootDir: collisionA.rootDir,
  },
  mainMemoryRootIdentity: {
    withoutIdentityBeforeMove: mainRootWithoutIdentityBeforeMove,
    withoutIdentityAfterMove: mainRootWithoutIdentityMoved,
    withoutIdentityOtherWorktree: mainRootWithoutIdentityB,
    stableIdentityMovedWorkspace: mainRootWithIdentityMoved,
    stableIdentityOtherWorktree: mainRootWithIdentityB,
    differentIdentity: mainRootWithDifferentIdentity,
    differentAgentNameProjectMemoryRoot: otherNamedProfile.rootDir,
  },
  gitCommands,
  sourceHashes,
  runtimeHashes,
};

const resultPath = join(outputDir, "probe-results.json");
await (await import("node:fs/promises")).writeFile(resultPath, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ status: results.status, outputDir, resultPath, assertions: results.assertions }));
