import assert from "node:assert/strict";
import test from "node:test";
import { createTurnEventCollector, projectTurn } from "../../../dist/packages/application/turn-projection.js";

const sessionId = "session-u07";
const turnId = "turn-u07";
const event = (type, sequenceNumber, payload = {}, overrides = {}) => ({
  id: `event-${sequenceNumber}`,
  sessionId,
  turnId,
  type,
  sequenceNumber,
  payload,
  ...overrides,
});

test("merges duplicate native stream and TurnResult events, orders receipts, and preserves the native reply", () => {
  const scheduled = event("tool_call_scheduled", 1, { toolCallId: "read-1", toolName: "Read" });
  const started = event("tool_call_started", 2, { toolCallId: "read-1" });
  const completed = event("tool_call_result", 4, {
    toolCallId: "read-1",
    result: { success: true, content: "private file contents are not projected" },
  });
  const turnComplete = event("turn_complete", 5, { response: "Native final response.", resultType: "success" });
  const projection = projectTurn({
    sessionId,
    turnId,
    events: [turnComplete, completed, started, scheduled],
    turnResult: { turnId, response: "Native final response.", events: [scheduled, started, completed, turnComplete] },
    requiredToolCallIds: ["read-1"],
  });

  assert.equal(projection.reply.role, "agent");
  assert.equal(projection.reply.text, "Native final response.");
  assert.equal(projection.reply.source, "turn_result");
  assert.equal(projection.lifecycle, "completed");
  assert.equal(projection.evidenceStatus, "verified");
  assert.deepEqual(projection.toolReceipts, [{ toolCallId: "read-1", toolName: "Read", status: "succeeded" }]);
  assert.equal(JSON.stringify(projection).includes("private file contents"), false);
});

test("keeps distinct native TurnResult-only sequence-zero events and merges their live copies by ID", () => {
  const scheduled = event("tool_call_scheduled", 0, { toolCallId: "read-zero", toolName: "Read" }, { id: "native-scheduled" });
  const completed = event("tool_call_result", 0, {
    toolCallId: "read-zero",
    result: { success: true, content: "not projected" },
  }, { id: "native-result" });
  const turnComplete = event("turn_complete", 0, { response: "Read complete.", resultType: "success" }, { id: "native-complete" });
  const resultOnly = projectTurn({
    sessionId,
    turnId,
    turnResult: { turnId, response: "Read complete.", events: [scheduled, completed, turnComplete] },
    requiredToolCallIds: ["read-zero"],
  });
  assert.equal(resultOnly.evidenceStatus, "verified");
  assert.equal(resultOnly.lifecycle, "completed");
  assert.equal(resultOnly.reply.text, "Read complete.");

  const liveScheduled = { ...scheduled, sequenceNumber: 7 };
  const liveCompleted = { ...completed, sequenceNumber: 12 };
  const liveComplete = { ...turnComplete, sequenceNumber: 13 };
  const merged = projectTurn({
    sessionId,
    turnId,
    events: [liveScheduled, liveCompleted, liveComplete],
    turnResult: { turnId, response: "Read complete.", events: [scheduled, completed, turnComplete] },
    requiredToolCallIds: ["read-zero"],
  });
  assert.equal(merged.evidenceStatus, "verified");
  assert.equal(merged.lifecycle, "completed");
  assert.deepEqual(merged.toolReceipts, [{ toolCallId: "read-zero", toolName: "Read", status: "succeeded" }]);
});

test("same event ID with conflicting turn or terminal payload fails closed", () => {
  const current = event("tool_call_result", 21, { toolCallId: "same-event", result: { success: true, content: "" } }, { id: "shared-id" });
  const foreignTurn = { ...current, sequenceNumber: 0, turnId: "foreign-turn" };
  const turnConflict = projectTurn({
    sessionId,
    turnId,
    events: [foreignTurn, current],
    requiredToolCallIds: ["same-event"],
  });
  assert.equal(turnConflict.toolReceipts[0]?.status, "unknown");
  assert.equal(turnConflict.evidenceStatus, "unverified");

  const oppositeOutcome = {
    ...current,
    sequenceNumber: 0,
    payload: { toolCallId: "same-event", result: { success: false, content: "" } },
  };
  const payloadConflict = projectTurn({
    sessionId,
    turnId,
    events: [current, oppositeOutcome],
    requiredToolCallIds: ["same-event"],
  });
  assert.equal(payloadConflict.toolReceipts[0]?.status, "unknown");
  assert.equal(payloadConflict.evidenceStatus, "unverified");

  const duplicateAfterConflict = projectTurn({
    sessionId,
    turnId,
    events: [
      { ...current, sequenceNumber: 0 },
      oppositeOutcome,
      { ...current, sequenceNumber: 100 },
    ],
    requiredToolCallIds: ["same-event"],
  });
  assert.equal(duplicateAfterConflict.toolReceipts[0]?.status, "unknown");
  assert.equal(duplicateAfterConflict.evidenceStatus, "unverified");
});

test("a normal turn and confident role text stay unverified when a required receipt failed or is absent", () => {
  const failed = projectTurn({
    sessionId,
    turnId,
    events: [
      event("tool_call_scheduled", 1, { toolCallId: "read-fail", toolName: "Read" }),
      event("tool_call_error", 2, { toolCallId: "read-fail", error: { type: "secret_canary_type", message: "private detail" } }),
      event("turn_complete", 3, { response: "I completed the read successfully.", resultType: "success" }),
    ],
    requiredToolCallIds: ["read-fail"],
  });
  assert.equal(failed.lifecycle, "completed");
  assert.equal(failed.evidenceStatus, "failed");
  assert.equal(failed.reply.text, "I completed the read successfully.");
  assert.equal(failed.toolReceipts[0]?.errorType, "tool_error");
  assert.equal(JSON.stringify(failed).includes("private detail"), false);
  assert.equal(JSON.stringify(failed).includes("secret_canary_type"), false);

  const absent = projectTurn({
    sessionId,
    turnId,
    events: [
      event("model_complete", 1, { content: "Done.", stopReason: "stop" }),
      event("turn_complete", 2, { response: "Done.", resultType: "success" }),
      event("tool_call_result", 3, { toolCallId: "foreign", result: { success: true, content: "ignored" } }, { turnId: "another-turn" }),
      event("tool_call_result", 4, { toolCallId: "foreign-session", result: { success: true, content: "ignored" } }, { sessionId: "another-session" }),
    ],
    requiredToolCallIds: ["missing"],
  });
  assert.equal(absent.lifecycle, "completed");
  assert.equal(absent.evidenceStatus, "unverified");
  assert.deepEqual(absent.toolReceipts, []);
  assert.equal(absent.reply.text, "Done.");
});

test("hook block remains blocked even when native turn lifecycle says success", () => {
  const projection = projectTurn({
    sessionId,
    turnId,
    events: [
      event("hook_run_blocked", 1, { descriptor: { event: "UserPromptSubmit" } }),
      event("turn_complete", 2, { response: "Prompt was blocked.", resultType: "success" }),
    ],
    requiredToolCallIds: ["read-1"],
  });
  assert.equal(projection.lifecycle, "completed");
  assert.equal(projection.evidenceStatus, "blocked");
  assert.equal(projection.hookBlocked, true);
});

test("partial receipts, cancellation, and empty completion fallback keep text and execution facts separate", () => {
  const projection = projectTurn({
    sessionId,
    turnId,
    events: [
      event("model_streaming", 1, { kind: "text_delta", assistantMessageId: "assistant-1", delta: "Read " }),
      event("tool_call_scheduled", 2, { toolCallId: "read-ok", toolName: "Read" }),
      event("tool_call_result", 3, { toolCallId: "read-ok", result: { success: true, content: "discarded" } }),
      event("model_streaming", 4, { kind: "text_delta", assistantMessageId: "assistant-1", delta: "started." }),
      event("turn_complete", 5, { response: "", resultType: "cancelled" }),
    ],
    turnResult: { turnId, response: "", events: [] },
    requiredToolCallIds: ["read-ok", "read-next"],
  });
  assert.equal(projection.lifecycle, "cancelled");
  assert.equal(projection.evidenceStatus, "partial");
  assert.equal(projection.reply.text, "Read started.");
  assert.equal(projection.reply.source, "stream");
  assert.equal(projection.toolReceipts[0]?.status, "succeeded");
});

test("conflicting terminal receipts fail closed and a no-tool conversation has an independent evidence state", () => {
  const conflicted = projectTurn({
    sessionId,
    turnId,
    events: [
      event("tool_call_scheduled", 1, { toolCallId: "same-id", toolName: "Read" }),
      event("tool_call_result", 2, { toolCallId: "same-id", result: { success: true, content: "" } }),
      event("tool_call_error", 3, { toolCallId: "same-id", error: { type: "tool_execution_failed" } }),
      event("turn_complete", 4, { response: "Finished.", resultType: "success" }),
    ],
    requiredToolCallIds: ["same-id"],
  });
  assert.equal(conflicted.toolReceipts[0]?.status, "unknown");
  assert.equal(conflicted.evidenceStatus, "unverified");

  const sameSequenceConflict = projectTurn({
    sessionId,
    turnId,
    events: [
      event("tool_call_result", 8, { toolCallId: "same-sequence", result: { success: true, content: "" } }),
      event("tool_call_result", 8, { toolCallId: "same-sequence", result: { success: false, content: "" } }),
      event("turn_complete", 9, { response: "Finished.", resultType: "success" }),
    ],
    requiredToolCallIds: ["same-sequence"],
  });
  assert.equal(sameSequenceConflict.toolReceipts[0]?.status, "unknown");
  assert.equal(sameSequenceConflict.evidenceStatus, "unverified");

  const terminalWithoutLifecycleLeadIn = projectTurn({
    sessionId,
    turnId,
    events: [event("tool_call_result", 1, { toolCallId: "result-only", result: { success: true, content: "" } })],
    requiredToolCallIds: ["result-only"],
  });
  assert.equal(terminalWithoutLifecycleLeadIn.toolReceipts[0]?.status, "succeeded");
  assert.equal(terminalWithoutLifecycleLeadIn.evidenceStatus, "verified");

  const conversation = projectTurn({
    sessionId,
    turnId,
    events: [event("turn_complete", 1, { response: "Just chatting.", resultType: "success" })],
  });
  assert.equal(conversation.evidenceStatus, "not_required");
  assert.deepEqual(conversation.toolReceipts, []);
});

test("collector can subscribe before native admission, then bind and discard other turns", () => {
  const collector = createTurnEventCollector(sessionId);
  collector.onSessionEvent(event("turn_complete", 2, { response: "Other turn", resultType: "success" }, { turnId: "other-turn" }));
  collector.onSessionEvent(event("turn_complete", 4, { response: "This turn", resultType: "success" }));
  collector.bindTurn(turnId);
  const projection = collector.project({ turnId: "different-result", response: "Stale response", events: [] });
  assert.equal(projection.reply.text, "This turn");
  assert.equal(projection.reply.source, "turn_complete");
  collector.close();
  assert.throws(() => collector.project(), /closed/);
});
