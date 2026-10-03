import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeEventFacts,
  canonicalizeJson,
  normalizeRuntimeEvent,
  normalizeSourceSequence,
  projectAttempt,
} from "../../../dist/packages/contracts/src/index.js";

const scope = Object.freeze({ sessionId: "session-1", turnId: "turn-1", runId: "run-1", taskId: "task-1" });
const target = Object.freeze({ scope, attemptId: "attempt-1" });
const eventInput = (overrides = {}) => ({
  source: "zcode/pin/session-1",
  eventId: "event-1",
  scope,
  attemptId: "attempt-1",
  operationId: null,
  kind: "fact",
  occurredAt: "2026-10-03T00:00:00.000Z",
  observedAt: "2026-10-03T00:00:01.000Z",
  sourceSequence: 1,
  payload: { nested: { b: 2, a: 1 } },
  ...overrides,
});
const committed = (commitSequence, input) => ({ commitSequence, event: normalizeRuntimeEvent(input) });

test("native source sequence zero becomes unassigned and invalid integers are rejected", () => {
  assert.equal(normalizeSourceSequence(null), null);
  assert.equal(normalizeSourceSequence(0), null);
  assert.equal(normalizeSourceSequence(7), 7);
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    assert.throws(() => normalizeSourceSequence(invalid), /sourceSequence/);
  }
  assert.equal(normalizeRuntimeEvent(eventInput({ sourceSequence: 0 })).sourceSequence, null);
});

test("canonical event facts exclude observation metadata but include occurredAt", () => {
  const first = normalizeRuntimeEvent(eventInput());
  const redelivery = normalizeRuntimeEvent(eventInput({
    observedAt: "2026-10-03T00:10:00.000Z",
    sourceSequence: 9,
    payload: { nested: { a: 1, b: 2 } },
  }));
  assert.equal(canonicalizeEventFacts(first), canonicalizeEventFacts(redelivery));
  assert.notEqual(
    canonicalizeEventFacts(first),
    canonicalizeEventFacts(normalizeRuntimeEvent(eventInput({ occurredAt: "2026-10-03T00:00:02.000Z" }))),
  );
  assert.equal(canonicalizeJson({ b: [2, 1], a: true }), '{"a":true,"b":[2,1]}');
});

test("normalization rejects forged writer fields and snapshots strict JSON input", () => {
  assert.throws(() => normalizeRuntimeEvent({ ...eventInput(), commitSequence: 4 }), /invalid fields/);
  assert.throws(() => normalizeRuntimeEvent({
    ...eventInput(), scope: { ...scope, extra: "foreign" },
  }), /scope has invalid fields/);
  assert.throws(() => normalizeRuntimeEvent(eventInput({ kind: "operation_intent" })), /stable operationId/);
  assert.throws(() => normalizeRuntimeEvent(eventInput({ kind: "operation_receipt" })), /stable operationId/);

  const payload = { nested: { text: "before" } };
  const original = eventInput({ payload });
  const normalized = normalizeRuntimeEvent(original);
  payload.nested.text = "after";
  assert.equal(normalized.payload.nested.text, "before");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.payload), true);
  assert.equal(Object.isFrozen(normalized.payload.nested), true);

  let getterCalled = false;
  const invalidPayload = {};
  Object.defineProperty(invalidPayload, "text", {
    enumerable: true,
    get() { getterCalled = true; return "unsafe"; },
  });
  assert.throws(() => normalizeRuntimeEvent(eventInput({ payload: invalidPayload })), /strict JsonValue/);
  assert.equal(getterCalled, false);
});

test("commit order selects the first terminal despite later source sequence or earlier event time", () => {
  const cancelFirst = committed(20, eventInput({
    eventId: "cancel-first", kind: "cancel", sourceSequence: 40,
    occurredAt: "2026-10-03T00:10:00.000Z", payload: {},
  }));
  const successLater = committed(21, eventInput({
    eventId: "success-later", kind: "success", sourceSequence: 2,
    occurredAt: "2026-10-03T00:01:00.000Z", payload: { response: "must not replace cancel" },
  }));
  const cancelled = projectAttempt([successLater, cancelFirst], target);
  assert.equal(cancelled.lifecycle, "cancel");
  assert.equal(cancelled.terminal.commitSequence, 20);
  assert.equal(cancelled.authoritativeResponse, null);
  assert.ok(cancelled.audit.some((item) => item.kind === "source_sequence_regressed" && item.event.eventId === "success-later"));
  assert.ok(cancelled.audit.some((item) => item.kind === "after_terminal" && item.event.eventId === "success-later"));

  const successFirst = committed(30, eventInput({
    eventId: "success-first", kind: "success", sourceSequence: 2,
    occurredAt: "2026-10-03T00:01:00.000Z", payload: { response: "authoritative" },
  }));
  const cancelLater = committed(31, eventInput({
    eventId: "cancel-later", kind: "cancel", sourceSequence: 40,
    occurredAt: "2026-10-03T00:10:00.000Z", payload: {},
  }));
  const succeeded = projectAttempt([cancelLater, successFirst], target);
  assert.equal(succeeded.lifecycle, "success");
  assert.equal(succeeded.terminal.commitSequence, 30);
  assert.equal(succeeded.authoritativeResponse, "authoritative");
  assert.ok(succeeded.audit.some((item) => item.kind === "after_terminal" && item.event.eventId === "cancel-later"));
});

test("same source and event ID deduplicates facts and audits resequencing without replacing the first", () => {
  const first = committed(1, eventInput({ sourceSequence: 1 }));
  const redelivery = committed(2, eventInput({ observedAt: "2026-10-03T00:03:00.000Z", sourceSequence: 8 }));
  const projected = projectAttempt([first, redelivery], target);
  assert.equal(projected.events.length, 1);
  assert.equal(projected.events[0].sourceSequence, 1);
  assert.ok(projected.audit.some((item) => item.kind === "duplicate"));
  const resequenced = projected.audit.find((item) => item.kind === "redelivery_resequenced");
  assert.equal(resequenced.firstSourceSequence, 1);
  assert.equal(resequenced.observedSourceSequence, 8);
});

test("identity conflict preserves the first fact and cannot seal a turn", () => {
  const first = committed(1, eventInput({ eventId: "collision", kind: "fact", payload: { value: "original" } }));
  const conflicting = committed(2, eventInput({ eventId: "collision", kind: "success", payload: { response: "fabricated" } }));
  const projected = projectAttempt([first, conflicting], target);
  assert.equal(projected.lifecycle, "in_progress");
  assert.equal(projected.events.length, 1);
  assert.equal(projected.events[0].kind, "fact");
  assert.ok(projected.audit.some((item) => item.kind === "identity_conflict" &&
    item.event.source === first.event.source && item.event.scope.turnId === scope.turnId &&
    item.event.attemptId === target.attemptId));
});

test("identity is source plus event ID, while writer sequence collisions reject distinct events", () => {
  const first = committed(1, eventInput({ eventId: "shared" }));
  const anotherSource = committed(2, eventInput({ eventId: "shared", source: "other-runtime/session-1" }));
  assert.equal(projectAttempt([first, anotherSource], target).events.length, 2);
  assert.throws(() => projectAttempt([
    first,
    committed(1, eventInput({ eventId: "different" })),
  ], target), /writer commit sequence collision/);
  assert.throws(() => projectAttempt([
    first,
    committed(1, eventInput({ eventId: "shared", payload: { changed: true } })),
  ], target), /writer commit sequence collision/);
  const sameCommitRedelivery = projectAttempt([
    committed(3, eventInput({ eventId: "same-commit", sourceSequence: 1 })),
    committed(3, eventInput({ eventId: "same-commit", observedAt: "2026-10-03T00:20:00.000Z", sourceSequence: 4 })),
  ], target);
  assert.equal(sameCommitRedelivery.events.length, 1);
  assert.ok(sameCommitRedelivery.audit.some((item) => item.kind === "redelivery_resequenced"));
  assert.throws(() => projectAttempt([
    { commitSequence: 0, event: normalizeRuntimeEvent(eventInput()) },
  ], target), /positive safe integer/);
});

test("scope must bind all IDs; old attempt events remain audit-only", () => {
  assert.throws(() => projectAttempt([], {
    scope: { sessionId: "session-1", turnId: "turn-1", runId: null, taskId: "task-1" },
    attemptId: "attempt-1",
  }), /runId/);
  assert.throws(() => projectAttempt([
    committed(1, eventInput({ scope: { ...scope, taskId: "other-task" } })),
  ], target), /scope does not match/);

  const oldAttemptSuccess = committed(1, eventInput({
    eventId: "old-attempt", attemptId: "attempt-0", kind: "success", payload: { response: "old" },
  }));
  const currentDraft = committed(2, eventInput({ eventId: "current-draft", kind: "draft", payload: { text: "partial" } }));
  const current = projectAttempt([oldAttemptSuccess, currentDraft], target);
  assert.equal(current.lifecycle, "in_progress");
  assert.equal(current.authoritativeResponse, null);
  assert.equal(current.events.length, 1);
  assert.equal(current.drafts.length, 1);
  assert.ok(current.audit.some((item) => item.kind === "old_attempt" && item.event.attemptId === "attempt-0"));
});

test("drafts and failures never become formal replies; operation receipts do not seal turns", () => {
  const draft = committed(1, eventInput({ eventId: "draft", kind: "draft", payload: { response: "half sentence" } }));
  const intent = committed(2, eventInput({
    eventId: "intent", kind: "operation_intent", operationId: "operation-a", payload: { name: "tool-a" },
  }));
  const unknownReceipt = committed(3, eventInput({
    eventId: "receipt", kind: "operation_receipt", operationId: "operation-a", payload: { status: "unknown" },
  }));
  const failure = committed(4, eventInput({ eventId: "failed", kind: "failure", payload: { response: "not official" } }));
  const projected = projectAttempt([draft, intent, unknownReceipt, failure], target);
  assert.equal(projected.lifecycle, "failure");
  assert.equal(projected.authoritativeResponse, null);
  assert.equal(projected.drafts.length, 1);
  assert.equal(projected.events.length, 4);
});
