import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const experimentParent = path.resolve(repositoryRoot, ".runtime", "P02", "experiments", "u07", "recovery");
await mkdir(experimentParent, { recursive: true });
const { openEventStore } = await import(new URL("../../../../dist/packages/storage/events/src/index.js", import.meta.url).href);
const { inspectOperation, executeOperationOnce, recordVerifiedReceipt, recoverAttempt } =
  await import(new URL("../../../../dist/packages/application/recovery/src/index.js", import.meta.url).href);

test("same operation concurrent/repeated calls dispatch once and freeze the committed descriptor", async (t) => {
  const fixture = await makeFixture(t, "concurrent");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const execution = makeExecution("op-concurrent");
  let calls = 0;
  const perform = (intent) => {
    calls += 1;
    assert.ok(Object.isFrozen(intent));
    assert.ok(Object.isFrozen(intent.input));
    return { status: "success", result: { value: "written" } };
  };

  const [left, right] = await Promise.all([
    executeOperationOnce(store, execution, perform),
    executeOperationOnce(store, execution, perform),
  ]);
  assert.equal(calls, 1);
  assert.equal([left, right].filter((item) => item.dispatched).length, 1);
  assert.deepEqual([left.status, right.status].sort(), ["known_success", "unknown"]);
  const retry = await executeOperationOnce(store, execution, () => {
    calls += 1;
    return { status: "success", result: null };
  });
  assert.equal(retry.status, "known_success");
  assert.equal(retry.dispatched, false);
  assert.equal(calls, 1);
  assert.equal(retry.autoReplay, false);
});

test("changed descriptor and foreign owner are conflicts and never dispatch", async (t) => {
  const fixture = await makeFixture(t, "conflict");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const original = makeExecution("op-conflict");
  const first = await executeOperationOnce(store, original, () => ({ status: "success", result: { id: 1 } }));
  assert.equal(first.status, "known_success");

  let calls = 0;
  const changed = makeExecution("op-conflict", { input: { target: "different-effect" } });
  const changedResult = await executeOperationOnce(store, changed, () => {
    calls += 1;
    return { status: "success", result: null };
  });
  assert.equal(changedResult.status, "conflict");
  assert.equal(changedResult.dispatched, false);

  const foreign = makeExecution("op-conflict", { sessionId: "foreign-session" });
  const foreignResult = await executeOperationOnce(store, foreign, () => {
    calls += 1;
    return { status: "success", result: null };
  });
  assert.equal(foreignResult.status, "conflict");
  assert.equal(foreignResult.dispatched, false);
  assert.equal(inspectOperation(store, {
    owner: { sessionId: "foreign-session", taskId: "task-u07" },
    operationId: "op-conflict",
  }).status, "conflict");
  assert.equal(calls, 0);
});

test("same source/event identity cannot be relabelled to another operation or owner", async (t) => {
  const fixture = await makeFixture(t, "identity-relabel");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const identity = { source: "native/test-source", eventId: "native-event-identity-1" };
  const originalScope = makeScope({ sessionId: "identity-owner", taskId: "identity-task" });
  const originalOperation = "op-original-identity";
  const basePayload = { operationId: originalOperation, occurredAt: timestamp(10), operation: "synthetic.write", input: { value: 1 } };
  const original = makeEvent({
    ...identity, suffix: "identity-original", kind: "operation_intent", scope: originalScope,
    attemptId: null, operationId: originalOperation, payload: basePayload,
  });
  assert.equal((await appendEvent(store, original)).status, "committed");
  const originalReceipt = makeEvent({
    suffix: "identity-original-receipt", source: "native/test-receipts", kind: "operation_receipt",
    scope: originalScope, attemptId: "attempt-original-receipt", operationId: originalOperation,
    payload: { operationId: originalOperation, status: "success", observedAt: timestamp(12), result: { externalId: "first-receipt" } },
  });
  assert.equal((await appendEvent(store, originalReceipt)).status, "committed");

  const relabelledOperation = "op-relabelled-identity";
  const operationCandidate = makeEvent({
    ...identity, suffix: "identity-operation-conflict", kind: "operation_intent", scope: originalScope,
    attemptId: null, operationId: relabelledOperation,
    payload: { ...basePayload, operationId: relabelledOperation },
  });
  assert.equal((await appendEvent(store, operationCandidate)).status, "conflict");

  const ownerCandidateScope = { ...originalScope, sessionId: "changed-identity-owner" };
  const ownerCandidate = makeEvent({
    ...identity, suffix: "identity-owner-conflict", kind: "operation_intent", scope: ownerCandidateScope,
    attemptId: null, operationId: originalOperation, payload: basePayload,
  });
  assert.equal((await appendEvent(store, ownerCandidate)).status, "conflict");

  const newOperationDecision = inspectOperation(store, {
    owner: ownerOf(originalScope), operationId: relabelledOperation,
  });
  assert.equal(newOperationDecision.status, "conflict", "candidate's changed operation ID must be found from full observation history");
  assert.equal(newOperationDecision.autoReplay, false);
  const firstOperationDecision = inspectOperation(store, {
    owner: ownerOf(originalScope), operationId: originalOperation,
  });
  assert.equal(firstOperationDecision.status, "conflict", "the first fact/receipt query must include conflicting observations of its identity");
  assert.equal(firstOperationDecision.receipt.status, "success", "the previously committed receipt remains visible for conflict review");
  const changedOwnerDecision = inspectOperation(store, {
    owner: ownerOf(ownerCandidateScope), operationId: originalOperation,
  });
  assert.equal(changedOwnerDecision.status, "conflict", "candidate's changed owner must not appear absent");
  assert.equal(store.read().items.filter((row) => row.event.source === identity.source && row.event.eventId === identity.eventId).length, 1,
    "the initial fact remains authoritative");
});

test("intent COMMIT followed by lost ACK remains unknown and a retry does not dispatch", async (t) => {
  const fixture = await makeFixture(t, "intent-ack");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const execution = makeExecution("op-intent-ack");
  const prototype = Database.prototype;
  const originalExec = prototype.exec;
  let armed = true;
  prototype.exec = function commitThenLoseIntentAck(sql) {
    const result = originalExec.call(this, sql);
    if (armed && String(sql).trim().toUpperCase() === "COMMIT") {
      armed = false;
      throw new Error("injected lost ACK after actual intent COMMIT");
    }
    return result;
  };
  let calls = 0;
  let first;
  try {
    first = await executeOperationOnce(store, execution, () => {
      calls += 1;
      return { status: "success", result: null };
    });
  } finally {
    prototype.exec = originalExec;
  }

  assert.equal(first.status, "unknown");
  assert.equal(first.dispatched, false);
  assert.equal(first.autoReplay, false);
  assert.equal(first.needsReview, true);
  assert.equal(calls, 0);
  assert.equal(inspectOperation(store, {
    owner: ownerOf(execution.scope), operationId: execution.intent.operationId,
  }).status, "unknown");
  const retry = await executeOperationOnce(store, execution, () => {
    calls += 1;
    return { status: "success", result: null };
  });
  assert.equal(retry.status, "unknown");
  assert.equal(retry.dispatched, false);
  assert.equal(calls, 0);
});

test("receipt COMMIT lost ACK is reconciled from SQLite and reopen prevents redispatch", async (t) => {
  const fixture = await makeFixture(t, "receipt-ack");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const execution = makeExecution("op-receipt-ack");
  const prototype = Database.prototype;
  const originalExec = prototype.exec;
  let commits = 0;
  prototype.exec = function commitThenLoseReceiptAck(sql) {
    const result = originalExec.call(this, sql);
    if (String(sql).trim().toUpperCase() === "COMMIT") {
      commits += 1;
      if (commits === 2) throw new Error("injected lost ACK after actual receipt COMMIT");
    }
    return result;
  };
  let calls = 0;
  let result;
  try {
    result = await executeOperationOnce(store, execution, () => {
      calls += 1;
      return { status: "success", result: { durableId: "fixture-1" } };
    });
  } finally {
    prototype.exec = originalExec;
  }

  assert.equal(commits, 2);
  assert.equal(calls, 1);
  assert.equal(result.status, "known_success");
  assert.equal(result.dispatched, true);
  await store.close();

  const reopened = openEventStore({ path: fixture.databasePath, readOnly: true });
  fixture.own(() => reopened.close());
  const query = { owner: ownerOf(execution.scope), operationId: execution.intent.operationId };
  const durable = inspectOperation(reopened, query);
  assert.equal(durable.status, "known_success");
  assert.equal(durable.receipt.result.durableId, "fixture-1");
  const retry = await executeOperationOnce(reopened, execution, () => {
    calls += 1;
    return { status: "success", result: null };
  });
  assert.equal(retry.status, "known_success");
  assert.equal(retry.dispatched, false);
  assert.equal(calls, 1);
});

test("hard-kill after fsynced external effect but before receipt never automatically repeats effect", async (t) => {
  const fixture = await makeFixture(t, "effect-kill");
  const effectPath = path.join(fixture.directory, "external-effect.log");
  const markerPath = path.join(fixture.directory, "effect-ready.marker");
  const execution = makeExecution("op-effect-kill");
  const child = spawn(process.execPath, [
    path.join(testDirectory, "effect-worker.mjs"), fixture.databasePath, effectPath, markerPath, JSON.stringify(execution),
  ], { cwd: repositoryRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  fixture.own(() => stopOwnedChild(child));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  await waitForMarker(child, markerPath, stdout, stderr);
  const exit = await stopOwnedChild(child);
  assert.ok(exit.code !== 0 || exit.signal !== null, "owned worker was hard-killed at the post-effect barrier");

  const effectBefore = await readFile(effectPath, "utf8");
  assert.equal(effectBefore.trim().split("\n").length, 1);
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const query = { owner: ownerOf(execution.scope), operationId: execution.intent.operationId };
  const afterCrash = inspectOperation(store, query);
  assert.equal(afterCrash.status, "unknown");
  assert.equal(afterCrash.autoReplay, false);
  assert.equal(afterCrash.needsReview, true);

  let retryCalls = 0;
  const retry = await executeOperationOnce(store, execution, () => {
    retryCalls += 1;
    return { status: "success", result: { duplicate: true } };
  });
  assert.equal(retry.status, "unknown");
  assert.equal(retry.dispatched, false);
  assert.equal(retryCalls, 0);
  assert.equal(await readFile(effectPath, "utf8"), effectBefore);
});

test("known success and failure receipts survive close/reopen and block replay", async (t) => {
  const fixture = await makeFixture(t, "known-reopen");
  const store = openEventStore({ path: fixture.databasePath });
  const successExecution = makeExecution("op-known-success");
  const failureExecution = makeExecution("op-known-failure");
  let calls = 0;
  const success = await executeOperationOnce(store, successExecution, () => {
    calls += 1;
    return { status: "success", result: { value: 1 } };
  });
  const failure = await executeOperationOnce(store, failureExecution, () => {
    calls += 1;
    return { status: "failure", result: { code: "synthetic-failure" } };
  });
  assert.equal(success.status, "known_success");
  assert.equal(failure.status, "known_failure");
  await store.close();

  const reopened = openEventStore({ path: fixture.databasePath, readOnly: true });
  fixture.own(() => reopened.close());
  for (const [execution, expected] of [[successExecution, "known_success"], [failureExecution, "known_failure"]]) {
    const decision = inspectOperation(reopened, { owner: ownerOf(execution.scope), operationId: execution.intent.operationId });
    assert.equal(decision.status, expected);
    const retry = await executeOperationOnce(reopened, execution, () => {
      calls += 1;
      return { status: "success", result: null };
    });
    assert.equal(retry.status, expected);
    assert.equal(retry.dispatched, false);
  }
  assert.equal(calls, 2);
});

test("unknown can be reconciled by a verified receipt; contradictory verified outcomes become conflict", async (t) => {
  const fixture = await makeFixture(t, "verified");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const execution = makeExecution("op-verified");
  const unknown = await executeOperationOnce(store, execution, () => ({ status: "unknown", result: null }));
  assert.equal(unknown.status, "unknown");

  const verified = await recordVerifiedReceipt(store, {
    scope: execution.scope,
    attemptId: execution.attemptId,
    receipt: { operationId: execution.intent.operationId, status: "success", observedAt: timestamp(4), result: { externalId: "verified-1" } },
  });
  assert.equal(verified.status, "known_success");
  assert.equal(verified.autoReplay, false);
  const contradiction = await recordVerifiedReceipt(store, {
    scope: execution.scope,
    attemptId: "attempt-late-conflicting",
    receipt: { operationId: execution.intent.operationId, status: "failure", observedAt: timestamp(5), result: { code: "contradiction" } },
  });
  assert.equal(contradiction.status, "conflict");
  assert.equal(contradiction.autoReplay, false);
});

test("verified receipt without an owned intent is absent and writes no history", async (t) => {
  const fixture = await makeFixture(t, "receipt-without-intent");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const execution = makeExecution("op-no-intent");
  const beforeFacts = store.read().items.length;
  const beforeObservations = store.readObservations().items.length;
  const absent = await recordVerifiedReceipt(store, {
    scope: execution.scope,
    attemptId: execution.attemptId,
    receipt: { operationId: execution.intent.operationId, status: "success", observedAt: timestamp(6), result: null },
  });
  assert.equal(absent.status, "absent");
  assert.equal(store.read().items.length, beforeFacts);
  assert.equal(store.readObservations().items.length, beforeObservations);

  await executeOperationOnce(store, execution, () => ({ status: "unknown", result: null }));
  const afterIntentFacts = store.read().items.length;
  const afterIntentObservations = store.readObservations().items.length;
  const foreignOperationId = "op-foreign-without-intent";
  const foreign = await recordVerifiedReceipt(store, {
    scope: { ...execution.scope, sessionId: "foreign-session" },
    attemptId: execution.attemptId,
    receipt: { operationId: foreignOperationId, status: "success", observedAt: timestamp(7), result: null },
  });
  assert.equal(foreign.status, "absent");
  assert.equal(store.read().items.length, afterIntentFacts);
  assert.equal(store.readObservations().items.length, afterIntentObservations);
});

test("attempt projection keeps the first terminal by writer order and audits later terminal and receipt", async (t) => {
  const fixture = await makeFixture(t, "terminal-order");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());

  for (const [suffix, first, second, expectedAuditTerminal] of [
    ["success-first", "success", "cancel", "success"],
    ["cancel-first", "cancel", "success", "cancel"],
  ]) {
    const scope = makeScope({ sessionId: `session-${suffix}`, turnId: `turn-${suffix}`, runId: `run-${suffix}` });
    const attemptId = `attempt-${suffix}`;
    await appendEvent(store, event({ suffix: `${suffix}-first`, kind: first, scope, attemptId, payload: { response: "done" } }));
    await appendEvent(store, event({ suffix: `${suffix}-second`, kind: second, scope, attemptId, payload: { response: "late" } }));
    const projection = await recoverAttempt(store, { scope, attemptId });
    assert.equal(projection.status, "recovered");
    assert.equal(projection.projection.terminal.status, first);
    assert.ok(projection.projection.audit.some((item) => item.kind === "after_terminal" && item.terminal === expectedAuditTerminal));
  }

  const execution = makeExecution("op-late-receipt", { sessionId: "session-late", turnId: "turn-late", runId: "run-late" });
  const unknown = await executeOperationOnce(store, execution, () => ({ status: "unknown", result: null }));
  assert.equal(unknown.status, "unknown");
  await appendEvent(store, event({
    suffix: "late-cancel", kind: "cancel", scope: execution.scope, attemptId: execution.attemptId, payload: {},
  }));
  const late = await recordVerifiedReceipt(store, {
    scope: execution.scope,
    attemptId: execution.attemptId,
    receipt: { operationId: execution.intent.operationId, status: "success", observedAt: timestamp(8), result: { id: "late" } },
  });
  assert.equal(late.status, "known_success");
  const recovered = await recoverAttempt(store, { scope: execution.scope, attemptId: execution.attemptId });
  assert.equal(recovered.projection.terminal.status, "cancel");
  assert.ok(recovered.projection.audit.some((item) => item.kind === "after_terminal" && item.event.eventId.startsWith("receipt:")));
});

test("restart closes an open attempt once; absent attempt stays absent", async (t) => {
  const fixture = await makeFixture(t, "restart");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const scope = makeScope();
  const attemptId = "attempt-interrupted-on-restart";
  const draftAt = timestamp(11);
  await appendEvent(store, event({ suffix: "restart-draft", kind: "draft", scope, attemptId, payload: { text: "checkpoint" }, occurredAt: draftAt }));
  const [first, concurrent] = await Promise.all([
    recoverAttempt(store, { scope, attemptId }),
    recoverAttempt(store, { scope, attemptId }),
  ]);
  assert.equal(first.status, "recovered");
  assert.equal(first.projection.lifecycle, "interrupted");
  assert.equal(first.needsReview, true);
  assert.equal(concurrent.status, "recovered");
  assert.equal(concurrent.projection.lifecycle, "interrupted");
  assert.equal(concurrent.projection.audit.some((item) => item.kind === "identity_conflict"), false);
  assert.equal(first.projection.audit.some((item) => item.kind === "identity_conflict"), false);
  const interruptedFacts = store.read({ scope }).items.filter((row) => row.event.kind === "interrupted");
  assert.equal(interruptedFacts.length, 1, "concurrent discovery must preserve one interrupted first fact");
  assert.equal(interruptedFacts[0].event.occurredAt, draftAt);
  assert.equal(interruptedFacts[0].event.payload.timeBasis, "first_committed_attempt_event");
  const afterFirst = store.read({ scope }).items.length;

  const second = await recoverAttempt(store, { scope, attemptId });
  assert.equal(second.status, "recovered");
  assert.equal(second.projection.lifecycle, "interrupted");
  assert.equal(store.read({ scope }).items.length, afterFirst);

  const absentScope = makeScope({ sessionId: "session-no-attempt", turnId: "turn-no-attempt", runId: "run-no-attempt" });
  const beforeAbsent = store.read({ scope: absentScope }).items.length;
  const absent = await recoverAttempt(store, { scope: absentScope, attemptId: "never-started" });
  assert.deepEqual(absent, { status: "absent", needsReview: false, projection: null });
  assert.equal(store.read({ scope: absentScope }).items.length, beforeAbsent);
});

test("operation inspection paginates complete history and incomplete pages never become absent", async (t) => {
  const fixture = await makeFixture(t, "pagination");
  const store = openEventStore({ path: fixture.databasePath });
  fixture.own(() => store.close());
  const operationId = "op-paginated-owner-conflict";
  const localScope = makeScope();
  for (let offset = 0; offset < 260; offset += 16) {
    const batch = [];
    for (let index = offset; index < Math.min(offset + 16, 260); index += 1) {
      batch.push(appendEvent(store, event({
        suffix: `filler-${index}`,
        kind: "fact",
        scope: localScope,
        attemptId: null,
        operationId,
        payload: { index },
      })));
    }
    await Promise.all(batch);
  }
  const foreignIntent = makeEvent({
    suffix: "foreign-intent-after-page-one",
    kind: "operation_intent",
    scope: { ...localScope, sessionId: "foreign-session" },
    attemptId: null,
    operationId,
    payload: { operationId, occurredAt: timestamp(9), operation: "synthetic.write", input: { index: 261 } },
  });
  await appendEvent(store, foreignIntent);
  const fullHistory = inspectOperation(store, { owner: ownerOf(localScope), operationId });
  assert.equal(fullHistory.status, "conflict", "the later foreign-owner row must be read beyond PAGE_SIZE");
  assert.equal(fullHistory.autoReplay, false);

  const execution = makeExecution("op-incomplete-page");
  await executeOperationOnce(store, execution, () => ({ status: "unknown", result: null }));
  const incomplete = withNonAdvancingPages(store);
  const unavailable = inspectOperation(incomplete, {
    owner: ownerOf(execution.scope), operationId: execution.intent.operationId,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.needsReview, true);
  assert.notEqual(unavailable.status, "absent");

  const recoveryScope = makeScope({ sessionId: "session-incomplete-recovery", turnId: "turn-incomplete-recovery", runId: "run-incomplete-recovery" });
  await appendEvent(store, event({ suffix: "incomplete-recovery-draft", kind: "draft", scope: recoveryScope, attemptId: "attempt-x", payload: {} }));
  const countBeforeRecovery = store.read({ scope: recoveryScope }).items.length;
  const blockedRecovery = await recoverAttempt(withNonAdvancingPages(store), { scope: recoveryScope, attemptId: "attempt-x" });
  assert.equal(blockedRecovery.status, "unavailable");
  assert.equal(blockedRecovery.needsReview, true);
  assert.equal(store.read({ scope: recoveryScope }).items.length, countBeforeRecovery, "incomplete history must not append an interrupted event");
});

async function appendEvent(store, runtimeEvent) {
  const raw = JSON.stringify(runtimeEvent);
  const admission = store.append({
    event: runtimeEvent,
    origin: {
      sourcePin: "u07-test-fixture",
      historicalLocator: `fixture:${runtimeEvent.eventId}`,
      rawSha256: sha256(raw),
      rawBytes: Buffer.byteLength(raw),
      extent: "single-synthetic-event",
      rawRetained: false,
    },
  });
  assert.equal(admission.status, "queued", `append rejected as ${admission.status}`);
  return admission.completion;
}

function event(options) {
  return makeEvent({
    suffix: options.suffix,
    kind: options.kind,
    scope: options.scope ?? makeScope(),
    attemptId: options.attemptId === undefined ? "attempt-u07" : options.attemptId,
    operationId: options.operationId ?? null,
    payload: options.payload ?? {},
    ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
  });
}

function makeEvent({ suffix, source = "u07-test-source", eventId = `u07-${suffix}`, kind, scope, attemptId,
  operationId = null, payload, occurredAt = timestamp(0) }) {
  const at = occurredAt;
  return {
    source,
    eventId,
    scope: { sessionId: scope.sessionId, taskId: scope.taskId, turnId: scope.turnId, runId: scope.runId },
    attemptId,
    operationId,
    kind,
    occurredAt: at,
    observedAt: at,
    sourceSequence: null,
    payload,
  };
}

function makeExecution(operationId, overrides = {}) {
  const scope = makeScope(overrides);
  return {
    scope,
    attemptId: overrides.attemptId ?? "attempt-u07-operation",
    intent: {
      operationId,
      occurredAt: timestamp(1),
      operation: overrides.operation ?? "synthetic.write",
      input: overrides.input ?? { target: "fixture/object", value: "expected" },
    },
  };
}

function makeScope(overrides = {}) {
  return {
    sessionId: overrides.sessionId ?? "session-u07",
    taskId: overrides.taskId ?? "task-u07",
    turnId: overrides.turnId ?? "turn-u07",
    runId: overrides.runId ?? "run-u07",
  };
}

function ownerOf(scope) { return { sessionId: scope.sessionId, taskId: scope.taskId }; }
function timestamp(seconds) { return `2026-10-03T07:00:${String(seconds).padStart(2, "0")}.000Z`; }
function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

function withNonAdvancingPages(store) {
  return new Proxy(store, {
    get(target, key) {
      if (key === "read" || key === "readObservations") {
        return (query) => {
          const page = target[key](query);
          return { ...page, hasMore: true, nextAfterCommitSequence: null };
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function makeFixture(t, prefix) {
  const physicalParent = await realpath(experimentParent);
  const directory = await mkdtemp(path.join(physicalParent, `${prefix}-`));
  const cleanupActions = [];
  t.after(async () => {
    for (const action of cleanupActions.reverse()) {
      try { await action(); } catch { /* Keep the test assertion as the primary failure. */ }
    }
    await removeOwnedFixture(directory);
  });
  return {
    directory,
    databasePath: path.join(directory, "events.sqlite"),
    own(action) { cleanupActions.push(action); },
  };
}

async function removeOwnedFixture(target) {
  const physicalParent = await realpath(experimentParent);
  const absoluteTarget = path.resolve(target);
  const targetStat = await stat(absoluteTarget).catch(() => undefined);
  if (targetStat === undefined) return;
  const physicalTarget = await realpath(absoluteTarget);
  assertContained(physicalParent, physicalTarget);
  await rm(physicalTarget, { recursive: true, force: true });
}

function assertContained(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "cleanup target must remain beneath the U07 experiment root");
}

async function waitForMarker(child, markerPath, stdout, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const contents = await readFile(markerPath, "utf8").catch(() => undefined);
    if (contents !== undefined) return contents;
    if (child.exitCode !== null) throw new Error(`owned worker exited before marker: ${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await stopOwnedChild(child);
  throw new Error(`owned worker marker timeout: ${stdout}\n${stderr}`);
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  child.kill();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned recovery worker did not exit promptly")), 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
