import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createProjectMemoryDataProvider,
  readCurrentTurnMemory,
  readSelectedProjectMemory,
  TURN_SNAPSHOT_KEY,
} from "./native-memory-reader.mjs";

const spikeDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(spikeDirectory, "../..");
const workspaceRoot = path.resolve(repositoryRoot, "..", "..", "..", "..");
const attemptId = "20261008-01";
const p01SourceRoot = path.join(workspaceRoot, ".runtime", "P01", "desktop-source");
const tsxApiPath = path.join(p01SourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs");
const nativeSourceCommit = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const nodeExecutable = path.join(workspaceRoot, ".runtime", "P01", "desktop-build-evidence", "toolchain", "node-v24.14.0-win-x64", "node.exe");
const runId = process.argv[2] ?? "run-01";
assert.match(runId, /^run-[a-z0-9-]{1,32}$/);
const attemptEvidenceRoot = path.join(repositoryRoot, "evidence", "P03-U02", attemptId);
const nativeRuntimeEvidenceRoot = path.join(attemptEvidenceRoot, "native-runtime");
const evidenceOutputRoot = process.argv[3] ? path.resolve(process.argv[3]) : nativeRuntimeEvidenceRoot;
const evidenceOutputOverride = process.argv[3] !== undefined;
const p03RuntimeRoot = path.join(workspaceRoot, ".runtime", "P03");
const outputRelativeToP03 = path.relative(p03RuntimeRoot, evidenceOutputRoot);
assert.ok(outputRelativeToP03 !== "" && outputRelativeToP03 !== ".." && !outputRelativeToP03.startsWith(`..${path.sep}`) && !path.isAbsolute(outputRelativeToP03),
  "evidence output root must be an owned location below the repository .runtime/P03 root");
if (evidenceOutputOverride) assert.equal(within(repositoryRoot, evidenceOutputRoot), false, "reviewer evidence must stay outside the author worktree");
const experimentRoot = path.join(workspaceRoot, ".runtime", "P03", "experiments", attemptId, "native-runtime");
const runtimeRunRoot = path.join(experimentRoot, runId);
const profileRoot = path.join(runtimeRunRoot, "profiles");
const profile = path.join(profileRoot, "native-runtime-profile");
const home = path.join(profile, "home");
const temp = path.join(profile, "temp");
const workspace = path.join(profile, "workspace");
const pluginStorageRoot = path.join(profile, "plugin-storage");
const dataRoot = path.join(profile, "plugin-data");
const nativeCliStorageRoot = path.join(runtimeRunRoot, "zcode-cli-storage");
const projectId = "018f8c31-7f5c-7c2a-9a42-0308a1f36d03";
const selectedTopic = "selected.md";
const sourceRootPath = path.join(workspace, "src", "current-contract.txt");

const hash = (value) => createHash("sha256").update(value).digest("hex");
const utf8Bytes = (value) => Buffer.byteLength(value, "utf8");
const sourceHashRows = [];
const sourceGitCommands = [];
const hookRuns = [];
const nativeEvents = [];
const providerSamples = [];
let writeProbe;
let aclEvidence;
const aclCommands = [];

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function nativeGit(args) {
  const result = spawnSync("git", ["-C", p01SourceRoot, ...args], { encoding: "utf8" });
  sourceGitCommands.push({ executable: "git", args, cwd: p01SourceRoot, exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Pinned Native git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const pinnedNativeHead = nativeGit(["rev-parse", "HEAD"]);
const pinnedNativeStatus = nativeGit(["status", "--porcelain"]);
assert.equal(pinnedNativeHead, nativeSourceCommit);
assert.equal(pinnedNativeStatus, "");
assert.equal(await lstat(nodeExecutable).then((info) => info.isFile()), true, "fixed Node 24.14 binary exists");
if (evidenceOutputOverride) {
  const realP03RuntimeRoot = await realpath(p03RuntimeRoot);
  const realEvidenceParent = await realpath(path.dirname(evidenceOutputRoot));
  assert.ok(within(realP03RuntimeRoot, realEvidenceParent), "reviewer evidence parent must resolve below the real repository .runtime/P03 root");
  try {
    await lstat(evidenceOutputRoot);
    throw new Error(`Refusing to overwrite an existing evidence output directory: ${evidenceOutputRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(evidenceOutputRoot);
} else await mkdir(evidenceOutputRoot, { recursive: true });
try {
  await lstat(runtimeRunRoot);
  throw new Error(`Refusing to reuse an existing Native runtime run directory: ${runtimeRunRoot}; select a fresh --run id`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await mkdir(runtimeRunRoot, { recursive: true });
await mkdir(profileRoot, { recursive: true });
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(temp, { recursive: true }),
  mkdir(workspace, { recursive: true }),
  mkdir(pluginStorageRoot, { recursive: true }),
  mkdir(dataRoot, { recursive: true }),
  mkdir(path.join(home, ".zcode-data"), { recursive: true }),
  mkdir(path.join(home, "AppData", "Roaming"), { recursive: true }),
  mkdir(path.join(home, "AppData", "Local"), { recursive: true }),
]);
const isolatedEnvironment = safeEnvironment(home, temp);
isolatedEnvironment.GIT_CONFIG_NOSYSTEM = "1";
isolatedEnvironment.GIT_CONFIG_GLOBAL = path.join(profile, "empty.gitconfig");
await writeFile(isolatedEnvironment.GIT_CONFIG_GLOBAL, "", { flag: "wx" });
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolatedEnvironment);
assert.equal(await realpath(os.tmpdir()), await realpath(temp));

const tsxApi = await import(pathToFileURL(tsxApiPath).href);
tsxApi.register();

const nativeBootstrapPath = path.join(p01SourceRoot, "apps", "zcode-cli", "packages", "bootstrap", "dist", "index.js");
const nativeContractsPath = path.join(p01SourceRoot, "apps", "zcode-cli", "packages", "contracts", "dist", "model", "invocation-context.js");
const nativeFileContractsPath = path.join(p01SourceRoot, "apps", "zcode-cli", "packages", "contracts", "dist", "index.js");
const providerRegistryPath = path.join(p01SourceRoot, "packages", "provider", "src", "registry.ts");
const modelRunnerPath = path.join(p01SourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "model", "runner.js");
const nativeFsPath = path.join(p01SourceRoot, "apps", "zcode-cli", "packages", "adapters", "dist", "fs", "index.js");
const projectRootPath = path.join(p01SourceRoot, "apps", "zcode-cli", "packages", "core", "dist", "memory", "project-root.js");

for (const filename of [nativeBootstrapPath, nativeContractsPath, nativeFileContractsPath, providerRegistryPath, modelRunnerPath, nativeFsPath, projectRootPath, tsxApiPath,
  path.join(p01SourceRoot, "node_modules", "tsx", "package.json")]) {
  const bytes = await readFile(filename);
  sourceHashRows.push({ path: filename, bytes: bytes.length, sha256: hash(bytes) });
}

const native = await import(pathToFileURL(nativeBootstrapPath).href);
const nativeContracts = await import(pathToFileURL(nativeContractsPath).href);
const nativeFileContracts = await import(pathToFileURL(nativeFileContractsPath).href);
const providerModule = await import(pathToFileURL(providerRegistryPath).href);
const nativeModelRunner = await import(pathToFileURL(modelRunnerPath).href);
const nativeFileSystem = await import(pathToFileURL(nativeFsPath).href);
const nativeProjectRoot = await import(pathToFileURL(projectRootPath).href);

const memoryRoot = nativeProjectRoot.resolveProjectMemoryRoot({
  cliStorageRoot: nativeCliStorageRoot,
  workspaceIdentity: projectId,
  workspacePath: workspace,
});
assert.ok(within(runtimeRunRoot, memoryRoot));
await mkdir(memoryRoot, { recursive: true });
await mkdir(path.dirname(sourceRootPath), { recursive: true });
const initialMemoryText = [
  "---",
  "recorded_at: 2023-10-08",
  "kind: experience-lead",
  "status: verify-against-current-source",
  "---",
  "P03_OLD_MEMORY_V1: A three-year-old note says the project API is legacyFetch(path).",
  "Keep this as historical experience; it does not override current source or tests.",
  "",
].join("\n");
const currentSourceText = [
  "// Synthetic current source fixture; it intentionally contradicts the old memory note.",
  "export function currentFetch(url) { return `CURRENT_SOURCE_V1:${url}`; }",
  "// CURRENT_SOURCE_AUTHORITY: currentFetch is the actual fixture API.",
  "",
].join("\n");
const memoryPath = path.join(memoryRoot, selectedTopic);
const deniedPath = path.join(runtimeRunRoot, "outside-allowlist.txt");
await writeFile(memoryPath, initialMemoryText, "utf8");
await writeFile(sourceRootPath, currentSourceText, "utf8");
await writeFile(deniedPath, "P03_OUTSIDE_MUST_NOT_BE_READ\n", "utf8");
const originalSourceSha256 = hash(await readFile(sourceRootPath));
const originalMemorySha256 = hash(await readFile(memoryPath));
const deniedFileSha256 = hash(await readFile(deniedPath));

const dataProvider = createProjectMemoryDataProvider({ memoryPath, memoryRoot, projectId, samples: providerSamples });
const initialMemory = readSelectedProjectMemory({ filename: memoryPath, memoryRoot });

const bundleRoot = path.join(runtimeRunRoot, "native-variant");
const hostDistPath = path.join(repositoryRoot, "dist", "packages", "adapters", "zcode", "src", "host.js");
const hookSourcePath = path.join(repositoryRoot, "plugins", "xiadie", "hooks", "context.mjs");
for (const filename of [
  path.join(repositoryRoot, "packages", "adapters", "zcode", "src", "host.ts"),
  path.join(repositoryRoot, "packages", "context", "src", "index.ts"),
  path.join(repositoryRoot, "packages", "contracts", "src", "context.ts"),
  path.join(repositoryRoot, "packages", "character", "src", "loader.ts"),
  hookSourcePath,
  hostDistPath,
  path.join(repositoryRoot, "plugins", "xiadie", "hooks", "hooks.json"),
  path.join(spikeDirectory, "make-host-variant.mjs"),
  path.join(spikeDirectory, "native-memory-reader.mjs"),
  path.join(spikeDirectory, "native-memory-runtime.mjs"),
  path.join(repositoryRoot, "tsconfig.json"),
  path.join(repositoryRoot, "package.json"),
  path.join(repositoryRoot, "pnpm-lock.yaml"),
  path.join(repositoryRoot, "node_modules", "typescript", "package.json"),
  path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
  path.join(p01SourceRoot, "package.json"),
  path.join(p01SourceRoot, "node_modules", "esbuild", "package.json"),
  nodeExecutable,
]) {
  const bytes = await readFile(filename);
  sourceHashRows.push({ path: filename, bytes: bytes.length, sha256: hash(bytes) });
}
const hostVariantModulePath = path.join(spikeDirectory, "make-host-variant.mjs");
const variantModule = await import(pathToFileURL(hostVariantModulePath).href);
const { buildHostVariant } = variantModule;
assert.equal(typeof buildHostVariant, "function", "the isolated U02 host variant builder is available");
const hostVariant = await buildHostVariant({ repositoryRoot, outputDir: bundleRoot });
const hostVariantInputHashes = [];
const metafileInputs = Object.keys(hostVariant.manifest.metafile.inputs);
const syntheticEntryInputs = metafileInputs.filter((input) => path.basename(input) === "p03-host-seam-experiment.js");
assert.equal(syntheticEntryInputs.length, 1, "the bounded host variant has exactly one generated stdin entry");
for (const input of metafileInputs) {
  const filename = input === syntheticEntryInputs[0]
    ? path.join(bundleRoot, "host-variant-source.js")
    : path.resolve(repositoryRoot, input);
  const bytes = await readFile(filename);
  const row = { metafilePath: input, path: filename, bytes: bytes.length, sha256: hash(bytes) };
  hostVariantInputHashes.push(row);
  if (!sourceHashRows.some((existing) => existing.path === filename)) sourceHashRows.push(row);
}
const hostModule = await import(pathToFileURL(hostVariant.hostPath).href);
const createXiadieZCodeApp = hostModule.createXiadieZCodeApp;
assert.equal(typeof createXiadieZCodeApp, "function");

const profileBase = safeEnvironment(home, temp);
const userConfigPath = path.join(profile, "user.json");
const projectConfigPath = path.join(profile, "project.json");
await writeFile(userConfigPath, JSON.stringify({ storage: { dir: path.join(profile, "storage") } }, null, 2), "utf8");
await writeFile(projectConfigPath, JSON.stringify({}, null, 2), "utf8");

const marketplace = await native.addZCodePluginMarketplace({
  pluginStorageRoot,
  userConfigPath,
  projectConfigPath,
  workingDirectory: workspace,
  env: profileBase,
  source: path.join(repositoryRoot, "plugins", "xiadie", "marketplace.json"),
});
await native.installZCodeMarketplacePlugin({
  pluginStorageRoot,
  userConfigPath,
  projectConfigPath,
  workingDirectory: workspace,
  env: profileBase,
  marketplace: marketplace.id,
  pluginName: "xiadie",
});
await native.setZCodePluginEnabled({
  pluginStorageRoot,
  userConfigPath,
  projectConfigPath,
  workingDirectory: workspace,
  env: profileBase,
  plugin: `xiadie@${marketplace.id}`,
  enabled: true,
});
const discovered = native.listZCodePlugins({ pluginStorageRoot, userConfigPath, projectConfigPath, workingDirectory: workspace, env: profileBase });
const plugin = discovered.plugins.find((item) => item.name === "xiadie");
assert.ok(plugin?.enabled && plugin.rootPath && plugin.dataPath);
const installedHookPath = path.join(plugin.rootPath, "hooks", "context.mjs");
const sourceHookText = await readFile(hookSourcePath, "utf8");
assert.equal(await readFile(installedHookPath, "utf8"), sourceHookText, "isolated installed Hook initially matches tracked source");
await copyFile(hostVariant.hookPath, installedHookPath);
assert.notEqual(hash(await readFile(installedHookPath)), hash(sourceHookText));

const mock = await startMockProvider({ memoryPath, sourcePath: sourceRootPath, deniedPath });
const providerRegistry = new providerModule.ProviderRegistry([createProvider(mock.baseUrl)]);
const modelAdapter = new nativeModelRunner.AiSdkModelAdapter({ env: profileBase });
const fileSystemPort = await createBoundedReadFileSystemPort({
  nativeFileSystem,
  nativeFileContracts,
  memoryPath,
  memoryRoot,
  workspaceRoot: workspace,
});
const hostOptions = {
  native: { createZCodeApp: native.createZCodeApp, getCurrentModelInvocationContext: nativeContracts.getCurrentModelInvocationContext },
  appOptions: {
    providerRegistry,
    runtimeConfig: {
      mode: "plan",
      memory: { enabled: false, use: false, extractionEnabled: false },
      dynamicWorkflowEnabled: false,
      modelSelection: { providerId: "p03-u02-local", modelId: "synthetic-read-model", options: { reasoningLevel: "none" } },
      modelStreaming: "off",
      toolAllowlist: ["Read"],
      workingDirectory: workspace,
      maxTurns: 4,
    },
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: workspace,
    skipUserConfig: false,
    officialPluginRoots: [],
    fileSystemPort,
    env: profileBase,
  },
  executionPort: createExecutionPort({ home, temp, nodeExecutable, hookRuns }),
  modelAdapter,
  enabled: true,
  assetsRoot: path.join(repositoryRoot, "assets", "character"),
  moduleRoot: path.join(repositoryRoot, "dist"),
  installedPluginRoot: plugin.rootPath,
  dataRoot: plugin.dataPath,
  ownedProfileRoot: profile,
  pluginStorageRoot,
  nodeExecutable,
  projectMemoryDataProvider: dataProvider,
};

let host;
try {
  host = await createXiadieZCodeApp(hostOptions);
  assert.equal(host.app.runtime.isProjectMemoryEnabled(), false, "Native built-in project memory stays disabled; this test samples through Xiadie host admission");
  host.app.runtime.subscribeEvents({ onSessionEvent: (event) => nativeEvents.push(sanitizeNativeEvent(event)) });

  const first = await host.submitPrompt(`P03_TURN_ONE: Read ${sourceRootPath} and then ${memoryPath}. The historical note is a lead only.`);
  assert.ok(first.turnId);
  assert.ok(mock.requests.length >= 3, "the real Native provider performed source Read, memory Read, and a follow-up request");
  assert.ok(mock.requests.some((row) => row.text.includes("P03_OLD_MEMORY_V1")));
  assert.ok(mock.requests.some((row) => row.text.includes("CURRENT_SOURCE_AUTHORITY")));
  assert.ok(mock.requests.some((row) => row.toolResultTexts.some((text) => text.includes("P03_OLD_MEMORY_V1"))));

  const updatedMemoryText = [
    "---",
    "recorded_at: 2026-10-08",
    "kind: experience-lead",
    "status: verify-against-current-source",
    "---",
    "P03_MEMORY_V2: changed synthetic topic; use currentFetch(url), not legacyFetch(path).",
    "This newer fixture stays an experience lead and does not become a verified source fact.",
    "",
  ].join("\n");
  await writeFile(memoryPath, updatedMemoryText, "utf8");
  const secondMemory = readSelectedProjectMemory({ filename: memoryPath, memoryRoot });
  const hooksBeforeTurnTwo = hookRuns.length;
  const second = await host.submitPrompt(`P03_TURN_TWO: Read ${memoryPath} again and report the current marker.`);
  assert.ok(second.turnId);
  assert.ok(mock.requests.some((row) => row.turnLabel === "P03_TURN_TWO" && row.text.includes("P03_MEMORY_V2")));
  assert.ok(mock.requests.some((row) => row.turnLabel === "P03_TURN_TWO" && row.toolResultTexts.some((text) => text.includes("P03_MEMORY_V2"))));
  assert.notEqual(secondMemory.sha256, initialMemory.sha256, "same-path same-size or changed text is keyed by raw-byte SHA-256");
  const secondTurnHook = hookRuns.slice(hooksBeforeTurnTwo).find((row) => row.packetContentHashes?.includes(secondMemory.sha256));
  assert.ok(secondTurnHook?.nonce, "the second turn Hook packet contains the latest selected-memory hash");
  const secondTurnFirstRequest = mock.requests.find((row) => row.turnLabel === "P03_TURN_TWO");
  assert.ok(secondTurnFirstRequest, "the mock provider captured the second turn's first Native request");
  assert.ok(secondTurnFirstRequest.text.includes(`u06-turn:${secondTurnHook.nonce}`), "the Native request includes the current Hook nonce packet");
  assert.ok(secondTurnFirstRequest.text.includes(secondMemory.sha256), "the Native request carries the latest raw-byte memory hash in that packet");

  const denied = await host.submitPrompt(`P03_TURN_PERMISSION: Read ${deniedPath}.`);
  assert.ok(denied.turnId);
  assert.ok(nativeEvents.some((event) => event.type === "tool_call_error" && event.turnId === denied.turnId));
  assert.equal(mock.requests.some((row) => row.toolResultTexts.some((text) => text.includes("P03_OUTSIDE_MUST_NOT_BE_READ"))), false);

  const changeBeforeRead = [
    "---",
    "recorded_at: 2026-10-08",
    "kind: experience-lead",
    "status: source-changed-after-preflight",
    "---",
    "P03_SOURCE_CHANGED_AFTER_PREFLIGHT",
    "",
  ].join("\n");
  mock.setReadMutation({ label: "P03_TURN_SOURCE_RACE", targetPath: memoryPath, content: changeBeforeRead });
  const beforeRaceErrors = nativeEvents.filter((event) => event.type === "tool_call_error").length;
  const raced = await host.submitPrompt(`P03_TURN_SOURCE_RACE: Read ${memoryPath}.`);
  assert.ok(raced.turnId);
  const raceErrors = nativeEvents.filter((event) => event.type === "tool_call_error" && event.turnId === raced.turnId);
  assert.ok(nativeEvents.filter((event) => event.type === "tool_call_error").length > beforeRaceErrors,
    "the source-race turn adds a new Native tool-call error rather than relying on a prior denial");
  assert.ok(raceErrors.length > 0, "the changed-source error belongs to the race turn");
  assert.ok(fileSystemPort.readFailures.some((row) => row.turnId === raced.turnId && row.code === "P03_MEMORY_SOURCE_CHANGED"),
    "the rejected Read records the race turn id and specific admitted-snapshot source-change reason");

  const recoveredText = [
    "---",
    "recorded_at: 2026-10-08",
    "kind: experience-lead",
    "status: recovered-after-source-change",
    "---",
    "P03_MEMORY_RECOVERED: next-turn sample and Read agree on this raw source hash.",
    "",
  ].join("\n");
  await writeFile(memoryPath, recoveredText, "utf8");
  const recovered = await host.submitPrompt(`P03_TURN_RECOVERED: Read ${memoryPath} after repair.`);
  assert.ok(recovered.turnId);
  assert.ok(mock.requests.some((row) => row.turnLabel === "P03_TURN_RECOVERED" && row.text.includes("P03_MEMORY_RECOVERED")));
  assert.ok(mock.requests.some((row) => row.turnLabel === "P03_TURN_RECOVERED" && row.toolResultTexts.some((text) => text.includes("P03_MEMORY_RECOVERED"))));

  const corruptBytes = Buffer.concat([Buffer.from("---\nkind: experience-lead\n---\nP03_CORRUPT_UTF8_"), Buffer.from([0xc3, 0x28])]);
  await writeFile(memoryPath, corruptBytes);
  const beforeCorrupt = mock.requests.length;
  await assert.rejects(host.submitPrompt(`P03_TURN_CORRUPT: Read ${memoryPath}.`), /P03_MEMORY_INVALID_UTF8/);
  assert.equal(mock.requests.length, beforeCorrupt, "invalid UTF-8 blocks before a Native provider request; no empty-success packet is sent");
  assert.ok(host.readAdmissionFailures().some((failure) => failure.reasonCode === "host-before-turn" && failure.status === "blocked"));
  await writeFile(memoryPath, recoveredText, "utf8");
  const afterCorrupt = await host.submitPrompt(`P03_TURN_AFTER_CORRUPT_REPAIR: Read ${memoryPath}.`);
  assert.ok(afterCorrupt.turnId);
  assert.ok(mock.requests.some((row) => row.turnLabel === "P03_TURN_AFTER_CORRUPT_REPAIR" && row.toolResultTexts.some((text) => text.includes("P03_MEMORY_RECOVERED"))));

  const cancelController = new AbortController();
  mock.holdNextLabel("P03_TURN_CANCEL");
  const cancelledAdmission = await host.sendInput({ text: `P03_TURN_CANCEL: Hold the local synthetic provider request.` }, { abortSignal: cancelController.signal });
  assert.equal(cancelledAdmission.kind, "started_turn");
  await waitFor(() => mock.requests.some((row) => row.turnLabel === "P03_TURN_CANCEL"));
  cancelController.abort();
  await Promise.allSettled([cancelledAdmission.completion]);
  await waitFor(() => mock.abortedResponses > 0);
  const postCancel = await host.submitPrompt(`P03_TURN_AFTER_CANCEL: Read ${memoryPath} on a fresh admitted turn.`);
  assert.ok(postCancel.turnId);
  assert.ok(mock.requests.some((row) => row.turnLabel === "P03_TURN_AFTER_CANCEL" && row.toolResultTexts.some((text) => text.includes("P03_MEMORY_RECOVERED"))));

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot, "isolated Windows runtime retains the system root required for its ACL probe");
  const whoamiPath = path.join(systemRoot, "System32", "whoami.exe");
  const icaclsPath = path.join(systemRoot, "System32", "icacls.exe");
  const whoami = spawnSync(whoamiPath, ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 15_000 });
  const whoamiStdout = Buffer.isBuffer(whoami.stdout) ? whoami.stdout : Buffer.from(whoami.stdout ?? "");
  const sid = whoamiStdout.toString("utf8").match(/S-1-5-[\d-]+/)?.[0];
  assert.equal(whoami.status, 0, "the current synthetic test identity SID is available");
  assert.ok(sid);
  const sidSha256 = hash(sid);
  const runAclCommand = (operation, args) => {
    const result = spawnSync(icaclsPath, args, { windowsHide: true, timeout: 15_000 });
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
    const record = {
      executable: icaclsPath,
      operation,
      path: memoryPath,
      arguments: operation === "deny-read" ? [memoryPath, "/deny", "*<current-user-sid>:(R)"] : [memoryPath, "/remove:d", "*<current-user-sid>"],
      currentUserSidSha256: sidSha256,
      exitCode: result.status,
      stdoutBytes: stdout.length,
      stdoutSha256: hash(stdout),
      stderrBytes: stderr.length,
      stderrSha256: hash(stderr),
    };
    aclCommands.push(record);
    assert.equal(result.status, 0, `${operation} must succeed for the owned synthetic file`);
  };
  const memoryShaBeforeAcl = hash(await readFile(memoryPath));
  const requestCountBeforeAcl = mock.requests.length;
  let aclDenyApplied = false;
  let aclFailure;
  try {
    aclDenyApplied = true;
    runAclCommand("deny-read", [memoryPath, "/deny", `*${sid}:(R)`]);
    try {
      await host.submitPrompt(`P03_TURN_ACL: Read ${memoryPath} while this owned fixture denies the current process read access.`);
    } catch (error) {
      aclFailure = { code: error?.code, message: error instanceof Error ? error.message : String(error) };
    }
    assert.ok(aclFailure, "an OS-level ACL denial blocks host admission");
    assert.match(`${aclFailure.code ?? ""} ${aclFailure.message}`, /EPERM|EACCES/);
    assert.equal(mock.requests.length, requestCountBeforeAcl, "ACL denial blocks before a Native provider request");
    assert.match(providerSamples.at(-1)?.code ?? "", /EPERM|EACCES/);
  } finally {
    try {
      if (aclDenyApplied) runAclCommand("restore-deny", [memoryPath, "/remove:d", `*${sid}`]);
    } finally {
      await writeFile(path.join(evidenceOutputRoot, `${runId}-acl-commands.json`), JSON.stringify(aclCommands, null, 2) + "\n", "utf8");
    }
  }
  assert.equal(hash(await readFile(memoryPath)), memoryShaBeforeAcl, "restoring the synthetic file ACL leaves its bytes unchanged");
  assert.equal(providerSamples.at(-1)?.status, "failed");
  aclEvidence = { status: "pass", currentUserSidSha256: sidSha256, admissionFailure: aclFailure, commands: aclCommands,
    selectedFileSha256Before: memoryShaBeforeAcl, selectedFileSha256AfterRestore: hash(await readFile(memoryPath)) };
  const afterAclRestore = await host.submitPrompt(`P03_TURN_ACL_RECOVERED: Read ${memoryPath} after restoring the synthetic file ACL.`);
  assert.ok(afterAclRestore.turnId);
  assert.ok(mock.requests.some((row) => row.turnLabel === "P03_TURN_ACL_RECOVERED" && row.toolResultTexts.some((text) => text.includes("P03_MEMORY_RECOVERED"))));

  const sourceBeforeWrite = hash(await readFile(sourceRootPath));
  const memoryBeforeWrite = hash(await readFile(memoryPath));
  const writeErrorsBefore = nativeEvents.filter((event) => event.type === "tool_call_error").length;
  const writeDenied = await host.submitPrompt(`P03_TURN_WRITE_DENIED: Attempt a Native Write to ${sourceRootPath} with an unregistered tool.`);
  assert.ok(writeDenied.turnId);
  const writeTurnErrors = nativeEvents.filter((event) => event.type === "tool_call_error" && event.turnId === writeDenied.turnId);
  assert.ok(nativeEvents.filter((event) => event.type === "tool_call_error").length > writeErrorsBefore,
    "the unregistered Write produces a new Native tool-call error");
  const writeToolCall = mock.toolCalls.find((row) => row.turnLabel === "P03_TURN_WRITE_DENIED" && row.toolName === "Write");
  const writeToolError = writeTurnErrors.find((event) => event.toolCallId === writeToolCall?.toolCallId);
  const writeTurnRequests = mock.requests.filter((row) => row.turnLabel === "P03_TURN_WRITE_DENIED");
  const sourceAfterWrite = hash(await readFile(sourceRootPath));
  const memoryAfterWrite = hash(await readFile(memoryPath));
  writeProbe = {
    turnId: writeDenied.turnId,
    toolCallId: writeToolCall?.toolCallId,
    mockToolCall: writeToolCall,
    nativeToolEvents: writeTurnErrors,
    nativeToolError: writeToolError,
    requestToolNames: writeTurnRequests[0]?.toolNames,
    toolResultTexts: writeTurnRequests.flatMap((row) => row.toolResultTexts),
    sourceSha256Before: sourceBeforeWrite,
    sourceSha256After: sourceAfterWrite,
    memorySha256Before: memoryBeforeWrite,
    memorySha256After: memoryAfterWrite,
    filesystemWriteSandbox: "NOT_RUN; this probe validates Native tool registration/executor rejection only",
  };
  await writeFile(path.join(evidenceOutputRoot, `${runId}-write-probe.json`), JSON.stringify(writeProbe, null, 2) + "\n", "utf8");
  assert.ok(writeToolCall, "the controlled provider returned an unregistered Write tool call");
  assert.ok(writeToolError, "Native's tool error is correlated to the mock's unregistered Write call id on this turn");
  assert.match(writeToolError.errorMessage ?? "", /No such tool available:\s*Write|Tool not found:\s*Write|Write.*(?:not available|not allowed|unknown|unavailable)/i,
    "Native returns an explicit unknown/not-allowed Write error");
  assert.equal(sourceAfterWrite, sourceBeforeWrite, "unregistered Write leaves the synthetic current source unchanged");
  assert.equal(memoryAfterWrite, memoryBeforeWrite, "unregistered Write leaves the selected memory bytes unchanged");
  writeProbe.status = "native-unregistered-tool-rejected";

  const relevantRequests = mock.requests.filter((row) => row.turnLabel.startsWith("P03_TURN_"));
  assert.ok(relevantRequests.every((row) => row.toolNames.every((name) => name === "Read")), "the Native provider request exposes only the Read tool");
  assert.equal(mock.nonLoopbackRequests, 0);
  assert.equal(host.readAdmissionFailures().filter((failure) => failure.status === "blocked").length, 2, "corrupt UTF-8 and an actual ACL denial block admission");
  assert.ok(hookRuns.every((row) => row.packetCaptureError === undefined), "every Hook packet was captured and validated; no packet capture error is allowed");
  assert.equal(hookRuns.filter((row) => row.status === "completed" && row.exitCode === 0).length, nativeEvents.filter((event) => event.type === "turn_started").length,
    "each model-admitted turn passed the real Native Hook and Xiadie identity receipt gate");
} finally {
  await host?.close?.();
  await mock.close();
}

const finalMemory = readSelectedProjectMemory({ filename: memoryPath, memoryRoot });
const tsxPackage = JSON.parse(await readFile(path.join(p01SourceRoot, "node_modules", "tsx", "package.json"), "utf8"));
const typescriptPackage = JSON.parse(await readFile(path.join(repositoryRoot, "node_modules", "typescript", "package.json"), "utf8"));
const buildCommandPath = path.join(nativeRuntimeEvidenceRoot, "build-run-01-command.json");
const buildCommandBytes = await readFile(buildCommandPath);
const buildCommandRecord = JSON.parse(buildCommandBytes.toString("utf8"));
const copiedBuildCommandPath = path.join(evidenceOutputRoot, `${runId}-tsc-build-command.json`);
await writeFile(copiedBuildCommandPath, buildCommandBytes, { flag: "wx" });
const requestSummaries = mock.requests.map((row) => ({
  index: row.index,
  turnLabel: row.turnLabel,
  messageRoles: row.messageRoles,
  messageBytes: row.messageBytes,
  hasOldMemory: row.text.includes("P03_OLD_MEMORY_V1"),
  hasMemoryV2: row.text.includes("P03_MEMORY_V2"),
  hasRecoveredMemory: row.text.includes("P03_MEMORY_RECOVERED"),
  hasCurrentSource: row.text.includes("CURRENT_SOURCE_AUTHORITY"),
  hasTurnNonce: row.text.includes("u06-turn:"),
  toolNames: row.toolNames,
  toolResultMarkers: row.toolResultTexts.map((text) => text.match(/P03_[A-Z0-9_]+/)?.[0] ?? (text.includes("Error") ? "TOOL_ERROR" : "OTHER")),
  requestSha256: row.requestSha256,
}));

const result = {
  unit: "P03-U02",
  attemptId,
  baseline: "c691a5b7a975ac4420f880c8233c7b0bb7893958",
  sourcePin: { commit: nativeSourceCommit, clean: true, commands: sourceGitCommands },
  experimentRoot,
  evidenceOutputRoot,
  project: { projectId, workspace, nativeMemoryRoot: memoryRoot, selectedTopic: memoryPath, oldMemorySha256: initialMemory.sha256, finalMemorySha256: finalMemory.sha256 },
  nativeMemory: { nativeBuiltinEnabled: false, hostProviderSamples: providerSamples, rawReaderBoundBytes: 2048, selectedReadOnly: true },
  nativeRuntime: "executed pinned ZCode source with local synthetic provider",
  realModel: "NOT_RUN",
  installedZCodeApplication: "NOT_RUN",
  realCredentials: "NOT_READ",
  nativeProjectABRequestIsolation: "NOT_RUN; service/topology A/B is covered by the separate topology-service evidence",
  writeProbe,
  ports: mock.ports,
  abortedResponses: mock.abortedResponses,
  requests: requestSummaries,
  hookRuns,
  nativeEvents,
  admissionFailures: host?.readAdmissionFailures?.() ?? [],
  sourceHashes: sourceHashRows,
  hostVariantInputHashes,
  hostVariant: hostVariant.manifest ?? hostVariant.buildManifest ?? null,
  toolchain: { node: process.version, nodeExecutable: process.execPath, typescript: typescriptPackage.version,
    tsx: tsxPackage.version, hostVariantEsbuild: hostVariant.manifest.tool.version,
    tscBuildCommand: { path: copiedBuildCommandPath, sourceRecordPath: buildCommandPath, sha256: hash(buildCommandBytes), exitCode: buildCommandRecord.exit_code } },
  nativeTypeScriptLoader: { path: tsxApiPath, mode: "tsx.register", usedForPinnedNativeSourceImports: true },
  runtimeEnvironment: { systemAllowlist: ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"],
    ownedProfile: profile, ownedDataBaseDir: path.join(home, ".zcode-data"), inheritedVariablesClearedBeforeNativeImports: true },
  acl: aclEvidence,
  filesystem: { reads: fileSystemPort.readRecords, readFailures: fileSystemPort.readFailures, denied: fileSystemPort.deniedRecords,
    immutableFixtureHashes: { sourceBeforeWrite: originalSourceSha256, memoryBeforeWrite: originalMemorySha256, deniedFile: deniedFileSha256 } },
};
await writeFile(path.join(evidenceOutputRoot, `${runId}-runtime-result.json`), JSON.stringify(result, null, 2) + "\n", "utf8");
await writeFile(path.join(evidenceOutputRoot, `${runId}-host-variant-manifest.json`), JSON.stringify(hostVariant.manifest, null, 2) + "\n", "utf8");
process.stdout.write(`P03_U02_NATIVE_RUNTIME_RESULT ${JSON.stringify({
  status: "pass",
  attemptId,
  actualNativeRequests: mock.requests.length,
  actualReadCalls: fileSystemPort.readRecords.length,
  hostProviderSamples: providerSamples.length,
  loopbackPorts: mock.ports,
  cancelledResponseCount: mock.abortedResponses,
  oldMemoryHash: initialMemory.sha256,
  finalMemoryHash: finalMemory.sha256,
  reportPath: path.join(evidenceOutputRoot, `${runId}-runtime-result.json`),
})}\n`);

async function createBoundedReadFileSystemPort({ nativeFileSystem, nativeFileContracts, memoryPath, memoryRoot, workspaceRoot }) {
  const delegate = new nativeFileSystem.NodeFileSystemAdapter({ textSearchEngine: "javascript" });
  const readRecords = [];
  const readFailures = [];
  const deniedRecords = [];
  const allowedMemoryPath = path.resolve(memoryPath);
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const toError = (code, filename, message, cause) => nativeFileContracts.createFileSystemError({ code, path: filename, message, cause });
  const selected = (filename) => path.resolve(filename) === allowedMemoryPath;
  const withinWorkspace = (filename) => within(realWorkspaceRoot, path.resolve(filename));
  const unauthorized = (filename) => {
    deniedRecords.push({ path: path.resolve(filename), reason: "outside exact selected memory file and synthetic workspace" });
    return toError("permission_denied", path.resolve(filename), "P03 Native Read fixture is restricted to one selected memory topic and its synthetic workspace");
  };
  const failMemoryRead = (error, filename) => {
    const code = error?.code === "ENOENT" ? "not_found" : error?.code === "too_large" ? "too_large" : "io_error";
    return toError(code, path.resolve(filename), `P03 bounded raw-byte memory reader failed: ${error?.code ?? "unknown"}`, error);
  };
  const readSelected = (filename, request) => {
    try {
      const row = readCurrentTurnMemory({ filename, memoryRoot });
      readRecords.push({ operation: "read", path: row.memoryPath, sha256: row.sha256, bytes: row.bytes.length,
        admissionSnapshotBound: true, sessionId: request?.trace?.sessionId, turnId: request?.trace?.turnId });
      return row;
    } catch (error) {
      const snapshot = globalThis[TURN_SNAPSHOT_KEY];
      readFailures.push({ operation: "read", path: path.resolve(filename), code: error?.code ?? error?.cause?.code ?? "unknown",
        sessionId: request?.trace?.sessionId, turnId: request?.trace?.turnId,
        snapshotSessionId: snapshot?.sessionId, snapshotSha256: snapshot?.sha256 });
      throw failMemoryRead(error, filename);
    }
  };
  return Object.assign(new Proxy(delegate, {
    get(target, property) {
      if (property === "stat") return async (request, options) => {
        if (selected(request.path)) {
          const row = readSelected(request.path, request);
          return { path: row.memoryPath, kind: "file", sizeBytes: row.bytes.length, mtimeMs: row.mtimeMs,
            revision: { id: `sha256:${row.sha256}`, mtimeMs: row.mtimeMs, sizeBytes: row.bytes.length, hash: row.sha256 } };
        }
        if (!withinWorkspace(request.path)) throw unauthorized(request.path);
        return target.stat.call(target, request, options);
      };
      if (property === "readTextFileRange") return async (request, options) => {
        if (selected(request.path)) {
          const row = readSelected(request.path, request);
          if (Number.isSafeInteger(request.maxBytes) && row.bytes.length > request.maxBytes) throw toError("too_large", row.memoryPath, "Selected memory topic exceeds Native Read maxBytes");
          const normalized = row.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          const lines = normalized.split("\n");
          if (normalized.endsWith("\n")) lines.pop();
          const offset = Math.max(0, request.offsetLine ?? 0);
          const end = request.limitLines === undefined ? lines.length : offset + request.limitLines;
          const content = lines.slice(offset, end).join("\n");
          const lineCount = content.length === 0 ? 0 : content.split("\n").length;
          return { path: row.memoryPath, content, encoding: "utf8", lineEndings: row.text.includes("\r\n") ? "CRLF" : "LF",
            bytesRead: row.bytes.length, sizeBytes: row.bytes.length, truncated: false, startLine: offset + 1,
            lineCount, totalLines: lines.length,
            revision: { id: `sha256:${row.sha256}`, mtimeMs: row.mtimeMs, sizeBytes: row.bytes.length, hash: row.sha256 } };
        }
        if (!withinWorkspace(request.path)) throw unauthorized(request.path);
        return target.readTextFileRange.call(target, request, options);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }), { readRecords, readFailures, deniedRecords });
}

function createProvider(baseUrl) {
  return {
    providerId: "p03-u02-local",
    providerName: "P03 U02 synthetic loopback",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "p03-u02-synthetic-only" },
      api: { type: "openai-chat-completions", baseUrl },
      builtinModelIds: ["synthetic-read-model"],
      personalModelIds: [],
      modelOrder: ["synthetic-read-model"],
      visibility: "visible",
    },
    models: [{ modelId: "synthetic-read-model", config: {
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
      optionSpecs: { reasoningLevel: { values: ["none"], map: "{}" }, maxOutputTokens: { max: 4096, map: "{}" } },
    } }],
  };
}

async function startMockProvider({ memoryPath, sourcePath, deniedPath }) {
  const state = { requests: [], toolCalls: [], ports: [], nonLoopbackRequests: 0, abortedResponses: 0, readMutation: undefined, heldLabels: new Set() };
  const server = http.createServer(async (request, response) => {
    response.on("close", () => { if (!response.writableEnded) state.abortedResponses += 1; });
    const remote = request.socket.remoteAddress ?? "";
    if (!(remote === "127.0.0.1" || remote === "::1" || remote.startsWith("::ffff:127.0.0.1"))) {
      state.nonLoopbackRequests += 1;
      response.writeHead(403).end("loopback only");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { response.writeHead(400).end("invalid json"); return; }
    const messages = body.messages ?? [];
    const labels = [
      "P03_TURN_WRITE_DENIED", "P03_TURN_ACL_RECOVERED", "P03_TURN_ACL", "P03_TURN_AFTER_CANCEL", "P03_TURN_CANCEL", "P03_TURN_AFTER_CORRUPT_REPAIR", "P03_TURN_CORRUPT",
      "P03_TURN_RECOVERED", "P03_TURN_SOURCE_RACE", "P03_TURN_PERMISSION", "P03_TURN_TWO", "P03_TURN_ONE",
    ];
    let turnLabel = "P03_TURN_UNKNOWN";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const serializedMessage = JSON.stringify(messages[index]);
      const match = labels.find((label) => serializedMessage.includes(label));
      if (match) { turnLabel = match; break; }
    }
    const serialized = JSON.stringify(messages);
    const requestRecord = {
      index: state.requests.length + 1,
      turnLabel,
      body,
      text: serialized,
      messageRoles: (body.messages ?? []).map((message) => message.role ?? "unknown"),
      messageBytes: utf8Bytes(serialized),
      toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "unknown"),
      toolResultTexts: (body.messages ?? []).filter((message) => message.role === "tool").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)),
      requestSha256: hash(Buffer.concat(chunks)),
    };
    state.requests.push(requestRecord);
    const labelCount = state.requests.filter((row) => row.turnLabel === turnLabel).length;
    if (state.heldLabels.delete(turnLabel)) return;

    if (state.readMutation && state.readMutation.label === turnLabel && labelCount === 1) {
      await writeFile(state.readMutation.targetPath, state.readMutation.content, "utf8");
      state.readMutation = undefined;
    }

    let target;
    let toolCallName = "Read";
    let toolCallArguments;
    let finalText = "P03_NATIVE_SYNTHETIC_FOLLOWUP_OK";
    if (turnLabel === "P03_TURN_ONE") {
      if (labelCount === 1) target = sourcePath;
      else if (labelCount === 2) target = memoryPath;
      else finalText = "P03_NATIVE_READ_SOURCE_AND_MEMORY_OK";
    } else if (["P03_TURN_TWO", "P03_TURN_RECOVERED", "P03_TURN_AFTER_CORRUPT_REPAIR", "P03_TURN_AFTER_CANCEL", "P03_TURN_ACL_RECOVERED"].includes(turnLabel)) {
      if (labelCount === 1) target = memoryPath;
      else finalText = "P03_NATIVE_FRESH_TURN_READ_OK";
    } else if (turnLabel === "P03_TURN_PERMISSION") {
      if (labelCount === 1) target = path.join(path.dirname(memoryPath), "..", "..", "..", "outside-allowlist.txt");
      else finalText = "P03_NATIVE_DENIED_READ_SURFACED";
    } else if (turnLabel === "P03_TURN_SOURCE_RACE") {
      if (labelCount === 1) target = memoryPath;
      else finalText = "P03_NATIVE_SOURCE_CHANGE_ERROR_SURFACED";
    } else if (turnLabel === "P03_TURN_WRITE_DENIED") {
      if (labelCount === 1) {
        target = sourcePath;
        toolCallName = "Write";
        toolCallArguments = { file_path: sourcePath, content: "P03_WRITE_MUST_BE_REJECTED\n" };
      } else finalText = "P03_NATIVE_UNREGISTERED_WRITE_REJECTED";
    }

    if (turnLabel === "P03_TURN_PERMISSION" && labelCount === 1) target = deniedPath;

    const toolCallId = target ? `p03-read-${requestRecord.index}` : undefined;
    if (toolCallId) {
      const toolCall = { turnLabel, toolCallId, toolName: toolCallName, arguments: toolCallArguments ?? { file_path: target } };
      state.toolCalls.push(toolCall);
      requestRecord.responseToolCall = toolCall;
    }

    const completion = target ? {
      id: `chatcmpl-p03-${requestRecord.index}`,
      object: "chat.completion",
      created: 1,
      model: "synthetic-read-model",
      choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{
        id: toolCallId,
        type: "function",
        function: { name: toolCallName, arguments: JSON.stringify(toolCallArguments ?? { file_path: target }) },
      }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } : {
      id: `chatcmpl-p03-${requestRecord.index}`,
      object: "chat.completion",
      created: 1,
      model: "synthetic-read-model",
      choices: [{ index: 0, message: { role: "assistant", content: finalText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    if ((request.headers.accept ?? "").includes("text/event-stream")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = target
        ? { role: "assistant", tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: toolCallName, arguments: JSON.stringify(toolCallArguments ?? { file_path: target }) } }] }
        : { role: "assistant", content: finalText };
      response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "synthetic-read-model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "synthetic-read-model", choices: [{ index: 0, delta: {}, finish_reason: completion.choices[0].finish_reason }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(completion));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  state.ports.push(address.port);
  return {
    requests: state.requests,
    toolCalls: state.toolCalls,
    ports: state.ports,
    get nonLoopbackRequests() { return state.nonLoopbackRequests; },
    get abortedResponses() { return state.abortedResponses; },
    setReadMutation(value) { state.readMutation = value; },
    holdNextLabel(value) { state.heldLabels.add(value); },
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

function createExecutionPort({ home, temp, nodeExecutable, hookRuns }) {
  const env = safeEnvironment(home, temp);
  return {
    async run(request, options = {}) {
      const startedAt = new Date();
      const requestEnv = { ...env, ...(request.env?.set ?? {}) };
      for (const key of request.env?.unset ?? []) delete requestEnv[key];
      const event = request.trace?.attributes?.hookEventName;
      if (event === "UserPromptSubmit") {
        const data = requestEnv.XIA_DIE_PROJECT_MEMORY_DATA;
        const row = {
          nonce: requestEnv.XIA_DIE_TICKET_NONCE,
          status: "started",
          dataBytes: typeof data === "string" ? utf8Bytes(data) : undefined,
          dataSha256: typeof data === "string" ? hash(data) : undefined,
        };
        try {
          assert.equal(typeof data, "string", "Host passes memory through the exact helper environment variable");
          const dataPartitions = JSON.parse(data);
          assert.deepEqual(Object.keys(dataPartitions).sort(), ["content", "evidence", "state"]);
          row.dataPartitions = { stateCount: dataPartitions.state.length, evidenceCount: dataPartitions.evidence.length, contentCount: dataPartitions.content.length };
          assert.equal(dataPartitions.content.length, 1);
        } catch (error) {
          row.packetCaptureError = error instanceof Error ? error.message : String(error);
        }
        hookRuns.push(row);
      }
      const child = spawn(request.command.file ?? nodeExecutable, [...(request.command.args ?? [])], {
        cwd: request.cwd,
        env: requestEnv,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLength = 0;
      let stderrLength = 0;
      let timedOut = false;
      let cancelled = false;
      let tooMuchOutput = false;
      const maxOutput = 128 * 1024;
      child.stdout.on("data", (chunk) => { stdoutLength += chunk.length; if (stdoutLength <= maxOutput) stdoutChunks.push(chunk); else tooMuchOutput = true; });
      child.stderr.on("data", (chunk) => { stderrLength += chunk.length; if (stderrLength <= maxOutput) stderrChunks.push(chunk); else tooMuchOutput = true; });
      if (request.stdin !== undefined) child.stdin.end(request.stdin); else child.stdin.end();
      const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
      const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : undefined;
      const signal = options.signal;
      const onAbort = () => { cancelled = true; child.kill(); };
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
      const exit = await new Promise((resolve) => {
        child.once("error", (error) => resolve({ error }));
        child.once("close", (code, signalName) => resolve({ code, signalName }));
      });
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const completedAt = new Date();
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      const result = {
        status: exit.error ? "spawn_error" : cancelled ? "cancelled" : timedOut ? "timed_out" : exit.code === 0 ? "completed" : "failed",
        ...(exit.code === null || exit.code === undefined ? {} : { exitCode: exit.code }),
        stdout: { text: stdout.toString("utf8"), bytes: stdoutLength, truncated: tooMuchOutput },
        stderr: { text: stderr.toString("utf8"), bytes: stderrLength, truncated: tooMuchOutput },
        durationMs: completedAt.getTime() - startedAt.getTime(),
        timedOut,
        cancelled,
        startedAt,
        completedAt,
        ...(exit.error ? { error: { type: "spawn_error", message: exit.error.message } } : {}),
      };
      if (event === "UserPromptSubmit") {
        const row = hookRuns.at(-1);
        row.status = result.status;
        row.exitCode = result.exitCode;
        row.stdoutBytes = result.stdout.bytes;
        row.stderrBytes = result.stderr.bytes;
        if (result.status === "completed" && result.exitCode === 0 && !result.stdout.truncated) {
          try {
            const envelope = JSON.parse(result.stdout.text);
            const rendered = envelope.additionalContext;
            const packet = typeof rendered === "string" ? JSON.parse(rendered) : undefined;
            const binding = packet?.state?.find((record) => record?.value?.kind === "turn-binding")?.value;
            row.packetBytes = typeof rendered === "string" ? utf8Bytes(rendered) : undefined;
            row.packetSha256 = typeof rendered === "string" ? hash(rendered) : undefined;
            row.packetVersion = packet?.version;
            row.packetNonce = binding?.nonce;
            row.packetInstructionFields = packet?.instruction?.map((record) => record.field);
            row.packetContentCount = packet?.content?.length;
            row.packetContentHashes = packet?.content?.map((record) => record.value?.sha256);
            row.packetContentMarkers = packet?.content?.map((record) => record.value?.text?.match(/P03_[A-Z0-9_]+/)?.[0]);
            assert.equal(row.packetNonce, row.nonce, "Hook rebuilt the same turn nonce that the host placed in its trusted environment");
            assert.ok(row.packetBytes <= 12_000, "the actual complete Native identity/data packet fits the existing UTF-8 byte budget");
            assert.deepEqual(row.packetInstructionFields, ["identity", "voice", "values", "boundaries", "examples"]);
            assert.equal(row.packetContentCount, 1);
          } catch (error) {
            row.packetCaptureError ??= error instanceof Error ? error.message : String(error);
          }
        } else row.packetCaptureError ??= `Hook did not complete cleanly: ${result.status}/${result.exitCode ?? "no-exit"}`;
      }
      return result;
    },
  };
}

function safeEnvironment(homeDirectory, tempDirectory) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const fixedPath = [
    systemRoot ? path.join(systemRoot, "System32") : undefined,
    systemRoot,
    path.dirname(nodeExecutable),
  ].filter(Boolean).join(path.delimiter);
  const env = {
    PATH: fixedPath,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    APPDATA: path.join(homeDirectory, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDirectory, "AppData", "Local"),
    TEMP: tempDirectory,
    TMP: tempDirectory,
    ZCODE_DATA_BASE_DIR: path.join(homeDirectory, ".zcode-data"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.resolve(homeDirectory, "..", "empty.gitconfig"),
    ZCODE_MODEL_RETRY_MAX_RETRIES: "0",
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  if (process.env.ComSpec) env.ComSpec = process.env.ComSpec;
  if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  return env;
}

function sanitizeNativeEvent(event) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const error = payload.error && typeof payload.error === "object" ? payload.error : {};
  return {
    type: event.type,
    turnId: event.turnId,
    toolCallId: payload.toolCallId,
    errorCode: error.code,
    errorMessage: error.message,
    errorType: error.type,
    toolStatus: event.toolStatus,
    status: event.status,
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Native U02 synthetic condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
