import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const experimentParent = path.join(repositoryRoot, ".runtime", "P02", "experiments", "u06");
const { openEventStore } = await import(new URL("../../../../dist/packages/storage/events/src/index.js", import.meta.url).href);
const { normalizeRuntimeEvent } = await import(new URL("../../../../dist/packages/contracts/src/events.js", import.meta.url).href);
const {
  OWNED_ARTIFACT_INTEGRITY_PROFILE,
  buildEvidenceReport,
  createLocalEvidenceReader,
  runOwnedNode,
} = await import(new URL("../../../../dist/packages/application/evidence/src/index.js", import.meta.url).href);

const EXPECTED_SOURCE = "zcode-native-u06-test";
const ARTIFACT_CONTENT = "artifact-v1";
const ATTEMPT_ID = "attempt-u06";
const OPERATION_ID = "operation-u06";
const TOOL_CALL_ID = "tool-call-u06";
let eventNumber = 0;

test("real Node run, SQLite operation receipt, owned artifact and exact Git revision pass without log injection", async (t) => {
  const fixture = await makeFixture(t, "positive");
  const run = await fixture.run("write-canary");
  await appendReceipt(fixture, run);

  const report = await fixture.report(run);
  assert.equal(report.execution.status, "passed");
  assert.equal(report.toolReceipt.status, "verified");
  assert.equal(report.artifact.status, "verified");
  assert.equal(report.sourceRevision.status, "verified");
  assert.equal(report.sourceRevision.expectedCommit, fixture.commit);
  assert.equal(report.sourceRevision.commitAtLaunch, fixture.commit);
  assert.equal(report.sourceRevision.currentCommit, fixture.commit);
  assert.deepEqual(report.scope, fixture.scope(run));
  assert.equal(report.profile, OWNED_ARTIFACT_INTEGRITY_PROFILE);
  assert.deepEqual(report.profileResult, { status: "passed", reasons: [] });
  assert.equal(JSON.stringify(report).includes("DONE_CANARY"), false);
  assert.equal(JSON.stringify(report).includes("PRIVATE_REASONING_CANARY"), false);
  assert.equal(JSON.stringify(report).includes(fixture.scriptPath), false);
  assert.deepEqual(Object.keys(report.execution.stdout).sort(), ["bytes", "sha256"]);
  assert.deepEqual(report.execution.command, run.command);
  assert.equal(run.command.kind, "node-script");
  assert.equal(run.command.argumentCount, 2);
  assert.equal(run.command.scriptSha256, createHash("sha256").update(await readFile(fixture.scriptPath)).digest("hex"));
  fixture.success();
});

test("command metadata snapshots actual arguments and mismatched committed command is rejected", async (t) => {
  const fixture = await makeFixture(t, "command-identity");
  const args = [fixture.artifactPath, "write-canary"];
  const pending = runOwnedNode({ repositoryRoot: fixture.sourceRoot, expectedSourceCommit: fixture.commit, script: "writer.mjs", args });
  args.push("COMMAND_SECRET_CANARY");
  const run = await pending;
  assert.equal(run.command.argumentCount, 2);
  assert.equal(JSON.stringify(run).includes("COMMAND_SECRET_CANARY"), false);
  await appendReceipt(fixture, run, { command: { ...run.command, argumentCount: 3 } });
  const report = await fixture.report(run);
  assert.equal(report.toolReceipt.status, "invalid");
  assert.notEqual(report.profileResult.status, "passed");
  fixture.success();
});

test("DONE prose, unowned idle state and caller-supplied pass claims cannot satisfy the profile", async (t) => {
  const fixture = await makeFixture(t, "false-success");
  const idle = await fixture.report({ status: "idle", exitCode: 0 }, {
    scope: { sessionId: "session-u06", turnId: "turn-u06", runId: "idle-run", taskId: "task-u06" },
  });
  assert.notEqual(idle.profileResult.status, "passed");
  assert.equal(idle.execution.status, "unverified");
  assert.ok(idle.profileResult.reasons.includes("RUN_NOT_OWNED"));

  const run = await fixture.run("done");
  const report = await fixture.report(run);
  assert.equal(report.execution.status, "passed");
  assert.equal(report.artifact.status, "missing");
  assert.equal(report.toolReceipt.status, "missing");
  assert.notEqual(report.profileResult.status, "passed");
  assert.equal(JSON.stringify(report).includes("DONE_CANARY"), false);
  await assert.rejects(
    buildEvidenceReport({ ...fixture.input(run), checks: { status: "pass" } }, fixture.reader),
    /unexpected or missing fields/,
  );
  fixture.success();
});

test("queued admission is not evidence until SQLite readback has committed the operation receipt", async (t) => {
  const fixture = await makeFixture(t, "queued");
  const run = await fixture.run("write");
  const input = receiptInput(fixture, run);
  const blocker = new DatabaseSync(fixture.databasePath);
  blocker.exec("BEGIN IMMEDIATE");
  const admission = fixture.store.append(input);
  assert.equal(admission.status, "queued");
  try {
    assert.equal(fixture.store.queryReceipt({ source: EXPECTED_SOURCE, eventId: input.event.eventId }).status, "not_found");
    const reportBeforeCommit = await fixture.report(run);
    assert.notEqual(reportBeforeCommit.profileResult.status, "passed");
    assert.equal(reportBeforeCommit.toolReceipt.status, "missing");
    const blockedCompletion = await admission.completion;
    assert.equal(blockedCompletion.status, "failed");
    assert.equal(blockedCompletion.code, "BUSY");
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  const retry = fixture.store.append(input);
  assert.equal(retry.status, "queued");
  const completion = await retry.completion;
  assert.equal(completion.status, "committed");
  const committedReceipt = fixture.store.queryReceipt({ source: EXPECTED_SOURCE, eventId: input.event.eventId });
  assert.equal(committedReceipt.status, "found");
  assert.equal(committedReceipt.firstReceipt.commitSequence, completion.firstCommitSequence);
  const reportAfterCommit = await fixture.report(run);
  assert.equal(reportAfterCommit.profileResult.status, "passed");
  fixture.success();
});

test("exit zero with a real artifact but no committed tool receipt is execution-only success", async (t) => {
  const fixture = await makeFixture(t, "exit-only");
  const run = await fixture.run("write");
  const report = await fixture.report(run);
  assert.equal(report.execution.status, "passed");
  assert.equal(report.artifact.status, "verified");
  assert.equal(report.toolReceipt.status, "missing");
  assert.notEqual(report.profileResult.status, "passed");
  fixture.success();
});

test("missing artifact and changed artifact bytes reject a receipt's claimed integrity", async (t) => {
  const missingFixture = await makeFixture(t, "missing-artifact");
  const missingRun = await missingFixture.run("done");
  await appendReceipt(missingFixture, missingRun, { claimExpectedArtifact: true });
  const missingReport = await missingFixture.report(missingRun);
  assert.equal(missingReport.artifact.status, "missing");
  assert.notEqual(missingReport.profileResult.status, "passed");
  missingFixture.success();

  const changedFixture = await makeFixture(t, "changed-artifact");
  const changedRun = await changedFixture.run("write");
  await appendReceipt(changedFixture, changedRun);
  await writeFile(changedFixture.artifactPath, "replacement-content", "utf8");
  const changedReport = await changedFixture.report(changedRun);
  assert.equal(changedReport.artifact.status, "verified");
  assert.equal(changedReport.toolReceipt.status, "invalid");
  assert.notEqual(changedReport.profileResult.status, "passed");
  changedFixture.success();

  const oversizedFixture = await makeFixture(t, "oversized-artifact");
  const oversizedRun = await oversizedFixture.run("write");
  await appendReceipt(oversizedFixture, oversizedRun);
  await writeFile(oversizedFixture.artifactPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  const oversizedReport = await oversizedFixture.report(oversizedRun);
  assert.equal(oversizedReport.artifact.status, "unreadable");
  assert.notEqual(oversizedReport.profileResult.status, "passed");
  oversizedFixture.success();
});

test("tool receipt must match exact scope, attempt, tool call and coordinator-fixed source", async (t) => {
  const variants = [
    { name: "wrong-session", eventScope: { sessionId: "other-session" } },
    { name: "wrong-turn", eventScope: { turnId: "other-turn" } },
    { name: "wrong-run", eventScope: { runId: "other-run" } },
    { name: "wrong-task", eventScope: { taskId: "other-task" } },
    { name: "wrong-attempt", eventAttemptId: "other-attempt" },
    { name: "wrong-tool", eventToolCallId: "other-tool-call" },
    { name: "wrong-payload-operation", eventPayloadOperationId: "other-operation" },
    { name: "wrong-event-operation", eventOperationId: "other-operation", expectedStatus: "missing" },
    { name: "wrong-source", eventSource: "untrusted-source" },
  ];
  for (const variant of variants) {
    const fixture = await makeFixture(t, variant.name);
    const run = await fixture.run("write");
    await appendReceipt(fixture, run, variant);
    const report = await fixture.report(run);
    assert.equal(report.toolReceipt.status, variant.expectedStatus ?? "invalid", variant.name);
    assert.notEqual(report.profileResult.status, "passed", variant.name);
    fixture.success();
  }
});

test("frozen expected commit, current clean revision and originating repository all have to match", async (t) => {
  const wrongExpected = await makeFixture(t, "wrong-expected-commit");
  const wrongRun = await wrongExpected.run("write", { expectedSourceCommit: "0".repeat(40) });
  await appendReceipt(wrongExpected, wrongRun);
  const wrongExpectedReport = await wrongExpected.report(wrongRun);
  assert.ok(wrongExpectedReport.profileResult.reasons.includes("SOURCE_EXPECTATION_MISMATCH"));
  assert.notEqual(wrongExpectedReport.profileResult.status, "passed");
  wrongExpected.success();

  const movedHead = await makeFixture(t, "moved-head");
  const movedRun = await movedHead.run("write");
  await appendReceipt(movedHead, movedRun);
  git(movedHead.sourceRoot, ["commit", "--allow-empty", "-m", "move source after run"]);
  const movedReport = await movedHead.report(movedRun);
  assert.equal(movedReport.sourceRevision.status, "mismatch");
  assert.notEqual(movedReport.profileResult.status, "passed");
  movedHead.success();

  const dirtyTree = await makeFixture(t, "dirty-tree");
  const dirtyRun = await dirtyTree.run("write");
  await appendReceipt(dirtyTree, dirtyRun);
  await writeFile(dirtyTree.scriptPath, (await readFile(dirtyTree.scriptPath, "utf8")) + "\n// changed after run\n");
  const dirtyReport = await dirtyTree.report(dirtyRun);
  assert.equal(dirtyReport.sourceRevision.cleanNow, false);
  assert.notEqual(dirtyReport.profileResult.status, "passed");
  dirtyTree.success();

  const otherRepo = await makeFixture(t, "other-repository");
  const sourceRun = await otherRepo.run("write");
  await appendReceipt(otherRepo, sourceRun);
  const cloneRoot = path.join(otherRepo.directory, "source-clone");
  git(otherRepo.sourceRoot, ["clone", "--quiet", "--local", otherRepo.sourceRoot, cloneRoot]);
  const cloneReader = await createLocalEvidenceReader({
    repositoryRoot: cloneRoot,
    artifactRoot: otherRepo.artifactRoot,
    expectedReceiptSource: EXPECTED_SOURCE,
    eventStore: otherRepo.store,
  });
  const otherRepoReport = await buildEvidenceReport(otherRepo.input(sourceRun), cloneReader);
  assert.ok(otherRepoReport.profileResult.reasons.includes("REPOSITORY_MISMATCH"));
  assert.notEqual(otherRepoReport.profileResult.status, "passed");
  otherRepo.success();
});

test("Node scripts must be tracked, nonignored and byte-identical to the HEAD blob", async (t) => {
  const fixture = await makeFixture(t, "script-provenance");
  await writeFile(path.join(fixture.sourceRoot, ".gitignore"), "ignored.mjs\n", "utf8");
  git(fixture.sourceRoot, ["add", ".gitignore"]);
  git(fixture.sourceRoot, ["commit", "--quiet", "-m", "ignore untracked script"]);
  const expected = git(fixture.sourceRoot, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(fixture.sourceRoot, "ignored.mjs"), "process.exitCode = 0;\n");
  await writeFile(path.join(fixture.sourceRoot, "untracked.mjs"), "process.exitCode = 0;\n");
  await assert.rejects(runOwnedNode({
    repositoryRoot: fixture.sourceRoot,
    expectedSourceCommit: expected,
    script: "ignored.mjs",
  }));
  await assert.rejects(runOwnedNode({
    repositoryRoot: fixture.sourceRoot,
    expectedSourceCommit: expected,
    script: "untracked.mjs",
  }));
  git(fixture.sourceRoot, ["update-index", "--assume-unchanged", "writer.mjs"]);
  await writeFile(fixture.scriptPath, (await readFile(fixture.scriptPath, "utf8")) + "\n// hidden worktree edit\n");
  await assert.rejects(runOwnedNode({
    repositoryRoot: fixture.sourceRoot,
    expectedSourceCommit: expected,
    script: "writer.mjs",
  }), /working script bytes do not match the HEAD blob/);
  fixture.success();
});

async function makeFixture(t, name) {
  await mkdir(experimentParent, { recursive: true });
  const physicalParent = await realpath(experimentParent);
  const directory = await mkdtemp(path.join(physicalParent, name + "-"));
  const sourceRoot = path.join(directory, "source");
  const artifactRoot = path.join(directory, "artifacts");
  const databasePath = path.join(directory, "events.sqlite");
  await mkdir(sourceRoot);
  await mkdir(artifactRoot);
  const scriptPath = path.join(sourceRoot, "writer.mjs");
  await writeFile(scriptPath, [
    'import { writeFile } from "node:fs/promises";',
    'const [output, mode] = process.argv.slice(2);',
    'if (mode === "write" || mode === "write-canary") await writeFile(output, "artifact-v1", "utf8");',
    'if (mode === "done" || mode === "write-canary") process.stdout.write("DONE_CANARY PRIVATE_REASONING_CANARY");',
    'if (mode === "write-canary") process.stderr.write("PRIVATE_REASONING_CANARY");',
    'if (mode === "fail") process.exitCode = 9;',
    "",
  ].join("\n"), "utf8");
  git(sourceRoot, ["init", "--quiet"]);
  git(sourceRoot, ["config", "user.name", "P02 U06 fixture"]);
  git(sourceRoot, ["config", "user.email", "p02-u06-fixture@example.invalid"]);
  git(sourceRoot, ["add", "writer.mjs"]);
  git(sourceRoot, ["commit", "--quiet", "-m", "fixture source"]);
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
  const store = openEventStore({ path: databasePath });
  let successful = false;
  t.after(async () => {
    await store.close().catch(() => {});
    if (successful) await removeOwnedFixture(directory);
    else console.error("P02-U06 failed fixture preserved at " + directory);
  });

  const reader = await createLocalEvidenceReader({
    repositoryRoot: sourceRoot,
    artifactRoot,
    expectedReceiptSource: EXPECTED_SOURCE,
    eventStore: store,
  });
  const artifactPath = path.join(artifactRoot, "result.txt");
  return {
    directory,
    sourceRoot,
    artifactRoot,
    artifactPath,
    databasePath,
    scriptPath,
    commit,
    store,
    reader,
    async run(mode, overrides = {}) {
      return runOwnedNode({
        repositoryRoot: sourceRoot,
        expectedSourceCommit: overrides.expectedSourceCommit ?? commit,
        script: "writer.mjs",
        args: [artifactPath, mode],
      });
    },
    scope(run, overrides = {}) {
      return {
        sessionId: overrides.sessionId ?? "session-u06",
        turnId: overrides.turnId ?? "turn-u06",
        runId: overrides.runId ?? (typeof run?.runId === "string" ? run.runId : "unowned-run"),
        taskId: overrides.taskId ?? "task-u06",
      };
    },
    input(run, inputOverrides = {}) {
      return {
        run,
        scope: inputOverrides.scope ?? this.scope(run),
        attemptId: inputOverrides.attemptId ?? ATTEMPT_ID,
        operationId: inputOverrides.operationId ?? OPERATION_ID,
        toolCallId: inputOverrides.toolCallId ?? TOOL_CALL_ID,
        artifactLocator: "result.txt",
      };
    },
    report(run, inputOverrides = {}) {
      return buildEvidenceReport(this.input(run, inputOverrides), reader);
    },
    success() { successful = true; },
  };
}

function receiptInput(fixture, run, overrides = {}) {
  const scope = fixture.scope(run, overrides.eventScope);
  const payloadToolCallId = overrides.eventToolCallId ?? TOOL_CALL_ID;
  return normalizeAppend({
    source: overrides.eventSource ?? EXPECTED_SOURCE,
    scope,
    attemptId: overrides.eventAttemptId ?? ATTEMPT_ID,
    operationId: overrides.eventOperationId ?? OPERATION_ID,
    payload: {
      operationId: overrides.eventPayloadOperationId ?? OPERATION_ID,
      status: "success",
      observedAt: new Date().toISOString(),
      result: {
        profile: OWNED_ARTIFACT_INTEGRITY_PROFILE,
        runId: run.runId,
        processId: run.processId,
        toolCallId: payloadToolCallId,
        sourceCommitAtLaunch: run.sourceCommitAtLaunch,
        command: overrides.command ?? run.command,
        artifact: artifactClaim(),
      },
    },
  });
}

async function appendReceipt(fixture, run, overrides = {}) {
  const input = receiptInput(fixture, run, overrides);
  const admission = fixture.store.append(input);
  assert.equal(admission.status, "queued");
  const result = await admission.completion;
  assert.ok(["committed", "duplicate"].includes(result.status));
  return { input, result };
}

function normalizeAppend({ source, scope, attemptId, operationId, payload }) {
  const event = normalizeRuntimeEvent({
    source,
    eventId: "u06-receipt-" + (++eventNumber) + "-" + randomUUID(),
    scope,
    attemptId,
    operationId,
    kind: "operation_receipt",
    occurredAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    sourceSequence: null,
    payload,
  });
  return {
    event,
    origin: {
      sourcePin: "u06-native-fixture",
      historicalLocator: "fixture://u06/operation-receipt",
      rawSha256: hash(Buffer.from("receipt-envelope", "utf8")),
      rawBytes: 17,
      extent: "one-operation-receipt",
      rawRetained: false,
    },
  };
}

function artifactClaim() {
  const bytes = Buffer.from(ARTIFACT_CONTENT, "utf8");
  return { locator: "result.txt", bytes: bytes.byteLength, sha256: hash(bytes) };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.error, undefined, "git fixture command should start");
  assert.equal(result.status, 0, "git fixture command should succeed: " + args[0]);
  return result.stdout;
}

async function removeOwnedFixture(target) {
  const physicalParent = await realpath(experimentParent);
  const targetPath = path.resolve(target);
  const physicalTarget = await realpath(targetPath);
  const relative = path.relative(physicalParent, physicalTarget);
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative),
    "cleanup must remain inside the U06 experiment root");
  await rm(physicalTarget, { recursive: true, force: true });
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
