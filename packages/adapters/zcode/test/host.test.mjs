import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const profilesRoot = path.join(repositoryRoot, ".runtime", "P01", "u06-unit-profiles");
const hostModuleUrl = new URL("../../../../dist/packages/adapters/zcode/src/index.js", import.meta.url);
const { createXiadieZCodeApp } = await import(hostModuleUrl.href);

test("disabled host submits concurrently through the native app without an extension queue", async (t) => {
  const profile = await createProfile(t);
  const entered = [];
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const fixture = await createHost(profile, {
    enabled: false,
    submitPrompt: (prompt) => {
      entered.push(prompt);
      if (prompt === "first") return firstReleased.then(() => "first-result");
      return Promise.resolve("second-result");
    },
  });

  const first = fixture.host.submitPrompt("first");
  const second = fixture.host.submitPrompt("second");
  await Promise.resolve();
  assert.deepEqual(entered, ["first", "second"]);
  assert.equal(await second, "second-result");
  const input = { text: "native disabled input" };
  const nativeOptions = { requireIdle: false };
  const directAdmission = await fixture.host.sendInput(input, nativeOptions);
  assert.strictEqual(directAdmission, fixture.nativeSendResult);
  assert.strictEqual(fixture.nativeInputCalls[0].input, input);
  assert.strictEqual(fixture.nativeInputCalls[0].options, nativeOptions);
  releaseFirst();
  assert.equal(await first, "first-result");
  await fixture.host.close?.();
});

test("enabled host forces native storage into its owned profile and keeps user-config storage overrides contained", async (t) => {
  const profile = await createProfile(t, {
    userConfig: { storage: { dir: path.join(os.tmpdir(), "u06-user-config-storage") } },
    projectConfig: { storage: { dir: path.join(os.tmpdir(), "u06-project-config-storage") } },
  });
  const fixture = await createHost(profile, { enabled: true });
  const expectedStorage = path.join(profile.root, "storage");
  assert.equal(fixture.nativeOptions.env.ZCODE_STORAGE_DIR, expectedStorage);
  assert.equal(fixture.nativeOptions.pluginStorageRoot, profile.pluginStorageRoot);
  assert.equal(fixture.nativeOptions.userConfigPath, profile.userConfigPath);
  assert.equal(fixture.nativeOptions.projectConfigPath, profile.projectConfigPath);
  assert.equal(fixture.nativeOptions.skipUserConfig, false);
  await fixture.host.close?.();
});

test("enabled host rejects missing config isolation and external storage environment before native app creation", async (t) => {
  const profile = await createProfile(t);
  let nativeCreateCalls = 0;
  const base = hostOptions(profile, {
    enabled: true,
    onCreate: () => { nativeCreateCalls += 1; },
  });

  await assert.rejects(
    createXiadieZCodeApp({ ...base.input, appOptions: { ...base.input.appOptions, userConfigPath: undefined } }),
    /explicit, isolated user\/project config paths/,
  );
  assert.equal(nativeCreateCalls, 0);

  const outsideStorage = path.join(os.tmpdir(), "u06-external-storage");
  await assert.rejects(
    createXiadieZCodeApp({
      ...base.input,
      appOptions: { ...base.input.appOptions, env: { ...base.input.appOptions.env, ZCODE_STORAGE_DIR: outsideStorage } },
    }),
    /ZCODE_STORAGE_DIR.*owned profile/,
  );
  assert.equal(nativeCreateCalls, 0);
});

test("enabled host rejects a storage junction that resolves outside its owned profile", async (t) => {
  const profile = await createProfile(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "u06-outside-storage-"));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  await symlink(outside, path.join(profile.root, "storage"), "junction");
  let nativeCreateCalls = 0;
  const fixture = hostOptions(profile, {
    enabled: true,
    onCreate: () => { nativeCreateCalls += 1; },
  });

  await assert.rejects(fixture.create(), /owned storage root must remain inside its owned profile/);
  assert.equal(nativeCreateCalls, 0);
});

test("model adapter rejects a call without the current Hook receipt before delegate and bounds admission history", async (t) => {
  const profile = await createProfile(t);
  const fixture = await createHost(profile, { enabled: true });
  const model = fixture.nativeOptions.modelAdapter.createModel({});

  for (let index = 0; index < 70; index += 1) {
    assert.throws(() => model.generateText({ messages: [] }), /identity gate rejected model delegation/);
  }
  assert.equal(fixture.adapterCalls.generateText, 0);
  const failures = fixture.host.readAdmissionFailures();
  assert.equal(failures.length, 64);
  assert.ok(failures.every((failure) => failure.reasonCode === "model-receipt"));
  assert.ok(failures.every((failure) => !("prompt" in failure) && !("stdout" in failure) && !("stderr" in failure)));
  await fixture.host.close?.();
});

test("enabled sendInput forces idle admission and holds the host lock until native completion", async (t) => {
  const profile = await createProfile(t);
  let releaseCompletion;
  const completion = new Promise((resolve) => { releaseCompletion = resolve; });
  const originalCallback = () => {};
  const fixture = await createHost(profile, {
    enabled: true,
    sendInput: () => ({ kind: "started_turn", turnId: "unit-turn", completion }),
  });

  const admission = await fixture.host.sendInput({ text: "unit idle turn" }, { onEvent: originalCallback, requireIdle: false });
  assert.equal(admission.kind, "started_turn");
  assert.equal(fixture.nativeInputCalls[0].options.requireIdle, true);
  assert.strictEqual(fixture.nativeInputCalls[0].options.onEvent, originalCallback);
  await assert.rejects(fixture.host.submitPrompt("overlapping input"), /sendInput is in flight/);
  releaseCompletion({ response: "done", turnId: "unit-turn", traceId: "unit-trace", events: [], projection: {} });
  await admission.completion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await fixture.host.submitPrompt("after completion"), { prompt: "after completion" });
  await fixture.host.close?.();
});

test("enabled sendInput clears its ticket and idle lock when native admission rejects", async (t) => {
  const profile = await createProfile(t);
  const fixture = await createHost(profile, {
    enabled: true,
    sendInput: () => ({ kind: "rejected", reason: "busy" }),
  });

  await assert.rejects(fixture.host.sendInput("synthetic busy input"), /native admission returned rejected/);
  assert.equal(fixture.nativeInputCalls[0].options.requireIdle, true);
  assert.deepEqual(await fixture.host.submitPrompt("after rejection"), { prompt: "after rejection" });
  await fixture.host.close?.();
});

async function createProfile(t, config = {}) {
  await mkdir(profilesRoot, { recursive: true });
  const root = await mkdtemp(path.join(profilesRoot, "host-unit-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const pluginStorageRoot = path.join(root, "plugin-storage");
  const installRoot = path.join(pluginStorageRoot, "cache", "xiadie");
  const dataRoot = path.join(pluginStorageRoot, "data", "xiadie");
  await Promise.all([
    mkdir(path.join(root, "home"), { recursive: true }),
    mkdir(path.join(root, "temp"), { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
  ]);
  const userConfigPath = path.join(root, "user.json");
  const projectConfigPath = path.join(root, "project.json");
  await Promise.all([
    writeFile(userConfigPath, JSON.stringify(config.userConfig ?? {}), "utf8"),
    writeFile(projectConfigPath, JSON.stringify(config.projectConfig ?? {}), "utf8"),
  ]);
  return { root, pluginStorageRoot, installRoot, dataRoot, userConfigPath, projectConfigPath };
}

function hostOptions(profile, options = {}) {
  const appOptions = {
    pluginStorageRoot: profile.pluginStorageRoot,
    userConfigPath: profile.userConfigPath,
    projectConfigPath: profile.projectConfigPath,
    workingDirectory: profile.root,
    skipUserConfig: false,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(profile.root, "home"),
      USERPROFILE: path.join(profile.root, "home"),
      TEMP: path.join(profile.root, "temp"),
      TMP: path.join(profile.root, "temp"),
    },
  };
  let nativeOptions;
  const adapterCalls = { generateText: 0, streamText: 0 };
  const nativeInputCalls = [];
  const nativeSendResult = { kind: "queued", pendingInputId: "u06-disabled-queue", queueLength: 1, turnId: "u06-unit-session" };
  const modelAdapter = {
    createModel() {
      const model = {
        providerId: "unit",
        modelId: "unit-model",
        properties: {},
        optionSpecs: {},
        options: {},
        bind(bindOptions) { return { ...model, options: bindOptions ?? {} }; },
        async generateText() { adapterCalls.generateText += 1; return {}; },
        async *streamText() { adapterCalls.streamText += 1; yield {}; },
      };
      return model;
    },
    addStatusSink() {},
    setModelIoFullRetentionEnabled() {},
  };
  const nativeApp = {
    sessionId: "u06-unit-session",
    runtime: {},
    async submitPrompt(prompt) { return options.submitPrompt ? options.submitPrompt(prompt) : { prompt }; },
    async sendInput(input, nativeOptions) {
      nativeInputCalls.push({ input, options: nativeOptions });
      return options.sendInput ? options.sendInput(input, nativeOptions) : nativeSendResult;
    },
    async resume() {},
    async close() {},
  };
  const native = {
    async createZCodeApp(receivedOptions) {
      options.onCreate?.();
      nativeOptions = receivedOptions;
      return nativeApp;
    },
    getCurrentModelInvocationContext() { return undefined; },
  };
  const executionPort = { async run() { throw new Error("unit fake should not run a Hook"); } };
  const input = {
    native,
    appOptions,
    executionPort,
    modelAdapter,
    enabled: options.enabled,
    ...(options.enabled ? {
      assetsRoot: path.join(repositoryRoot, "assets", "character"),
      moduleRoot: path.join(repositoryRoot, "dist"),
      installedPluginRoot: profile.installRoot,
      dataRoot: profile.dataRoot,
      pluginStorageRoot: profile.pluginStorageRoot,
      ownedProfileRoot: profile.root,
    } : {}),
  };
  return {
    input,
    getNativeOptions: () => nativeOptions,
    adapterCalls,
    nativeInputCalls,
    nativeSendResult,
    create: () => createXiadieZCodeApp(input),
  };
}

async function createHost(profile, options) {
  const fixture = hostOptions(profile, options);
  const host = await fixture.create();
  return { ...fixture, host, nativeOptions: fixture.getNativeOptions() };
}
