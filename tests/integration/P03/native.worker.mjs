import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const PINNED_NATIVE_COMMIT = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const hostRoot = "E:\\Xiadie\\Xiadie";
const experimentRoot = path.join(hostRoot, ".runtime", "P03", "experiments");
const fixtureRoot = process.env.P03_U09_FIXTURE_ROOT;
const scenario = process.env.P03_U09_SCENARIO;
const nativeSourceRoot = process.env.P01_U06_ZCODE_SOURCE;
const nodeExecutable = path.join(hostRoot, ".runtime", "P01", "desktop-build-evidence", "toolchain", "node-v24.14.0-win-x64", "node.exe");
const profileRoot = path.join(fixtureRoot ?? "", "profile");
const home = path.join(profileRoot, "home");
const temp = path.join(profileRoot, "temp");

assert.ok(fixtureRoot && path.isAbsolute(fixtureRoot), "outer runner must supply an absolute owned fixture root");
assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(experimentRoot));
assert.match(path.basename(fixtureRoot), /^u09-native-[0-9a-f-]{36}$/i);
assert.ok(["same-hash-cache", "stat-range-race-recovery", "hook-nonzero", "hook-bad-json",
  "hook-missing-receipt", "hook-timeout", "cancel-recovery", "path-denials"].includes(scenario));
assert.equal(process.versions.node, "24.14.0", "scenario worker must run under the pinned Node runtime");
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(path.resolve(nativeSourceRoot), path.resolve(hostRoot, ".runtime", "P01", "desktop-source"));
assert.equal(execFileSync("git", ["-C", nativeSourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), PINNED_NATIVE_COMMIT);
assert.equal(execFileSync("git", ["-C", nativeSourceRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "");
assert.equal(await realpath(os.tmpdir()), await realpath(temp), "Node temporary files stay under this scenario's owned profile");

const tsxApiUrl = pathToFileURL(path.join(nativeSourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs")).href;
const { register: registerTsx } = await import(tsxApiUrl);
registerTsx();
const nativeBootstrapUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "index.js")).href;
const nativeContractsUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "contracts", "dist", "model", "invocation-context.js")).href;
const nativeProjectRootUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "core", "dist", "memory", "project-root.js")).href;
const nativePathsUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "app", "paths.js")).href;
const nativeProviderRegistryUrl = pathToFileURL(path.join(nativeSourceRoot, "packages", "provider", "src", "registry.ts")).href;
const nativeModelRunnerUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "model", "runner.js")).href;
const nativeFsUrl = pathToFileURL(path.join(nativeSourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "fs", "index.js")).href;
const hostModuleUrl = pathToFileURL(path.join(repositoryRoot, "dist", "packages", "adapters", "zcode", "src", "index.js")).href;
const memoryModuleUrl = pathToFileURL(path.join(repositoryRoot, "dist", "packages", "adapters", "zcode", "src", "project-memory.js")).href;
const registryModuleUrl = pathToFileURL(path.join(repositoryRoot, "dist", "packages", "projects", "registry.js")).href;

const native = await import(nativeBootstrapUrl);
const nativeContracts = await import(nativeContractsUrl);
const nativeProjectRoot = await import(nativeProjectRootUrl);
const nativePaths = await import(nativePathsUrl);
const providerModule = await import(nativeProviderRegistryUrl);
const nativeModelRunner = await import(nativeModelRunnerUrl);
const nativeFs = await import(nativeFsUrl);
const { createXiadieZCodeApp } = await import(hostModuleUrl);
const { createProjectMemoryReader } = await import(memoryModuleUrl);
const { openProjectRegistry } = await import(registryModuleUrl);

const metrics = {
  scenario,
  fixtureId: path.basename(fixtureRoot),
  runtime: `pinned-native-${process.versions.node}`,
  nativeCommit: PINNED_NATIVE_COMMIT,
  provider: "local-loopback-mock",
  fixtureRetained: true,
  outcome: "incomplete",
  listener: undefined,
  nonLoopbackRequests: 0,
  nativeModelRequests: 0,
  nativeReadToolCalls: 0,
  memoryReaderCallbacks: 0,
  memoryReadErrorCodes: [],
  hookRuns: 0,
  hookProcesses: [],
  sourceHashCount: 0,
};
let fixture;

test(`P03 U09 ${scenario} uses real pinned Native and the accepted Host memory seam`, async (t) => {
  fixture = await createFixture(t, scenario, metrics);
  if (scenario === "same-hash-cache") await runSameHashCache(fixture);
  else if (scenario === "stat-range-race-recovery") await runStatRangeRaceRecovery(fixture);
  else if (scenario.startsWith("hook-")) await runHookFailure(fixture, scenario);
  else if (scenario === "cancel-recovery") await runCancelRecovery(fixture);
  else if (scenario === "path-denials") await runPathDenials(fixture);
  metrics.outcome = "passed";
});
async function createFixture(t, activeScenario, resultMetrics) {
  let registry;
  let mock;
  let execution;
  let host;
  const readState = { callbacks: 0, sourceHashes: [], errors: [], raceArmed: false, raceApplied: false, race: undefined };
  t.after(async () => {
    let cleanupFailure;
    try { await host?.close?.(); } catch (error) { cleanupFailure = error; }
    try { await mock?.close?.(); } catch (error) { cleanupFailure ??= error; }
    try { registry?.close?.(); } catch (error) { cleanupFailure ??= error; }
    resultMetrics.nativeModelRequests = mock?.requests.length ?? 0;
    resultMetrics.nativeReadToolCalls = mock?.readTargets.length ?? 0;
    resultMetrics.nonLoopbackRequests = mock?.nonLoopbackRequests ?? 0;
    resultMetrics.hookRuns = execution?.hookRuns ?? 0;
    resultMetrics.hookProcesses = (execution?.processRecords ?? []).map((record) => ({
      kind: record.kind, status: record.status, exitCode: record.exitCode,
      timedOut: record.timedOut, cancelled: record.cancelled,
    }));
    resultMetrics.memoryReaderCallbacks = readState.callbacks;
    resultMetrics.memoryReadErrorCodes = [...readState.errors];
    resultMetrics.sourceHashCount = new Set(readState.sourceHashes).size;
    resultMetrics.race = readState.race;
    process.stdout.write(`P03_U09_NATIVE_RESULT ${JSON.stringify(resultMetrics)}\n`);
    if (cleanupFailure) throw cleanupFailure;
  });

  const root = path.resolve(fixtureRoot);
  const workspacePath = path.join(root, "workspace", "project-a");
  const foreignWorkspacePath = path.join(root, "workspace", "project-b");
  const registryDirectory = path.join(root, "registry");
  const profileStorage = path.join(profileRoot, "storage");
  const nativeStorageRoot = nativePaths.getCliStorageRoot(profileStorage);
  const noHooks = path.join(root, "empty-hooks");
  const foreignDirectory = path.join(root, "foreign");
  await Promise.all([
    mkdir(path.dirname(workspacePath), { recursive: true }),
    mkdir(path.dirname(foreignWorkspacePath), { recursive: true }),
    mkdir(registryDirectory, { recursive: true }),
    mkdir(nativeStorageRoot, { recursive: true }),
    mkdir(noHooks, { recursive: true }),
    mkdir(foreignDirectory, { recursive: true }),
    mkdir(profileRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);
  await initializeGitFixture(root, noHooks, workspacePath);
  await initializeGitFixture(root, noHooks, foreignWorkspacePath);

  registry = openProjectRegistry({
    ownedDirectory: registryDirectory,
    nativeStorageRoot,
    nativeMemoryRootResolver: (input) => nativeProjectRoot.resolveProjectMemoryRoot(input),
    nativeRuntimeKeyResolver: (mappedWorkspace) => nativePaths.projectIdFromDirectory(mappedWorkspace),
  });
  const project = registry.registerWorkspace({ workspacePath });
  const foreignProject = registry.registerWorkspace({ workspacePath: foreignWorkspacePath });
  assert.equal(project.native.storageRoot, nativeStorageRoot,
    "registry uses the actual Native CLI storage root derived from storage.dir");
  assert.equal(project.native.memoryRoot, nativeProjectRoot.resolveProjectMemoryRoot({
    cliStorageRoot: nativeStorageRoot, workspacePath, workspaceIdentity: project.projectId,
  }), "registered primary memory root uses the pinned Native resolver with Host workspace identity");
  assert.equal(project.workspaces[0].nativeRuntimeKey, nativePaths.projectIdFromDirectory(workspacePath),
    "registered Native runtime key uses the pinned Native directory identity helper");
  const memoryRoot = project.native.memoryRoot;
  const foreignMemoryRoot = foreignProject.native.memoryRoot;
  const selectedRelative = "topics/selected.md";
  const unselectedRelative = "topics/unselected.md";
  const foreignMemoryRelative = "topics/foreign.md";
  const selectedPath = path.join(memoryRoot, ...selectedRelative.split("/"));
  const unselectedPath = path.join(memoryRoot, ...unselectedRelative.split("/"));
  const foreignMemoryPath = path.join(foreignMemoryRoot, ...foreignMemoryRelative.split("/"));
  await mkdir(path.dirname(selectedPath), { recursive: true });
  await mkdir(path.dirname(foreignMemoryPath), { recursive: true });
  await writeFile(path.join(memoryRoot, "MEMORY.md"),
    "# Synthetic project memory\n\n[Selected](topics/selected.md)\n[Unselected](topics/unselected.md)\n", "utf8");
  await writeFile(path.join(foreignMemoryRoot, "MEMORY.md"),
    "# Synthetic foreign project memory\n\n[Foreign](topics/foreign.md)\n", "utf8");
  const markers = markersFor(activeScenario);
  await writeFile(selectedPath, `${markers.initial}\n`, "utf8");
  await writeFile(unselectedPath, "U09_UNSELECTED_SECRET_CANARY\n", "utf8");
  await writeFile(foreignMemoryPath, "U09_FOREIGN_MEMORY_SECRET_CANARY\n", "utf8");
  await writeFile(path.join(foreignDirectory, "private.txt"), "U09_FOREIGN_SECRET_CANARY\n", "utf8");
  const fixedRaceTime = new Date("2024-01-02T03:04:05.000Z");
  if (activeScenario === "stat-range-race-recovery") utimesSync(selectedPath, fixedRaceTime, fixedRaceTime);

  const baseReader = createProjectMemoryReader({ registry, workspacePath, selectedTopics: () => [selectedRelative] });
  const projectMemory = Object.freeze({
    capture(...args) { return baseReader.capture(...args); },
    read(snapshot, absoluteFilename) {
      readState.callbacks += 1;
      const relative = path.relative(memoryRoot, absoluteFilename).split(path.sep).join("/");
      try {
        const source = baseReader.read(snapshot, absoluteFilename);
        readState.sourceHashes.push(source.source_hash);
        if (activeScenario === "stat-range-race-recovery" && readState.raceArmed &&
            !readState.raceApplied && relative === selectedRelative) {
          const before = statSync(absoluteFilename);
          writeFileSync(absoluteFilename, `${markers.mutated}\n`, "utf8");
          utimesSync(absoluteFilename, fixedRaceTime, fixedRaceTime);
          const after = statSync(absoluteFilename);
          readState.raceApplied = true;
          readState.race = {
            sameLength: before.size === after.size,
            sameMtimeMs: before.mtimeMs === after.mtimeMs,
            oldSizeBytes: before.size,
            newSizeBytes: after.size,
            oldMtimeMs: before.mtimeMs,
            newMtimeMs: after.mtimeMs,
          };
        }
        return source;
      } catch (error) {
        readState.errors.push(typeof error?.code === "string" ? error.code : "UNKNOWN");
        throw error;
      }
    },
  });
  const pluginStorageRoot = path.join(profileRoot, "plugin-storage");
  const userConfigPath = path.join(profileRoot, "user.json");
  const projectConfigPath = path.join(profileRoot, "project.json");
  const safeEnv = safeEnvironment(home, temp);
  const marketplace = await native.addZCodePluginMarketplace({
    pluginStorageRoot, userConfigPath, projectConfigPath, workingDirectory: workspacePath,
    env: safeEnv, source: path.join(repositoryRoot, "plugins", "xiadie", "marketplace.json"),
  });
  await native.installZCodeMarketplacePlugin({
    pluginStorageRoot, userConfigPath, projectConfigPath, workingDirectory: workspacePath,
    env: safeEnv, marketplace: marketplace.id, pluginName: "xiadie",
  });
  await native.setZCodePluginEnabled({
    pluginStorageRoot, userConfigPath, projectConfigPath, workingDirectory: workspacePath,
    env: safeEnv, plugin: `xiadie@${marketplace.id}`, enabled: true,
  });
  let userConfig = {};
  try { userConfig = JSON.parse(await readFile(userConfigPath, "utf8")); } catch {}
  userConfig.storage = { ...(userConfig.storage ?? {}), dir: profileStorage };
  await writeFile(userConfigPath, JSON.stringify(userConfig, null, 2), "utf8");
  const discovered = native.listZCodePlugins({
    pluginStorageRoot, userConfigPath, projectConfigPath, workingDirectory: workspacePath, env: safeEnv,
  });
  const plugin = discovered.plugins.find((item) => item.name === "xiadie");
  assert.ok(plugin?.enabled, "isolated Native profile discovers the installed enabled Xiadie Hook");

  const targetForPrompt = (promptText) => {
    if (promptText.includes("U09_READ_FOREIGN_MEMORY")) return foreignMemoryPath;
    if (promptText.includes("U09_READ_FOREIGN")) return path.join(foreignDirectory, "private.txt");
    if (promptText.includes("U09_READ_UNSELECTED")) return unselectedPath;
    return selectedPath;
  };
  const listenerSnapshot = captureListenerSnapshot(root, safeEnv);
  resultMetrics.listenerSnapshot = {
    file: path.basename(listenerSnapshot.file),
    sha256: listenerSnapshot.sha256,
    entryCount: listenerSnapshot.entries.length,
  };
  mock = await startMockProvider(targetForPrompt, listenerSnapshot.entries);
  resultMetrics.listener = mock.listener;
  await mock.checkListener();
  resultMetrics.listener = { ...mock.listener, checkedBeforeNative: true };
  const providerRegistry = new providerModule.ProviderRegistry([createProvider(mock.baseUrl)]);
  execution = createExecutionPort({
    fault: activeScenario.startsWith("hook-") ? activeScenario.slice("hook-".length) : undefined,
    profileRoot, home, temp,
  });
  const model = createObservedNativeModelAdapter(
    new nativeModelRunner.AiSdkModelAdapter({ env: safeEnv }),
    nativeContracts.getCurrentModelInvocationContext,
    () => execution.lastHookContext,
  );
  const hostOptions = {
    native: {
      createZCodeApp: native.createZCodeApp,
      getCurrentModelInvocationContext: nativeContracts.getCurrentModelInvocationContext,
    },
    appOptions: {
      providerRegistry,
      runtimeConfig: {
        mode: "plan",
        memory: { enabled: false, use: false, extractionEnabled: false, workspaceIdentity: project.projectId },
        dynamicWorkflowEnabled: false,
        modelSelection: { providerId: "p03-u09-loopback", modelId: "mock-model", options: { reasoningLevel: "none" } },
        modelStreaming: "off",
        toolAllowlist: ["Read"],
        workingDirectory: workspacePath,
        maxTurns: 6,
      },
      pluginStorageRoot, userConfigPath, projectConfigPath, workingDirectory: workspacePath,
      skipUserConfig: false, officialPluginRoots: [],
      fileSystemPort: new nativeFs.NodeFileSystemAdapter({ textSearchEngine: "javascript" }),
      env: safeEnv,
    },
    executionPort: execution.port,
    modelAdapter: model.adapter,
    enabled: true,
    assetsRoot: path.join(repositoryRoot, "assets", "character"),
    moduleRoot: path.join(repositoryRoot, "dist"),
    installedPluginRoot: plugin.rootPath,
    dataRoot: plugin.dataPath,
    ownedProfileRoot: profileRoot,
    pluginStorageRoot,
    nodeExecutable,
    projectMemory,
    projectMemoryReadPort: { project, workspacePath, createError: makeNativeFsError },
  };
  host = await createXiadieZCodeApp(hostOptions);
  assert.equal(host.app.runtime.isProjectMemoryEnabled(), false,
    "Native extraction stays disabled; the Host read seam is the tested authority");

  return {
    root, workspacePath, registry, project, projectMemory, memoryRoot, selectedPath, unselectedPath,
    foreignMemoryRoot, foreignMemoryPath,
    foreignPath: path.join(foreignDirectory, "private.txt"), markers, readState, mock, model, execution,
    metrics: resultMetrics,
    get host() { return host; },
    async reopen(sessionId) {
      await host.close?.();
      host = await createXiadieZCodeApp({
        ...hostOptions,
        appOptions: { ...hostOptions.appOptions, sessionId, resume: true },
      });
      assert.equal(host.app.sessionId, sessionId, "Native reopen resumes the same persisted session");
      assert.equal(host.app.runtime.isProjectMemoryEnabled(), false);
      return host;
    },
  };
}
async function runSameHashCache(fixture) {
  const first = await fixture.host.submitPrompt("U09_READ_SELECTED same-hash first turn; return the marker.");
  const second = await fixture.host.submitPrompt("U09_READ_SELECTED same-hash second turn; read the same path again.");
  const marker = fixture.markers.initial;
  assert.ok(first.response.includes(`MOCK_READ_OK:${marker}`));
  assert.ok(second.response.includes(`MOCK_READ_OK:${marker}`));
  assert.equal(fixture.readState.callbacks, 4, "two real Native Reads each reached Host stat and range seams");
  assert.equal(new Set(fixture.readState.sourceHashes).size, 1, "source bytes were identical in both turns");
  assert.equal(new Set(fixture.model.contexts.map((context) => context.turnId).filter(Boolean)).size, 2,
    "Native issued the same-path Reads from separate turns");
  assert.equal(fixture.mock.readTargets.length, 2);
  assert.equal(fixture.mock.nonLoopbackRequests, 0);
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
}

async function runStatRangeRaceRecovery(fixture) {
  const primed = await fixture.host.submitPrompt("U09_READ_SELECTED prime Native read-state with the old marker.");
  assert.ok(primed.response.includes(`MOCK_READ_OK:${fixture.markers.initial}`));
  const raceStat = statSync(fixture.selectedPath);
  fixture.readState.raceArmed = true;
  const raced = await fixture.host.submitPrompt("U09_READ_SELECTED exercise the stat/range mutation boundary.");
  assert.ok(raced.response.includes("MOCK_TOOL_RESULT_SEEN"), "Native saw a failed tool result rather than file bytes");
  assert.equal(fixture.readState.raceApplied, true);
  assert.equal(fixture.readState.race?.sameLength, true);
  assert.equal(fixture.readState.race?.sameMtimeMs, true);
  assert.equal(fixture.readState.race?.oldSizeBytes, raceStat.size);
  assert.equal(fixture.readState.race?.oldMtimeMs, raceStat.mtimeMs);
  assert.ok(fixture.readState.errors.includes("SOURCE_CHANGED"), "the real reader rejected the changed source against the captured snapshot");
  assert.equal(fixture.mock.toolReplies.at(-1).includes(fixture.markers.initial), false);
  assert.equal(fixture.mock.toolReplies.at(-1).includes(fixture.markers.mutated), false);

  const recovered = await fixture.host.submitPrompt("U09_READ_SELECTED next-turn recovery must read the current marker.");
  assert.ok(recovered.response.includes(`MOCK_READ_OK:${fixture.markers.mutated}`));
  assert.equal(fixture.readState.callbacks, 6);
  assert.equal(fixture.mock.readTargets.length, 3);
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
}

async function runHookFailure(fixture, activeScenario) {
  const outcome = await fixture.host.submitPrompt("U09_READ_SELECTED failed Hook must prevent Native memory Read.").then(
    (value) => ({ kind: "resolved", value }),
    () => ({ kind: "rejected" }),
  );
  assert.ok(outcome.kind === "resolved" || outcome.kind === "rejected");
  assert.equal(fixture.execution.hookRuns, 1, "Native attempted the installed UserPromptSubmit Hook");
  assert.equal(fixture.model.delegateCalls, 0, "Host blocked the model before provider delegation");
  assert.equal(fixture.mock.requests.length, 0, "the loopback model received no request");
  assert.equal(fixture.readState.callbacks, 0, "no Native stat/range reached the Host reader callback");
  assert.ok(fixture.host.readAdmissionFailures().length > 0);
  const hook = fixture.execution.processRecords.at(-1);
  assert.ok(hook);
  if (activeScenario === "hook-nonzero") assert.equal(hook.status, "failed");
  if (activeScenario === "hook-bad-json") {
    assert.equal(hook.status, "completed");
    assert.equal(hook.exitCode, 0);
  }
  if (activeScenario === "hook-timeout") {
    assert.equal(hook.status, "timed_out");
    assert.equal(hook.timedOut, true);
  }
  if (activeScenario === "hook-missing-receipt") assert.equal(hook.status, "completed");
}

async function runCancelRecovery(fixture) {
  const first = await fixture.host.submitPrompt("U09_READ_SELECTED prime persisted Native read-state before cancellation.");
  assert.ok(first.response.includes(`MOCK_READ_OK:${fixture.markers.initial}`));
  const sessionId = fixture.host.app.sessionId;
  const controller = new AbortController();
  fixture.mock.holdNextResponse();
  const cancelledAdmission = await fixture.host.sendInput(
    { text: "U09_NO_TOOL_CANCEL hold the provider request so this Native turn can be cancelled." },
    { abortSignal: controller.signal, inputId: "p03-u09-cancel-old-receipt" },
  );
  assert.equal(cancelledAdmission.kind, "started_turn");
  await waitFor(() => fixture.mock.pendingResponseCount > 0);
  const oldCorrelation = { sessionId, turnId: cancelledAdmission.turnId };
  controller.abort();
  await Promise.allSettled([cancelledAdmission.completion]);
  await waitFor(() => fixture.mock.abortedResponses > 0);
  await assertReadNotAdmitted(fixture.host, fixture.selectedPath, oldCorrelation);

  await writeFile(fixture.selectedPath, `${fixture.markers.afterCancel}\n`, "utf8");
  fixture.mock.holdNextResponse();
  const recoveredAdmission = await fixture.host.sendInput(
    { text: "U09_READ_SELECTED after cancellation, read the new memory marker." },
    { inputId: "p03-u09-recover-fresh-receipt" },
  );
  assert.equal(recoveredAdmission.kind, "started_turn");
  await waitFor(() => fixture.mock.pendingResponseCount > 0);
  assert.equal(fixture.execution.hookRuns, 3, "each turn, including recovery, received a real Hook attempt");
  await assertReadNotAdmitted(fixture.host, fixture.selectedPath, oldCorrelation);
  assert.equal(fixture.mock.releaseNextResponse(), true);
  const recovered = await recoveredAdmission.completion;
  assert.ok(recovered.response.includes(`MOCK_READ_OK:${fixture.markers.afterCancel}`));

  const callsBeforeReopen = fixture.mock.requests.length;
  await fixture.reopen(sessionId);
  assert.equal(fixture.mock.requests.length, callsBeforeReopen, "process-style Native reopen does not replay a prior model request");
  await assertReadNotAdmitted(fixture.host, fixture.selectedPath, oldCorrelation);
  await writeFile(fixture.selectedPath, `${fixture.markers.afterReopen}\n`, "utf8");
  const resumed = await fixture.host.submitPrompt("U09_READ_SELECTED after Native reopen, read the newest memory marker.");
  assert.equal(fixture.host.app.sessionId, sessionId);
  assert.ok(resumed.response.includes(`MOCK_READ_OK:${fixture.markers.afterReopen}`));
  assert.equal(fixture.mock.readTargets.length, 3, "first, recovered, and reopened turns each performed Native Read");
  assert.equal(fixture.readState.errors.length, 0);
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
}

async function runPathDenials(fixture) {
  const foreign = await fixture.host.submitPrompt("U09_READ_FOREIGN ask Native Read for an existing file outside the registered workspace.");
  assert.ok(foreign.response.includes("MOCK_TOOL_RESULT_SEEN"));
  assert.equal(fixture.readState.callbacks, 0, "foreign path was rejected before the project-memory reader");
  assert.equal(fixture.mock.toolReplies.at(-1).includes("U09_FOREIGN_SECRET_CANARY"), false);

  const foreignMemory = await fixture.host.submitPrompt(
    "U09_READ_FOREIGN_MEMORY ask Native Read for a real topic under a separately registered project's Native memory root.");
  assert.ok(foreignMemory.response.includes("MOCK_TOOL_RESULT_SEEN"));
  assert.equal(fixture.readState.callbacks, 1,
    "foreign Native memory-family path reached the selected-project Reader exactly once");
  assert.ok(fixture.readState.errors.includes("READ_NOT_ADMITTED"));
  assert.equal(fixture.mock.toolReplies.at(-1).includes("U09_FOREIGN_MEMORY_SECRET_CANARY"), false);

  const unselected = await fixture.host.submitPrompt("U09_READ_UNSELECTED ask Native Read for a linked but unselected memory topic.");
  assert.ok(unselected.response.includes("MOCK_TOOL_RESULT_SEEN"));
  assert.equal(fixture.readState.callbacks, 2, "foreign and unselected memory paths reached the reader once each");
  assert.deepEqual(fixture.readState.errors, ["READ_NOT_ADMITTED", "READ_NOT_ADMITTED"]);
  assert.equal(fixture.mock.toolReplies.at(-1).includes("U09_UNSELECTED_SECRET_CANARY"), false);
  assert.equal(fixture.mock.readTargets.length, 3);
  assert.deepEqual(fixture.host.readAdmissionFailures(), []);
}

async function assertReadNotAdmitted(host, filename, correlation) {
  await assert.rejects(Promise.resolve().then(() => host.readProjectMemory(filename, correlation)),
    (error) => error?.code === "READ_NOT_ADMITTED");
}

function markersFor(activeScenario) {
  if (activeScenario === "same-hash-cache") return { initial: "U09_SAME_HASH_MARKER" };
  if (activeScenario === "stat-range-race-recovery") return {
    initial: "U09_RACE_OLD_MARKER", mutated: "U09_RACE_NEW_MARKER",
  };
  if (activeScenario === "cancel-recovery") return {
    initial: "U09_CANCEL_OLD_MARKER", afterCancel: "U09_CANCEL_NEW_MARKER", afterReopen: "U09_REOPEN_NEW_MARKER",
  };
  return { initial: "U09_ALLOWED_MARKER" };
}
async function initializeGitFixture(root, noHooks, workspacePath) {
  await mkdir(workspacePath, { recursive: true });
  await writeFile(path.join(workspacePath, "README.md"), "P03 U09 isolated registered workspace fixture.\n", "utf8");
  const env = safeEnvironment(home, temp);
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "disabled-global-git-config"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  const git = (args) => {
    const result = spawnSync("git", [
      "-c", "core.fsmonitor=false",
      "-c", `core.hooksPath=${noHooks}`,
      "-c", "user.name=P03 U09 Synthetic Author",
      "-c", "user.email=p03-u09@example.invalid",
      "-c", "commit.gpgSign=false",
      "-C", workspacePath,
      ...args,
    ], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`Owned Git fixture failed (${args.join(" ")}): ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
    }
  };
  git(["init", "--initial-branch=main"]);
  git(["add", "README.md"]);
  git(["commit", "-m", "synthetic P03 U09 Native integration fixture"]);
}

function createProvider(baseUrl) {
  return {
    providerId: "p03-u09-loopback",
    providerName: "P03 U09 loopback mock",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "u09-synthetic-only" },
      api: { type: "openai-chat-completions", baseUrl },
      builtinModelIds: ["mock-model"],
      personalModelIds: [],
      modelOrder: ["mock-model"],
      visibility: "visible",
    },
    models: [{
      modelId: "mock-model",
      config: {
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 32768,
          inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
        },
        optionSpecs: {
          reasoningLevel: { values: ["none"], map: "{}" },
          maxOutputTokens: { max: 4096, map: "{}" },
        },
      },
    }],
  };
}

function createObservedNativeModelAdapter(delegate, getContext, getExpectedPacket) {
  const state = { delegateCalls: 0, contexts: [] };
  const observeModel = (model) => {
    const observed = Object.create(model);
    Object.defineProperties(observed, {
      bind: { value: (options) => observeModel(model.bind.call(model, options)) },
      generateText: { value: (request) => { observeCall(request); return model.generateText.call(model, request); } },
      streamText: { value: (request) => { observeCall(request); return model.streamText.call(model, request); } },
    });
    return observed;
  };
  const observeCall = (request) => {
    const context = getContext();
    const expectedPacket = getExpectedPacket();
    state.delegateCalls += 1;
    state.contexts.push({
      operation: context?.modelCall?.operation,
      sessionId: context?.traceContext?.sessionId,
      turnId: context?.traceContext?.turnId,
      hasCurrentHookPacket: typeof expectedPacket === "string" && collectMessageText(request.messages).includes(expectedPacket),
    });
  };
  const adapter = Object.create(delegate);
  Object.defineProperties(adapter, {
    createModel: { value: (options) => observeModel(delegate.createModel.call(delegate, options)) },
    addStatusSink: { value: (sink) => delegate.addStatusSink.call(delegate, sink) },
    setModelIoFullRetentionEnabled: {
      value: (enabled) => delegate.setModelIoFullRetentionEnabled.call(delegate, enabled),
    },
  });
  return { adapter, contexts: state.contexts, get delegateCalls() { return state.delegateCalls; } };
}
function captureListenerSnapshot(root, environment) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$listeners = @(Get-NetTCPConnection -State Listen | Select-Object @{Name='LocalAddress';Expression={[string]$_.LocalAddress}}, @{Name='LocalPort';Expression={[int]$_.LocalPort}}, @{Name='OwningProcess';Expression={[int]$_.OwningProcess}})",
    "ConvertTo-Json -InputObject $listeners -Compress",
  ].join("; ");
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root, env: environment, encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  }).trim();
  const parsed = JSON.parse(output);
  const entries = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    assert.equal(Object.keys(entry).sort().join(","), "LocalAddress,LocalPort,OwningProcess");
    assert.equal(typeof entry.LocalAddress, "string");
    assert.ok(Number.isInteger(entry.LocalPort) && entry.LocalPort >= 1 && entry.LocalPort <= 65_535);
    assert.ok(Number.isInteger(entry.OwningProcess) && entry.OwningProcess >= 0);
  }
  const file = path.join(fixtureRoot, "listeners-before.json");
  const serialized = `${JSON.stringify(entries, null, 2)}\n`;
  writeFileSync(file, serialized, "utf8");
  return { file, entries, sha256: sha256(serialized) };
}

async function startMockProvider(targetForPrompt, listenersBefore) {
  const state = {
    requests: [], readTargets: [], toolReplies: [], nonLoopbackRequests: 0,
    abortedResponses: 0, pendingResponses: [], holdCount: 0, healthChecks: 0,
  };
  const server = http.createServer(async (request, response) => {
    let pendingEntry;
    response.u09Accept = request.headers.accept;
    response.on("close", () => {
      if (!response.writableEnded) {
        state.abortedResponses += 1;
        if (pendingEntry) {
          const index = state.pendingResponses.indexOf(pendingEntry);
          if (index >= 0) state.pendingResponses.splice(index, 1);
        }
      }
    });
    const remote = request.socket.remoteAddress ?? "";
    if (!isLoopback(remote)) {
      state.nonLoopbackRequests += 1;
      response.writeHead(403).end("loopback only");
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      state.healthChecks += 1;
      response.writeHead(204).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { response.writeHead(400).end("invalid json"); return; }
    state.requests.push({ method: request.method, path: request.url, body });
    if (state.holdCount > 0) {
      state.holdCount -= 1;
      pendingEntry = { body, response };
      state.pendingResponses.push(pendingEntry);
      return;
    }
    writeCompletion(body, response, state, targetForPrompt);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  const samePortBefore = listenersBefore.filter((entry) => entry.LocalPort === address.port);
  assert.equal(samePortBefore.length, 0,
    "selected ephemeral listener port did not appear on any address in the pre-start Listen snapshot");
  const listener = {
    address: address.address, port: address.port, checkedBeforeNative: false, healthChecks: 0,
    portPreviouslyUnoccupied: true, priorListenerCountOnPort: samePortBefore.length,
  };
  return {
    requests: state.requests,
    readTargets: state.readTargets,
    toolReplies: state.toolReplies,
    listener,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get nonLoopbackRequests() { return state.nonLoopbackRequests; },
    get abortedResponses() { return state.abortedResponses; },
    get pendingResponseCount() { return state.pendingResponses.length; },
    holdNextResponse() { state.holdCount += 1; },
    releaseNextResponse() {
      const entry = state.pendingResponses.shift();
      if (!entry || entry.response.destroyed || entry.response.writableEnded) return false;
      writeCompletion(entry.body, entry.response, state, targetForPrompt);
      return true;
    },
    async checkListener() {
      const status = await new Promise((resolve, reject) => {
        const probe = http.get({ host: "127.0.0.1", port: address.port, path: "/health", timeout: 2000 }, (reply) => {
          reply.resume();
          reply.once("end", () => resolve(reply.statusCode));
        });
        probe.once("error", reject);
        probe.once("timeout", () => probe.destroy(new Error("loopback listener check timed out")));
      });
      assert.equal(status, 204);
      assert.equal(state.healthChecks, 1);
      listener.healthChecks = state.healthChecks;
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function writeCompletion(body, response, state, targetForPrompt) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { lastUserIndex = index; break; }
  }
  const currentUserText = lastUserIndex >= 0 ? messageText(messages[lastUserIndex]) : "";
  const currentTail = lastUserIndex >= 0 ? messages.slice(lastUserIndex + 1) : [];
  const currentToolMessages = currentTail.filter((message) => message?.role === "tool" || message?.role === "function");
  const currentToolText = currentToolMessages.map(messageText).join("\n");
  const readAvailable = (body.tools ?? []).some((tool) => tool.name === "Read" || tool.function?.name === "Read");
  const shouldRead = readAvailable && currentToolMessages.length === 0 && /U09_READ_(SELECTED|FOREIGN_MEMORY|FOREIGN|UNSELECTED)/.test(currentUserText);
  const index = state.requests.length;
  let assistantMessage;
  let finishReason;
  if (shouldRead) {
    const target = targetForPrompt(currentUserText);
    state.readTargets.push(target);
    assistantMessage = {
      role: "assistant", content: null,
      tool_calls: [{ id: `u09-read-${index}`, type: "function",
        function: { name: "Read", arguments: JSON.stringify({ file_path: target }) } }],
    };
    finishReason = "tool_calls";
  } else if (currentToolMessages.length > 0) {
    state.toolReplies.push(currentToolText);
    const marker = currentToolText.match(/U09_[A-Z0-9_]+/)?.[0];
    assistantMessage = { role: "assistant", content: marker ? `MOCK_READ_OK:${marker}` : "MOCK_TOOL_RESULT_SEEN" };
    finishReason = "stop";
  } else {
    assistantMessage = { role: "assistant", content: "MOCK_NO_TOOL" };
    finishReason = "stop";
  }
  const completion = {
    id: `chatcmpl-u09-${index}`, object: "chat.completion", created: 1, model: "mock-model",
    choices: [{ index: 0, message: assistantMessage, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  if ((response.u09Accept ?? "").includes("text/event-stream")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = assistantMessage.tool_calls
      ? { role: "assistant", tool_calls: [{ index: 0, ...assistantMessage.tool_calls[0] }] }
      : { role: "assistant", content: assistantMessage.content };
    response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  } else {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(completion));
  }
}
function createExecutionPort(options) {
  const state = { hookRuns: 0, lastHookContext: undefined, processRecords: [] };
  const safeEnv = safeEnvironment(options.home, options.temp);
  const run = async (request, runOptions) => {
    const isUserPromptHook = request.trace?.attributes?.hookEventName === "UserPromptSubmit";
    if (isUserPromptHook) state.hookRuns += 1;
    assert.equal(request.command.mode, "argv");
    const fault = isUserPromptHook && ["nonzero", "bad-json", "timeout"].includes(options.fault) ? options.fault : undefined;
    const executedRequest = fault
      ? {
          ...request,
          command: { ...request.command, file: nodeExecutable,
            args: [path.join(repositoryRoot, "packages", "adapters", "zcode", "test", "fixtures", "hook-process-fault.mjs"), fault === "timeout" ? "hang" : fault] },
          ...(fault === "timeout" ? { timeoutMs: Math.min(request.timeoutMs ?? 1000, 250) } : {}),
        }
      : request;
    const actualRequest = { ...executedRequest, command: { ...executedRequest.command, file: nodeExecutable } };
    const real = await runChild(actualRequest, safeEnv, runOptions);
    const record = {
      event: isUserPromptHook ? "UserPromptSubmit" : "other",
      kind: fault ?? options.fault ?? "installed-hook",
      status: real.status,
      exitCode: real.exitCode,
      timedOut: real.timedOut,
      cancelled: real.cancelled,
      stdoutBytes: real.stdout.bytes,
      stdoutSha256: sha256(real.stdout.text),
      stderrBytes: real.stderr.bytes,
      stderrSha256: sha256(real.stderr.text),
      processStarted: !real.error,
    };
    if (isUserPromptHook) state.processRecords.push(record);
    if (isUserPromptHook && real.status === "completed") {
      try {
        const envelope = JSON.parse(real.stdout.text);
        state.lastHookContext = typeof envelope.additionalContext === "string" ? envelope.additionalContext : undefined;
      } catch { state.lastHookContext = undefined; }
    }
    if (isUserPromptHook && options.fault === "missing-receipt" && real.status === "completed") {
      try {
        const envelope = JSON.parse(real.stdout.text);
        delete envelope.xiadieReceipt;
        const text = JSON.stringify(envelope);
        return { ...real, stdout: { text, bytes: Buffer.byteLength(text), truncated: false } };
      } catch {}
    }
    return real;
  };
  return {
    port: { run },
    get hookRuns() { return state.hookRuns; },
    get lastHookContext() { return state.lastHookContext; },
    processRecords: state.processRecords,
  };
}

async function runChild(request, baseEnvironment, runOptions = {}) {
  const env = { ...baseEnvironment, ...(request.env?.set ?? {}) };
  for (const name of request.env?.unset ?? []) delete env[name];
  const startedAt = new Date();
  const child = spawn(request.command.file, [...(request.command.args ?? [])], {
    cwd: request.cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.end(request.stdin ?? "");
  let timedOut = false;
  let cancelled = false;
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const signal = runOptions?.signal;
  const onAbort = () => { cancelled = true; child.kill(); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signalName) => resolve({ code, signalName }));
  });
  if (timer !== undefined) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  const completedAt = new Date();
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  return {
    status: exit.error ? "spawn_error" : cancelled ? "cancelled" : timedOut ? "timed_out" : exit.code === 0 ? "completed" : "failed",
    ...(exit.code === null || exit.code === undefined ? {} : { exitCode: exit.code }),
    ...(exit.signalName ? { signal: exit.signalName } : {}),
    stdout: { text: stdout.toString("utf8"), bytes: stdout.byteLength, truncated: false },
    stderr: { text: stderr.toString("utf8"), bytes: stderr.byteLength, truncated: false },
    durationMs: completedAt.getTime() - startedAt.getTime(),
    timedOut, cancelled, startedAt, completedAt,
    ...(exit.error ? { error: { type: "spawn_error", message: exit.error.message } } : {}),
  };
}
function safeEnvironment(environmentHome, environmentTemp) {
  const env = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  Object.assign(env, {
    HOME: environmentHome,
    USERPROFILE: environmentHome,
    TEMP: environmentTemp,
    TMP: environmentTemp,
  });
  return env;
}

function makeNativeFsError(input) {
  return Object.assign(new Error(input.message), {
    code: input.code,
    path: input.path,
    ...(input.cause ? { cause: input.cause } : {}),
  });
}

function collectMessageText(messages) {
  return (messages ?? []).map(messageText).join("\n");
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((block) => typeof block?.text === "string" ? block.text : JSON.stringify(block)).join("\n");
  }
  return typeof message?.content === "undefined" ? "" : JSON.stringify(message.content);
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.0.0.1");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Native integration fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
