import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(process.argv[2]);
const reviewRoot = path.resolve(process.argv[3]);
const authorCommit = "ef716c8a1ae4b0c67c9af9ea6d84fee809399d1a";
const baselineCommit = "f01f3d3551b55b8bde6889a940e9bcc68425240b";
const manifestRel = "evidence/P01-U06/20261002-01/manifest.json";
const expectedManifestSha256 = "524fc3fd2b6135f3dcff04d9b3c856ac9a2849baacb536d45c140500142db7a2";
const digest = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const git = (args) => {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

assert.equal(git(["rev-parse", "HEAD"]), authorCommit, "review worktree must point at the exact author commit");
assert.equal(git(["status", "--porcelain"]), "", "review worktree must remain clean");
const manifestBytes = await readFile(path.join(projectRoot, manifestRel));
assert.equal(digest(manifestBytes), expectedManifestSha256, "author manifest hash");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
assert.equal(manifest.status, "ready_for_review");
assert.equal(manifest.baselineCommit, baselineCommit);
assert.equal(manifest.files.length, 162);

const changed = git(["diff", "--name-only", baselineCommit, authorCommit])
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => file !== manifestRel)
  .sort();
const listed = manifest.files.map((entry) => entry.path).sort();
assert.deepEqual(listed, changed, "manifest path set must exactly cover author commit changes except itself");
for (const entry of manifest.files) {
  const absolute = path.resolve(projectRoot, entry.path);
  const relative = path.relative(projectRoot, absolute);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `manifest path escapes worktree: ${entry.path}`);
  const bytes = await readFile(absolute);
  assert.equal(bytes.byteLength, entry.bytes, `manifest byte mismatch: ${entry.path}`);
  assert.equal(digest(bytes), entry.sha256, `manifest SHA-256 mismatch: ${entry.path}`);
  const blob = digest(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]), "sha1");
  assert.equal(blob, entry.gitBlobSha1, `manifest Git blob mismatch: ${entry.path}`);
}

const standardRoot = reviewRoot;
const summary = JSON.parse(await readFile(path.join(standardRoot, "standard-run-summary.json"), "utf8"));
assert.deepEqual(summary.map((entry) => entry.id), [
  "frozen-install", "check", "build", "unit-u06", "contract-u06", "integration-u06",
]);
const standardEvidence = [];
for (const item of summary) {
  assert.equal(item.exitCode, 0, `standard command failed: ${item.id}`);
  assert.equal(item.spawnError, null);
  const execution = JSON.parse(await readFile(path.join(standardRoot, "logs", item.id + ".execution.json"), "utf8"));
  assert.equal(execution.exitCode, 0, `execution record failed: ${item.id}`);
  assert.equal(execution.spawnError, null);
  for (const stream of ["stdout", "stderr"]) {
    const output = await readFile(path.join(standardRoot, "logs", item.id + "." + stream + ".log"));
    assert.equal(output.byteLength, execution[stream].bytes, `${item.id} ${stream} byte mismatch`);
    assert.equal(digest(output), execution[stream].sha256, `${item.id} ${stream} SHA-256 mismatch`);
  }
  standardEvidence.push({ id: item.id, exitCode: execution.exitCode, stdoutBytes: execution.stdout.bytes, stderrBytes: execution.stderr.bytes });
}
for (const [id, expectedPasses] of [["unit-u06", 7], ["contract-u06", 2], ["integration-u06", 15]]) {
  const stdout = await readFile(path.join(standardRoot, "logs", id + ".stdout.log"), "utf8");
  assert.match(stdout, new RegExp(`pass ${expectedPasses}\\b`), `${id} pass count`);
  assert.match(stdout, /fail 0\b/, `${id} failures`);
  assert.match(stdout, /skipped 0\b/, `${id} skips`);
}
const checkOutput = await readFile(path.join(standardRoot, "logs", "check.stdout.log"), "utf8");
assert.match(checkOutput, /BOUNDARY_SCAN_NOT_RUN: packages\/core is absent/);

const hostUrl = pathToFileURL(path.join(projectRoot, "dist", "packages", "adapters", "zcode", "src", "index.js")).href;
const contextUrl = pathToFileURL(path.join(projectRoot, "dist", "packages", "context", "src", "index.js")).href;
const loaderUrl = pathToFileURL(path.join(projectRoot, "dist", "packages", "character", "src", "loader.js")).href;
const { createXiadieZCodeApp } = await import(hostUrl);
const { buildContextPacket, renderContextPacket } = await import(contextUrl);
const { loadCharacter } = await import(loaderUrl);
const probeTempRoot = path.join(reviewRoot, "probe-temp");
await mkdir(probeTempRoot, { recursive: true });
const profileRoot = await mkdtemp(path.join(probeTempRoot, "profile-"));
const probeResults = [];

try {
  // Enabled mode: native Hook identity and packet receipt are valid, but another turn trace cannot borrow them.
  const pluginStorageRoot = path.join(profileRoot, "plugin-storage");
  const installRoot = path.join(pluginStorageRoot, "cache", "xiadie");
  const dataRoot = path.join(pluginStorageRoot, "data", "xiadie");
  const home = path.join(profileRoot, "home");
  const temp = path.join(profileRoot, "temp");
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);
  const userConfigPath = path.join(profileRoot, "user.json");
  const projectConfigPath = path.join(profileRoot, "project.json");
  await Promise.all([
    writeFile(userConfigPath, "{}", "utf8"),
    writeFile(projectConfigPath, "{}", "utf8"),
  ]);
  const sessionId = "review-session";
  const assetsRoot = path.join(projectRoot, "assets", "character");
  const nonces = [];
  const state = { invocation: undefined, nativeModelDelegates: 0, turnCount: 0, sendInputOptions: undefined };
  let resolveSendCompletion;
  const sendCompletion = new Promise((resolve) => { resolveSendCompletion = resolve; });
  const modelAdapter = {
    createModel(options) {
      const delegate = {
        providerId: "review",
        modelId: "mock",
        properties: {},
        optionSpecs: {},
        options,
        bind(bindOptions) { return { ...delegate, options: bindOptions ?? options }; },
        async generateText() {
          state.nativeModelDelegates += 1;
          return { text: "mock accepted" };
        },
        async *streamText() { yield { text: "mock stream" }; },
      };
      return delegate;
    },
    addStatusSink() {},
    setModelIoFullRetentionEnabled() {},
  };
  const executionPort = {
    async run(request) {
      const stdin = Buffer.from(request.stdin).toString("utf8");
      const input = JSON.parse(stdin);
      const env = request.env?.set ?? {};
      const nonce = env.XIA_DIE_TICKET_NONCE;
      const event = input.hookEventName ?? input.hook_event_name;
      const sid = input.sessionId ?? input.session_id;
      const turnId = input.turnId ?? input.turn_id;
      const transcriptPath = input.transcriptPath ?? input.transcript_path;
      assert.equal(event, "UserPromptSubmit");
      assert.equal(request.trace.sessionId, sid);
      assert.equal(request.trace.turnId, turnId);
      assert.equal(request.trace.attributes.hookEventName, event);
      assert.equal(env.XIA_DIE_HOOK_EVENT, event);
      assert.ok(typeof nonce === "string" && nonce.length > 0);
      nonces.push(nonce);
      const character = loadCharacter(assetsRoot);
      const packet = buildContextPacket(character, {
        scope: `zcode-session:${sid}`,
        version: `u06-turn:${nonce}`,
        max_tokens: 12_000,
        state: [{ source_refs: ["trusted-host:per-turn-nonce"], value: { kind: "turn-binding", nonce } }],
        evidence: [],
        content: [],
      });
      const additionalContext = renderContextPacket(packet);
      const transcript = await readFile(transcriptPath);
      const envelope = {
        additionalContext,
        xiadieReceipt: {
          version: 1,
          nonce,
          event,
          sessionId: sid,
          turnId,
          packetSha256: digest(Buffer.from(additionalContext, "utf8")),
          transcriptBytes: transcript.byteLength,
          transcriptSha256: digest(transcript),
          character: { id: character.id, version: character.version, contentSha256: character.contentSha256 },
        },
      };
      const stdout = JSON.stringify(envelope);
      const now = new Date();
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: stdout, bytes: Buffer.byteLength(stdout), truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: now,
        completedAt: now,
      };
    },
  };
  const nativeAppEnabled = {
    sessionId,
    runtime: {},
    async submitPrompt(prompt) {
      if (prompt === "/compact") throw new Error("review synthetic native compact failure");
      const turnId = `hook-turn-${++state.turnCount}`;
      const transcriptPath = path.join(profileRoot, `transcript-${state.turnCount}.jsonl`);
      await writeFile(transcriptPath, JSON.stringify({ prompt }), "utf8");
      const request = {
        command: { mode: "argv", file: "node", args: [path.join(installRoot, "hooks", "context.mjs")] },
        stdin: JSON.stringify({ hookEventName: "UserPromptSubmit", sessionId, turnId, transcriptPath }),
        trace: { sessionId, turnId, attributes: { hookEventName: "UserPromptSubmit" } },
      };
      const hook = await nativeOptions.executionPort.run(request);
      assert.equal(hook.status, "completed");
      assert.equal(hook.exitCode, 0);
      const envelope = JSON.parse(hook.stdout.text);
      const modelTurnId = prompt === "cross-trace" ? "foreign-model-turn" : turnId;
      state.invocation = {
        modelCall: { operation: "generate_text" },
        traceContext: { sessionId, turnId: modelTurnId },
      };
      try {
        await nativeOptions.modelAdapter.createModel({}).generateText({
          messages: [
            { role: "system", content: envelope.additionalContext },
            { role: "user", content: String(prompt) },
          ],
        });
      } finally {
        state.invocation = undefined;
      }
      return { response: "mock accepted", turnId, traceId: `trace-${turnId}`, events: [], projection: {} };
    },
    async sendInput(input, options) {
      state.sendInputOptions = { input, options, receiver: this.sessionId };
      return { kind: "started_turn", turnId: "send-input-turn", completion: sendCompletion };
    },
    async resume() {},
    async close() {},
  };
  let nativeOptions;
  const native = {
    async createZCodeApp(options) { nativeOptions = options; return nativeAppEnabled; },
    getCurrentModelInvocationContext() { return state.invocation; },
  };
  const enabled = await createXiadieZCodeApp({
    native,
    appOptions: {
      pluginStorageRoot,
      userConfigPath,
      projectConfigPath,
      workingDirectory: profileRoot,
      skipUserConfig: false,
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp },
    },
    executionPort,
    modelAdapter,
    enabled: true,
    assetsRoot,
    moduleRoot: projectRoot,
    installedPluginRoot: installRoot,
    dataRoot,
    pluginStorageRoot,
    ownedProfileRoot: profileRoot,
  });

  await assert.rejects(enabled.submitPrompt("cross-trace"), /missing, stale, cross-turn, or incomplete packet receipt/);
  assert.equal(state.nativeModelDelegates, 0, "cross-trace receipt must block before native model delegate");
  const crossFailure = enabled.readAdmissionFailures().at(-1);
  assert.equal(crossFailure.reasonCode, "model-receipt");
  assert.equal(crossFailure.turnId, "foreign-model-turn");

  await assert.rejects(enabled.submitPrompt("cross-session"), /missing, stale, cross-turn, or incomplete packet receipt/);
  assert.equal(state.nativeModelDelegates, 0, "cross-session receipt must block before native model delegate");
  const sessionFailure = enabled.readAdmissionFailures().at(-1);
  assert.equal(sessionFailure.reasonCode, "model-receipt");
  assert.equal(sessionFailure.sessionId, "foreign-model-session");

  const validTurn = await enabled.submitPrompt("fresh receipt");
  assert.equal(validTurn.response, "mock accepted");
  assert.equal(state.nativeModelDelegates, 1, "fresh matching Hook receipt reaches the native delegate");
  assert.equal(new Set(nonces).size, 3, "each admission receives a new nonce");

  await assert.rejects(enabled.compact(), /review synthetic native compact failure/);
  const afterCompact = await enabled.submitPrompt("after compact failure");
  assert.equal(afterCompact.response, "mock accepted", "compact finally must clear its ticket and exclusivity lock");

  await enabled.close?.();
  probeResults.push({
    id: "enabled-cross-turn-session-compact-cleanup",
    result: "PASS",
    nonceCount: nonces.length,
    freshNonceCount: new Set(nonces).size,
    delegateCalls: state.nativeModelDelegates,
    failures: enabled.readAdmissionFailures().map((failure) => failure.reasonCode),
  });
} finally {
  const resolvedTemp = path.resolve(probeTempRoot);
  const resolvedProfile = path.resolve(profileRoot);
  assert.ok(resolvedProfile.startsWith(resolvedTemp + path.sep), "temporary fixture must remain inside the review probe directory");
  await rm(resolvedProfile, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify({
  decision: "pass",
  authorCommit,
  baselineCommit,
  manifest: { files: manifest.files.length, sha256: expectedManifestSha256, changedPathSet: "exact" },
  standardRuns: standardEvidence,
  probeResults,
  limits: [
    "The independent cross-trace fixture uses a synthetic in-process execution port; the preserved integration run separately launches the installed Hook process.",
    "The native integration uses the fixed ZCode 29628c9 source and a loopback HTTP mock; no paid model, Desktop GUI, DSH, or product assembly was exercised.",
    "The standard boundary scan did not run because packages/core is absent.",
  ],
}, null, 2) + "\n");

