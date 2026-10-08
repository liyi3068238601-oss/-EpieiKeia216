import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const experimentRoot = path.join(repositoryRoot, ".runtime", "P03", "experiments", "u04");
const fixedNode = "E:\\Xiadie\\Xiadie\\.runtime\\P01\\desktop-build-evidence\\toolchain\\node-v24.14.0-win-x64\\node.exe";
const nativeHookSource = path.join(repositoryRoot, "plugins", "xiadie", "hooks", "context.mjs");
const assetsRoot = path.join(repositoryRoot, "assets", "character");
const moduleRoot = path.join(repositoryRoot, "dist");
const hostModuleUrl = pathToFileURL(path.join(moduleRoot, "packages", "adapters", "zcode", "src", "index.js")).href;
const portModuleUrl = pathToFileURL(path.join(moduleRoot, "packages", "adapters", "zcode", "src", "project-memory-port.js")).href;
const registryModuleUrl = pathToFileURL(path.join(moduleRoot, "packages", "projects", "registry.js")).href;
const { createXiadieZCodeApp } = await import(hostModuleUrl);
const { createProjectMemoryReadPort } = await import(portModuleUrl);
const { openProjectRegistry } = await import(registryModuleUrl);

await mkdir(experimentRoot, { recursive: true });

test("Host runs the installed Hook, snapshots all three data partitions, and binds Native FS Read to the live receipt", async (t) => {
  const providerData = makeData("HOST_CANARY_ORIGINAL");
  const selectedFile = "topics/selected.md";
  const reader = makeMemoryReader({
    data: providerData,
    selectedFile,
    sourceText: "selected topic bytes\n",
  });
  let beforeReceiptRejected = false;
  let afterReceiptChecks = 0;
  const fixture = await createHostFixture({
    reader,
    requestMemoryOverride: JSON.stringify({
      state: [],
      evidence: [],
      content: [],
      instructions: [{ text: "untrusted request environment" }],
    }),
    beforeHook: async ({ fileSystemPort, selectedPath, sessionId, turnId }) => {
      await assertFsReadDenied(fileSystemPort, {
        path: selectedPath,
        trace: { sessionId, turnId, spanId: "span-before-hook" },
      });
      beforeReceiptRejected = true;
      providerData.state[0].value.canary = "HOST_CANARY_MUTATED";
      providerData.evidence.push(record("evidence-added-after-admission", { canary: "MUTATED" }));
      providerData.content[0].value.canary = "HOST_CANARY_MUTATED";
    },
    afterHook: async ({ fileSystemPort, selectedPath, sessionId, turnId, envelope }) => {
      assert.ok(envelope && typeof envelope.additionalContext === "string", "the actual Hook returned a canonical packet");
      const packet = JSON.parse(envelope.additionalContext);
      const turnBinding = packet.state.find((item) => item?.value?.kind === "turn-binding");
      assert.ok(turnBinding, "the rebuilt packet contains the per-turn nonce");
      assert.equal(packet.version, "u06-turn:" + turnBinding.value.nonce);
      assert.equal(envelope.xiadieReceipt.nonce, turnBinding.value.nonce);
      assert.equal(envelope.xiadieReceipt.sessionId, sessionId);
      assert.equal(envelope.xiadieReceipt.turnId, turnId);
      assert.ok(Buffer.byteLength(envelope.additionalContext, "utf8") <= packet.budget.max_tokens);
      assert.equal(packet.budget.method, "utf8-byte-upper-bound");
      assert.ok(packet.state.some((item) => item?.value?.canary === "HOST_CANARY_ORIGINAL"));
      assert.equal(packet.evidence[0].value.canary, "HOST_CANARY_ORIGINAL");
      assert.equal(packet.content[0].value.canary, "HOST_CANARY_ORIGINAL");
      assert.doesNotMatch(JSON.stringify(packet.instruction), /HOST_CANARY/);
      await assertFsReadDenied(fileSystemPort, {
        path: selectedPath,
        trace: { sessionId: sessionId + "-stale", turnId, spanId: "span-stale-session" },
      });
      await assertFsReadDenied(fileSystemPort, {
        path: selectedPath,
        trace: { sessionId, turnId: turnId + "-stale", spanId: "span-stale-turn" },
      });
      const stat = await fileSystemPort.stat({
        path: selectedPath,
        trace: { sessionId, turnId, spanId: "span-current-stat" },
      });
      assert.equal(stat.kind, "file");
      assert.equal(stat.revision.hash, sha256("selected topic bytes\n"));
      assert.equal("mtimeMs" in stat.revision, false);
      const range = await fileSystemPort.readTextFileRange({
        path: selectedPath,
        offsetLine: 0,
        limitLines: 1,
        maxBytes: Buffer.byteLength("selected topic bytes\n", "utf8"),
        encoding: "utf8",
        trace: { sessionId, turnId, spanId: "span-current-range" },
      });
      assert.equal(range.content, "selected topic bytes");
      assert.equal(range.totalLines, 2, "Native range keeps the trailing empty line");
      afterReceiptChecks += 1;
    },
  }, t);

  const result = await fixture.host.submitPrompt("admit selected project memory");
  assert.equal(result.response, "FAKE_NATIVE_TURN_COMPLETE");
  assert.equal(fixture.state.hookRuns, 1, "the fixed Node executable ran the copied Hook process");
  assert.equal(fixture.state.nativeSubmitCalls.length, 1);
  assert.equal(fixture.state.modelCalls, 0, "the model remains a narrow fake and is never entered");
  assert.equal(fixture.host.readAdmissionFailures().length, 0);
  assert.equal(beforeReceiptRejected, true);
  assert.equal(afterReceiptChecks, 1);
  assert.equal(fixture.state.hookRequests[0].trustedData.state[0].value.canary, "HOST_CANARY_ORIGINAL");
  assert.equal(fixture.state.hookRequests[0].trustedData.evidence.length, 1);
  assert.equal(fixture.state.hookRequests[0].trustedData.content.length, 1);
  assert.equal(fixture.state.nativeCreateCalls, 1);
  assert.ok(fixture.state.nativeFileSystemPort !== fixture.state.fileSystemDelegate,
    "Host supplies the decorated file-system port to Native");
  assert.equal(reader.state.readCalls.length, 2, "both Native stat and range flowed through Host Read");
  await assertFsReadDenied(fixture.state.nativeFileSystemPort, {
    path: fixture.memoryPath(selectedFile),
    trace: {
      sessionId: fixture.host.app.sessionId,
      turnId: fixture.state.turns[0].turnId,
      spanId: "span-after-finally",
    },
  });
});

test("Host requires the Native file-system port and Read binding before Native initialization", async (t) => {
  const withoutBinding = await createHostFixture({
    reader: makeMemoryReader({ data: makeData("MISSING_BINDING") }),
    omitReadBinding: true,
    captureCreateError: true,
  }, t);
  assert.match(String(withoutBinding.creationError), /matching workspace, Native FS port and Read binding/);
  assert.equal(withoutBinding.state.nativeCreateCalls, 0, "Native is not created without the Host Read binding");

  const withoutFileSystemPort = await createHostFixture({
    reader: makeMemoryReader({ data: makeData("MISSING_FS_PORT") }),
    omitFileSystemPort: true,
    captureCreateError: true,
  }, t);
  assert.match(String(withoutFileSystemPort.creationError), /matching workspace, Native FS port and Read binding/);
  assert.equal(withoutFileSystemPort.state.nativeCreateCalls, 0, "Native is not created without its base FS port");
});

test("Host blocks a reader snapshot mapped to another project before Native turn admission", async (t) => {
  const reader = makeMemoryReader({ data: makeData("PROJECT_MISMATCH") });
  const fixture = await createHostFixture({ reader, preserveSnapshotProjectId: true }, t);

  await assert.rejects(fixture.host.submitPrompt("reject project mismatch"), /belongs to another project/);
  assert.equal(reader.state.captureCalls, 1);
  assert.equal(fixture.state.nativeCreateCalls, 1, "the registered Native app exists, but no turn is admitted");
  assert.equal(fixture.state.nativeSubmitCalls.length, 0);
  assert.equal(fixture.state.hookRuns, 0);
  assert.equal(fixture.state.modelCalls, 0);
  assert.equal(fixture.host.readAdmissionFailures().filter((failure) => failure.reasonCode === "host-before-turn").length, 1);
});

test("separate Hosts keep opposite project canaries in their own tickets while admissions overlap", async (t) => {
  const enteredA = deferred();
  const releaseA = deferred();
  const fixtureA = await createHostFixture({
    reader: makeMemoryReader({ data: makeData("PROJECT_A_ONLY"), selectedFile: "topics/a.md" }),
    beforeHook: async ({ prompt }) => {
      if (prompt === "host A") {
        enteredA.resolve();
        await releaseA.promise;
      }
    },
  }, t);
  const fixtureB = await createHostFixture({
    reader: makeMemoryReader({ data: makeData("PROJECT_B_ONLY"), selectedFile: "topics/b.md" }),
  }, t);

  const hostATurn = fixtureA.host.submitPrompt("host A");
  await enteredA.promise;
  const hostBTurn = await fixtureB.host.submitPrompt("host B");
  releaseA.resolve();
  const hostATurnResult = await hostATurn;

  assert.equal(hostATurnResult.response, "FAKE_NATIVE_TURN_COMPLETE");
  assert.equal(hostBTurn.response, "FAKE_NATIVE_TURN_COMPLETE");
  const packetA = JSON.parse(fixtureA.state.turns[0].envelope.additionalContext);
  const packetB = JSON.parse(fixtureB.state.turns[0].envelope.additionalContext);
  assert.ok(JSON.stringify(packetA).includes("PROJECT_A_ONLY"));
  assert.ok(!JSON.stringify(packetA).includes("PROJECT_B_ONLY"));
  assert.ok(JSON.stringify(packetB).includes("PROJECT_B_ONLY"));
  assert.ok(!JSON.stringify(packetB).includes("PROJECT_A_ONLY"));
  assert.equal(fixtureA.host.readAdmissionFailures().length, 0);
  assert.equal(fixtureB.host.readAdmissionFailures().length, 0);
});

test("unreadable and corrupt admissions block before Native, then a fresh turn recovers", async (t) => {
  const validData = makeData("RECOVERED_AFTER_CORRUPT");
  const reader = makeMemoryReader({
    snapshots: [
      makeSnapshot("unreadable", "P03_MEMORY_UNREADABLE", makeData("SHOULD_NOT_ENTER")),
      makeSnapshot("corrupt", "P03_MEMORY_CORRUPT", makeData("SHOULD_NOT_ENTER")),
      makeSnapshot("present", "P03_MEMORY_PRESENT", validData),
    ],
    selectedFile: "topics/current.md",
  });
  const fixture = await createHostFixture({ reader }, t);

  await assert.rejects(fixture.host.submitPrompt("blocked unreadable turn"), /P03_MEMORY_UNREADABLE/);
  assert.equal(reader.state.captureCalls, 1);
  assert.equal(fixture.state.nativeSubmitCalls.length, 0);
  assert.equal(fixture.state.hookRuns, 0);
  assert.equal(fixture.state.modelCalls, 0);

  await assert.rejects(fixture.host.submitPrompt("blocked corrupt turn"), /P03_MEMORY_CORRUPT/);
  assert.equal(reader.state.captureCalls, 2);
  assert.equal(fixture.state.nativeSubmitCalls.length, 0);
  assert.equal(fixture.state.hookRuns, 0);
  assert.equal(fixture.state.modelCalls, 0);
  assert.equal(fixture.host.readAdmissionFailures().filter((failure) => failure.reasonCode === "host-before-turn").length, 2);

  const recovered = await fixture.host.submitPrompt("fresh repaired turn");
  assert.equal(recovered.response, "FAKE_NATIVE_TURN_COMPLETE");
  assert.equal(reader.state.captureCalls, 3);
  assert.equal(fixture.state.nativeSubmitCalls.length, 1);
  assert.equal(fixture.state.hookRuns, 1);
  assert.equal(fixture.state.modelCalls, 0);
  assert.equal(fixture.host.readAdmissionFailures().length, 2, "the failed turns remain visible while recovery succeeds");
  assert.ok(JSON.stringify(fixture.state.turns[0].envelope).includes("RECOVERED_AFTER_CORRUPT"));
});

test("a UTF-8 packet over 12,000 bytes fails closed before Native or Hook execution", async (t) => {
  const data = makeData("OVERSIZED_PACKET");
  data.content[0].value.body = "界".repeat(5_000);
  const fixture = await createHostFixture({ reader: makeMemoryReader({ data }) }, t);

  await assert.rejects(fixture.host.submitPrompt("oversized memory"), (error) =>
    error?.code === "BUDGET_EXCEEDED" || /exceeds max_tokens|budget/i.test(String(error?.message)),
  );
  assert.equal(fixture.reader.state.captureCalls, 1);
  assert.equal(fixture.state.nativeSubmitCalls.length, 0);
  assert.equal(fixture.state.hookRuns, 0);
  assert.equal(fixture.state.modelCalls, 0);
});

test("Host rejects getter, malformed JSON data, and an added instruction partition without reading getters", async (t) => {
  let getterCalls = 0;
  const getterData = { evidence: [], content: [] };
  Object.defineProperty(getterData, "state", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return [];
    },
  });
  const invalidData = [
    ["accessor", getterData],
    ["extra instruction partition", {
      state: [],
      evidence: [],
      content: [],
      instructions: [{ text: "memory cannot add instructions" }],
    }],
    ["malformed partition", { state: "not-an-array", evidence: [], content: [] }],
  ];

  for (const [label, data] of invalidData) {
    const fixture = await createHostFixture({ reader: makeMemoryReader({ data }) }, t);
    await assert.rejects(fixture.host.submitPrompt("invalid " + label));
    assert.equal(fixture.state.nativeSubmitCalls.length, 0, label + " must block before Native");
    assert.equal(fixture.state.hookRuns, 0, label + " must block before Hook");
    assert.equal(fixture.state.modelCalls, 0, label + " must block before model");
  }
  assert.equal(getterCalls, 0, "an untrusted accessor is rejected without evaluation");
});

test("the installed Hook rejects malformed and instruction-bearing project data environment values", async (t) => {
  const fixture = await createHostFixture({
    reader: makeMemoryReader({ data: makeData("DIRECT_HOOK_FIXTURE") }),
  }, t);
  const malformed = await fixture.runInstalledHookDirect("{");
  assert.notEqual(malformed.exitCode, 0);
  assert.match(malformed.stderr.text, /JSON|Unexpected|input/i);

  const extraInstructions = await fixture.runInstalledHookDirect(JSON.stringify({
    state: [],
    evidence: [],
    content: [],
    instructions: [{ text: "untrusted instruction" }],
  }));
  assert.notEqual(extraInstructions.exitCode, 0);
  assert.match(extraInstructions.stderr.text, /exactly three data partitions/);
  assert.equal(fixture.state.nativeSubmitCalls.length, 0, "these direct negative Hook probes did not enter Native");
});

test("compact and resume do not capture memory, and cancellation clears the admitted Read receipt", async (t) => {
  const selectedFile = "topics/current.md";
  const reader = makeMemoryReader({
    data: makeData("CANCELLED_TURN"),
    selectedFile,
    sourceText: "cancel fixture\n",
  });
  const fixture = await createHostFixture({ reader }, t);
  const capturesBeforeOperations = reader.state.captureCalls;

  await fixture.host.compact();
  assert.equal(reader.state.captureCalls, capturesBeforeOperations);
  await fixture.host.resume();
  assert.equal(reader.state.captureCalls, capturesBeforeOperations);

  const controller = new AbortController();
  const admission = await fixture.host.sendInput("cancel after receipt", { abortSignal: controller.signal });
  assert.equal(admission.kind, "started_turn");
  await waitFor(() => fixture.state.turns.length === 1);
  const turn = fixture.state.turns[0];
  const current = await fixture.state.nativeFileSystemPort.stat({
    path: fixture.memoryPath(selectedFile),
    trace: { sessionId: fixture.host.app.sessionId, turnId: turn.turnId, spanId: "span-before-cancel" },
  });
  assert.equal(current.kind, "file");

  controller.abort();
  await assert.rejects(admission.completion, /cancelled/i);
  await new Promise((resolve) => setImmediate(resolve));
  await assertFsReadDenied(fixture.state.nativeFileSystemPort, {
    path: fixture.memoryPath(selectedFile),
    trace: { sessionId: fixture.host.app.sessionId, turnId: turn.turnId, spanId: "span-after-cancel" },
  });
  assert.equal(reader.state.captureCalls, capturesBeforeOperations + 1, "only the ordinary sendInput turn samples memory");
});

test("Native stat and range bridge re-read each selected memory span, preserve errors, and delegate workspace files", async (t) => {
  const projectFixture = await createRegisteredProjectFixture();
  t.after(() => projectFixture.registry.close());
  const { project, workspacePath } = projectFixture;
  const selectedPath = path.join(project.native.memoryRoot, "topics", "selected.md");
  const lfPath = path.join(project.native.memoryRoot, "topics", "lf.md");
  const workspaceFile = path.join(workspacePath, "workspace.txt");
  const otherProjectPath = path.join(project.native.storageRoot, "memories", "projects", "other-u04-0000000000000000", "memory", "topics", "other.md");
  const originalText = "zero\r\none\r\ntwo\r\n";
  const originalBytes = Buffer.from(originalText, "utf8");
  const admittedHash = sha256(originalBytes);
  const lfText = "alpha\nbeta\ngamma\n";
  const lfBytes = Buffer.from(lfText, "utf8");
  const admittedSources = new Map([
    [pathKey(selectedPath), { path: "topics/selected.md", bytes: originalBytes, hash: admittedHash }],
    [pathKey(lfPath), { path: "topics/lf.md", bytes: lfBytes, hash: sha256(lfBytes) }],
  ]);
  await mkdir(path.dirname(selectedPath), { recursive: true });
  await mkdir(path.dirname(otherProjectPath), { recursive: true });
  await writeFile(selectedPath, originalBytes);
  await writeFile(lfPath, lfBytes);
  await writeFile(otherProjectPath, "opposite project bytes\n", "utf8");
  await writeFile(workspaceFile, "workspace file\n", "utf8");

  const delegateCalls = [];
  const delegate = {
    async stat(request, options) {
      delegateCalls.push({ method: "stat", request, options });
      return { delegated: "stat", path: request.path };
    },
    async readTextFileRange(request, options) {
      delegateCalls.push({ method: "readTextFileRange", request, options });
      return { delegated: "range", path: request.path };
    },
    async otherMethod(value) {
      delegateCalls.push({ method: "otherMethod", value });
      return this === delegate ? "bound" : "wrong-this";
    },
  };
  const readCalls = [];
  const memoryRead = (filename, correlation) => {
    readCalls.push({ filename, correlation });
    const admitted = admittedSources.get(pathKey(filename));
    if (!admitted) {
      throw Object.assign(new Error("outside current Host snapshot"), { code: "READ_NOT_ADMITTED" });
    }
    const bytes = readFileSync(filename);
    if (sha256(bytes) !== admitted.hash) {
      throw Object.assign(new Error("selected source changed after admission"), { code: "P03_MEMORY_SOURCE_CHANGED" });
    }
    return {
      kind: "present",
      path: admitted.path,
      code: "P03_MEMORY_PRESENT",
      source_hash: admitted.hash,
      text: bytes.toString("utf8"),
      sizeBytes: bytes.byteLength,
      mtimeMs: 1,
    };
  };
  const port = createProjectMemoryReadPort({
    delegate,
    project,
    workspacePath,
    read: memoryRead,
    createError: makeNativeFsError,
  });
  const trace = (spanId) => ({ sessionId: "u04-native-session", turnId: "u04-native-turn", spanId });
  const firstStat = await port.stat({ path: selectedPath, trace: trace("span-stat-one") });
  const secondStat = await port.stat({ path: selectedPath, trace: trace("span-stat-two") });
  assert.equal(firstStat.kind, "file");
  assert.equal(firstStat.revision.hash, admittedHash);
  assert.notEqual(firstStat.revision.id, secondStat.revision.id, "Native sees a distinct revision for each Read span");
  assert.match(firstStat.revision.id, /turn:u04-native-turn/);
  assert.match(firstStat.revision.id, /read:span-stat-one/);
  assert.equal("mtimeMs" in firstStat.revision, false, "the revision omits mtime to avoid Native's stale read cache");
  assert.equal(readCalls.length, 2, "stat revalidates through the Host on every request");

  const ranged = await port.readTextFileRange({
    path: selectedPath,
    offsetLine: 1,
    limitLines: 2,
    maxBytes: originalBytes.byteLength,
    encoding: "utf8",
    trace: trace("span-range"),
  });
  assert.equal(ranged.content, "one\ntwo");
  assert.equal(ranged.startLine, 2);
  assert.equal(ranged.lineCount, 2);
  assert.equal(ranged.totalLines, 4);
  assert.equal(ranged.lineEndings, "CRLF");
  assert.equal(ranged.bytesRead, originalBytes.byteLength);
  assert.equal(ranged.truncated, false);
  assert.match(ranged.revision.id, /read:span-range/);
  assert.equal(readCalls.length, 3, "range revalidates independently of stat");

  await assert.rejects(port.readTextFileRange({
    path: selectedPath,
    offsetLine: 0,
    limitLines: 1,
    maxBytes: 1,
    trace: trace("span-too-small"),
  }), (error) => error.code === "too_large");

  const lfRange = await port.readTextFileRange({
    path: lfPath,
    offsetLine: 0,
    limitLines: 2,
    maxBytes: lfBytes.byteLength,
    encoding: "utf-8",
    trace: trace("span-lf-range"),
  });
  assert.equal(lfRange.content, "alpha\nbeta");
  assert.equal(lfRange.lineEndings, "LF");
  assert.equal(lfRange.startLine, 1);
  assert.equal(lfRange.lineCount, 2);
  assert.equal(lfRange.totalLines, 4);
  const crlfTrailingEmpty = await port.readTextFileRange({
    path: selectedPath,
    offsetLine: 3,
    limitLines: 1,
    maxBytes: originalBytes.byteLength,
    encoding: "utf8",
    trace: trace("span-crlf-trailing-empty"),
  });
  assert.equal(crlfTrailingEmpty.content, "");
  assert.equal(crlfTrailingEmpty.startLine, 4);
  assert.equal(crlfTrailingEmpty.lineCount, 1);
  assert.equal(crlfTrailingEmpty.totalLines, 4);
  const lfTrailingEmpty = await port.readTextFileRange({
    path: lfPath,
    offsetLine: 3,
    limitLines: 1,
    maxBytes: lfBytes.byteLength,
    encoding: "utf8",
    trace: trace("span-lf-trailing-empty"),
  });
  assert.equal(lfTrailingEmpty.content, "");
  assert.equal(lfTrailingEmpty.startLine, 4);
  assert.equal(lfTrailingEmpty.lineCount, 1);
  assert.equal(lfTrailingEmpty.totalLines, 4);

  const readsBeforeMissingTrace = readCalls.length;
  await assert.rejects(port.stat({ path: selectedPath }), (error) => error.code === "permission_denied");
  assert.equal(readCalls.length, readsBeforeMissingTrace, "missing trace is rejected before Host Read");

  await assert.rejects(port.stat({
    path: otherProjectPath,
    trace: trace("span-other-project"),
  }), (error) => {
    assert.ok(error.code === "permission_denied" || error.code === "io_error");
    if (error.code === "io_error") assert.equal(error.cause.code, "READ_NOT_ADMITTED");
    return true;
  });
  assert.equal(delegateCalls.length, 0, "memory-family paths never fall through to the broad Native delegate");

  await assert.rejects(port.readTextFileRange({
    path: selectedPath,
    offsetLine: -1,
    trace: trace("span-invalid-range"),
  }), (error) => error.code === "permission_denied");

  const workspaceStatRequest = { path: workspaceFile };
  const workspaceRangeRequest = { path: workspaceFile, offsetLine: 0, limitLines: 1 };
  assert.deepEqual(await port.stat(workspaceStatRequest), { delegated: "stat", path: workspaceFile });
  assert.deepEqual(await port.readTextFileRange(workspaceRangeRequest), { delegated: "range", path: workspaceFile });
  assert.deepEqual(delegateCalls.map((item) => item.method), ["stat", "readTextFileRange"]);
  assert.strictEqual(delegateCalls[0].request, workspaceStatRequest);
  assert.strictEqual(delegateCalls[1].request, workspaceRangeRequest);
  assert.equal(await port.otherMethod("ordinary method"), "bound");

  await writeFile(selectedPath, Buffer.from("changed after the admitted snapshot\n", "utf8"));
  await assert.rejects(port.readTextFileRange({
    path: selectedPath,
    offsetLine: 0,
    trace: trace("span-source-changed"),
  }), (error) =>
    error.code === "io_error" &&
    /P03_MEMORY_SOURCE_CHANGED/.test(error.message) &&
    error.cause.code === "P03_MEMORY_SOURCE_CHANGED",
  );
});

function makeData(canary) {
  return {
    state: [record("state", { kind: "synthetic-state", canary })],
    evidence: [record("evidence", { kind: "synthetic-evidence", canary })],
    content: [record("content", { kind: "synthetic-content", canary })],
  };
}

function record(label, value) {
  return { source_refs: ["synthetic:u04:" + label], value };
}

function makeSnapshot(kind, code, data) {
  return {
    kind,
    code,
    project_id: "u04-test-project",
    index: {
      kind: kind === "present" ? "present" : kind,
      code,
      path: "MEMORY.md",
      source_hash: null,
    },
    topics: [],
    sampled_at: new Date().toISOString(),
    data,
  };
}

function makeMemoryReader(options = {}) {
  const snapshots = options.snapshots ?? [
    makeSnapshot("present", "P03_MEMORY_PRESENT", options.data ?? makeData("DEFAULT_MEMORY")),
  ];
  const expectedPath = options.selectedFile ?? "topics/current.md";
  const sourceText = options.sourceText ?? "mock selected topic\n";
  const source = {
    kind: "present",
    path: expectedPath,
    source_hash: sha256(sourceText),
    code: "P03_MEMORY_PRESENT",
    text: sourceText,
    sizeBytes: Buffer.byteLength(sourceText, "utf8"),
    mtimeMs: 7,
  };
  const state = { captureCalls: 0, readCalls: [], selectedPath: undefined, memoryRoot: undefined };
  const reader = {
    capture() {
      const index = Math.min(state.captureCalls, snapshots.length - 1);
      state.captureCalls += 1;
      return snapshots[index];
    },
    read(snapshot, filename) {
      state.readCalls.push({ snapshot, filename });
      if (!snapshots.includes(snapshot)) {
        throw Object.assign(new Error("snapshot did not belong to this test reader"), { code: "READ_NOT_ADMITTED" });
      }
      if (typeof state.selectedPath !== "string" || pathKey(filename) !== pathKey(state.selectedPath)) {
        throw Object.assign(new Error("topic is not selected in this snapshot"), { code: "READ_NOT_ADMITTED" });
      }
      return source;
    },
  };
  return { state, reader, snapshots, selectedFile: expectedPath, source };
}

async function createHostFixture(options, t) {
  const projectFixture = await createRegisteredProjectFixture();
  const { project, workspacePath } = projectFixture;
  const root = projectFixture.root;
  const profileRoot = path.join(root, "profile");
  const pluginStorageRoot = path.join(profileRoot, "plugin-storage");
  const installRoot = path.join(pluginStorageRoot, "cache", "xiadie");
  const dataRoot = path.join(pluginStorageRoot, "data", "xiadie");
  const hooksRoot = path.join(installRoot, "hooks");
  const home = path.join(profileRoot, "home");
  const temp = path.join(profileRoot, "temp");
  const workspace = workspacePath;
  const userConfigPath = path.join(profileRoot, "user.json");
  const projectConfigPath = path.join(profileRoot, "project.json");
  let host;
  t.after(async () => {
    try { await host?.close?.(); }
    finally { projectFixture.registry.close(); }
  });
  const memoryFixture = options.reader ?? makeMemoryReader();
  const memoryReader = memoryFixture.reader ?? memoryFixture;
  const snapshots = memoryFixture.snapshots ?? [];
  if (!options.preserveSnapshotProjectId) {
    for (const snapshot of snapshots) snapshot.project_id = project.projectId;
  }
  const selectedFile = memoryFixture.selectedFile ?? "topics/current.md";
  const memoryRoot = project.native.memoryRoot;
  const selectedPath = path.join(memoryRoot, ...selectedFile.split("/"));
  if (memoryFixture.state) {
    memoryFixture.state.memoryRoot = memoryRoot;
    memoryFixture.state.selectedPath = selectedPath;
  }
  await Promise.all([
    mkdir(path.join(profileRoot, "storage"), { recursive: true }),
    mkdir(pluginStorageRoot, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(temp, { recursive: true }),
    mkdir(path.dirname(selectedPath), { recursive: true }),
  ]);
  await mkdir(hooksRoot, { recursive: true });
  await Promise.all([
    copyFile(nativeHookSource, path.join(hooksRoot, "context.mjs")),
    writeFile(userConfigPath, "{}", "utf8"),
    writeFile(projectConfigPath, "{}", "utf8"),
    writeFile(selectedPath, memoryFixture.source?.text ?? "mock selected topic\n", "utf8"),
  ]);
  const environment = allowlistedEnvironment(home, temp);
  const sessionId = "u04-session-" + randomUUID();
  const fileSystemCalls = [];
  const fileSystemDelegate = {
    async stat(request, callOptions) {
      fileSystemCalls.push({ method: "stat", request, callOptions });
      return { delegated: "stat", path: request.path };
    },
    async readTextFileRange(request, callOptions) {
      fileSystemCalls.push({ method: "readTextFileRange", request, callOptions });
      return { delegated: "range", path: request.path };
    },
  };
  const state = {
    hookRuns: 0,
    hookRequests: [],
    turns: [],
    nativeSubmitCalls: [],
    nativeSendInputCalls: 0,
    nativeCreateCalls: 0,
    resumeCalls: 0,
    modelCalls: 0,
    fileSystemDelegate,
    fileSystemCalls,
    nativeFileSystemPort: undefined,
  };
  let nativeOptions;
  const modelAdapter = {
    createModel() {
      state.modelCalls += 1;
      return {
        providerId: "u04-fake",
        modelId: "u04-fake-model",
        properties: {},
        optionSpecs: {},
        options: {},
        bind(bindOptions) { return { ...this, options: bindOptions ?? {} }; },
        async generateText() { state.modelCalls += 1; return {}; },
        async *streamText() { state.modelCalls += 1; yield {}; },
      };
    },
    addStatusSink() {},
    setModelIoFullRetentionEnabled() {},
  };
  const native = {
    async createZCodeApp(receivedOptions) {
      state.nativeCreateCalls += 1;
      nativeOptions = receivedOptions;
      state.nativeFileSystemPort = receivedOptions.fileSystemPort;
      const runTurn = async (prompt, turnId, nativeSendOptions) => {
        const transcriptPath = path.join(temp, "transcript-" + turnId + ".jsonl");
        await writeFile(transcriptPath, "{\"type\":\"synthetic-user-turn\"}\n", "utf8");
        const binding = {
          host,
          sessionId,
          turnId,
          prompt,
          fileSystemPort: state.nativeFileSystemPort,
          selectedPath,
        };
        await options.beforeHook?.(binding);
        const request = {
          command: { mode: "argv", file: "node.exe", args: [path.join(hooksRoot, "context.mjs")] },
          cwd: workspace,
          stdin: JSON.stringify({
            hookEventName: "UserPromptSubmit",
            sessionId,
            turnId,
            transcriptPath,
            prompt: String(prompt),
          }),
          env: {
            base: "empty",
            set: {
              HOME: home,
              USERPROFILE: home,
              TEMP: temp,
              TMP: temp,
              XIA_DIE_PROJECT_MEMORY_DATA: options.requestMemoryOverride ?? "{\"state\":[],\"evidence\":[],\"content\":[]}",
            },
          },
          trace: { sessionId, turnId, attributes: { hookEventName: "UserPromptSubmit" } },
        };
        const result = await nativeOptions.executionPort.run(request, {
          signal: nativeSendOptions?.abortSignal,
        });
        let envelope;
        try { envelope = JSON.parse(result.stdout.text); } catch {}
        const turn = { prompt, turnId, result, envelope };
        state.turns.push(turn);
        await options.afterHook?.({ ...binding, result, envelope });
        return {
          response: "FAKE_NATIVE_TURN_COMPLETE",
          turnId,
          traceId: "fake-trace-" + turnId,
          events: [],
          projection: {},
        };
      };
      return {
        sessionId,
        runtime: { subscribeEvents() { return () => {}; } },
        async submitPrompt(prompt) {
          state.nativeSubmitCalls.push(prompt);
          if (prompt === "/compact") {
            return {
              response: "FAKE_NATIVE_COMPACT",
              turnId: "compact-" + randomUUID(),
              traceId: "fake-compact-trace",
              events: [],
              projection: {},
            };
          }
          const turnId = "turn-" + randomUUID();
          return runTurn(prompt, turnId);
        },
        async sendInput(prompt, sendOptions) {
          state.nativeSendInputCalls += 1;
          const turnId = "sendinput-" + randomUUID();
          const completion = (async () => {
            const result = await runTurn(prompt, turnId, sendOptions);
            if (!sendOptions?.abortSignal) return result;
            await new Promise((resolve, reject) => {
              const signal = sendOptions.abortSignal;
              const cancel = () => reject(new Error("fake native sendInput cancelled"));
              if (signal.aborted) cancel();
              else signal.addEventListener("abort", cancel, { once: true });
            });
            return result;
          })();
          return { kind: "started_turn", turnId, completion };
        },
        async resume() {
          state.resumeCalls += 1;
          return { resumed: true };
        },
        async close() {},
      };
    },
    getCurrentModelInvocationContext() { return undefined; },
  };
  const executionPort = {
    async run(request, runOptions) {
      state.hookRuns += 1;
      const serializedData = request.env?.set?.XIA_DIE_PROJECT_MEMORY_DATA;
      let trustedData;
      try { trustedData = JSON.parse(serializedData); } catch {}
      state.hookRequests.push({ request, trustedData });
      return runChild(request, environment, runOptions);
    },
  };
  let creationError;
  try {
    host = await createXiadieZCodeApp({
      native,
      appOptions: {
        pluginStorageRoot,
        userConfigPath,
        projectConfigPath,
        workingDirectory: workspace,
        skipUserConfig: false,
        env: environment,
        ...(options.omitFileSystemPort ? {} : { fileSystemPort: fileSystemDelegate }),
      },
      executionPort,
      modelAdapter,
      enabled: true,
      assetsRoot,
      moduleRoot,
      installedPluginRoot: installRoot,
      dataRoot,
      pluginStorageRoot,
      ownedProfileRoot: profileRoot,
      nodeExecutable: fixedNode,
      projectMemory: memoryReader,
      ...(options.omitReadBinding ? {} : {
        projectMemoryReadPort: { project, workspacePath, createError: makeNativeFsError },
      }),
    });
  } catch (error) {
    if (!options.captureCreateError) throw error;
    creationError = error;
  }
  return {
    root,
    profileRoot,
    host,
    reader: memoryFixture,
    state,
    creationError,
    selectedPath,
    memoryPath(relative) { return path.join(memoryRoot, ...relative.split("/")); },
    runInstalledHookDirect: async (projectMemoryData) => {
      const transcriptPath = path.join(temp, "direct-hook-" + randomUUID() + ".jsonl");
      const turnId = "direct-hook-turn-" + randomUUID();
      await writeFile(transcriptPath, "{}\n", "utf8");
      return runChild({
        command: { mode: "argv", file: fixedNode, args: [path.join(hooksRoot, "context.mjs")] },
        cwd: workspace,
        stdin: JSON.stringify({
          hookEventName: "UserPromptSubmit",
          sessionId,
          turnId,
          transcriptPath,
          prompt: "direct negative Hook probe",
        }),
        env: {
          base: "empty",
          set: {
            HOME: home,
            USERPROFILE: home,
            TEMP: temp,
            TMP: temp,
            XIA_DIE_HOOK_EVENT: "UserPromptSubmit",
            XIA_DIE_APPROVED_ASSET_ROOT: assetsRoot,
            XIA_DIE_HOST_MODULE_ROOT: moduleRoot,
            XIA_DIE_TICKET_NONCE: "direct-hook-synthetic-nonce",
            XIA_DIE_PROJECT_MEMORY_DATA: projectMemoryData,
          },
        },
      }, environment);
    },
  };
}

async function runChild(request, safeEnvironment, runOptions = {}) {
  const environment = {
    ...safeEnvironment,
    ...(request.env?.set ?? {}),
  };
  for (const name of request.env?.unset ?? []) delete environment[name];
  const child = spawn(request.command.file, [...(request.command.args ?? [])], {
    cwd: request.cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.stdin.end(request.stdin ?? "");
  let cancelled = false;
  const signal = runOptions.signal;
  const onAbort = () => {
    cancelled = true;
    child.kill();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signalName) => resolve({ code, signalName }));
  });
  signal?.removeEventListener("abort", onAbort);
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  return {
    status: exit.error ? "spawn_error" : cancelled ? "cancelled" : exit.code === 0 ? "completed" : "failed",
    ...(exit.code === null || exit.code === undefined ? {} : { exitCode: exit.code }),
    ...(exit.signalName ? { signal: exit.signalName } : {}),
    stdout: { text: stdout.toString("utf8"), bytes: stdout.byteLength, truncated: false },
    stderr: { text: stderr.toString("utf8"), bytes: stderr.byteLength, truncated: false },
    durationMs: 0,
    timedOut: false,
    cancelled,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

function allowlistedEnvironment(home, temp) {
  const environment = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (typeof process.env[name] === "string") environment[name] = process.env[name];
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
  });
  return environment;
}

async function createFixtureRoot() {
  const root = path.join(experimentRoot, "host-" + randomUUID());
  await mkdir(root, { recursive: false });
  return root;
}

async function assertFsReadDenied(fileSystemPort, request) {
  await assert.rejects(fileSystemPort.stat(request), (error) => {
    if (error?.code === "permission_denied") return true;
    if (error?.code === "io_error") {
      assert.equal(error.cause?.code, "READ_NOT_ADMITTED");
      return true;
    }
    return false;
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Host/Hook fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createRegisteredProjectFixture() {
  const root = await createFixtureRoot();
  const workspacePath = path.join(root, "workspace", "project-a");
  const ownedDirectory = path.join(root, "registry");
  const nativeStorageRoot = path.join(root, "native-cli");
  const noHooks = path.join(root, "empty-hooks");
  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  await Promise.all([
    mkdir(path.dirname(workspacePath), { recursive: true }),
    mkdir(ownedDirectory, { recursive: true }),
    mkdir(nativeStorageRoot, { recursive: true }),
    mkdir(noHooks, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);
  runGit(root, noHooks, root, ["init", "--initial-branch=main", workspacePath], home, temp);
  await writeFile(path.join(workspacePath, "README.md"), "synthetic registered project\n", "utf8");
  runGit(root, noHooks, workspacePath, ["add", "README.md"], home, temp);
  runGit(root, noHooks, workspacePath, ["commit", "-m", "synthetic U04 Host test"], home, temp);

  const digest = sha256(workspacePath.toLowerCase()).slice(0, 16);
  const registry = openProjectRegistry({
    ownedDirectory,
    nativeStorageRoot,
    nativeMemoryRootResolver: ({ cliStorageRoot, workspacePath: mappedWorkspace, workspaceIdentity }) => {
      const key = workspaceIdentity
        ? "u04-" + sha256(workspaceIdentity).slice(0, 16)
        : "legacy-" + sha256(mappedWorkspace.toLowerCase()).slice(0, 16);
      return path.join(cliStorageRoot, "memories", "projects", key, "memory");
    },
    nativeRuntimeKeyResolver: () => "project-" + digest,
  });
  const mapping = registry.registerWorkspace({ workspacePath });
  return { root, registry, project: mapping, workspacePath };
}

function runGit(root, noHooks, cwd, args, home, temp) {
  const environment = allowlistedEnvironment(home, temp);
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "disabled-global-git-config"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=" + noHooks,
    "-c", "user.name=P03 U04 Synthetic Author",
    "-c", "user.email=p03-u04@example.invalid",
    "-c", "commit.gpgSign=false",
    "-C", cwd,
    ...args,
  ], {
    cwd: root,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Synthetic Git failed (" + args.join(" ") + "): " +
      (result.error?.message ?? result.stderr?.trim() ?? "exit " + result.status));
  }
}

function makeNativeFsError(input) {
  return Object.assign(new Error(input.message), {
    code: input.code,
    path: input.path,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function pathKey(value) {
  const absolute = path.resolve(value);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
