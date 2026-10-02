import assert from "node:assert/strict";
import test from "node:test";
import { projectTurn } from "../../worktrees/u07-review/dist/packages/application/turn-projection.js";

const sessionId = "review-session";
const turnId = "review-turn";

function event(id, type, sequenceNumber, payload, overrides = {}) {
  return { id, sessionId, turnId, type, sequenceNumber, payload, ...overrides };
}

test("rejects another turn's result and uses only the final text stream without thought or tool input", () => {
  const projection = projectTurn({
    sessionId,
    turnId,
    events: [
      event("pre-tool-text", "model_streaming", 1, { kind: "text_delta", assistantMessageId: "draft-message", delta: "I will inspect the file. " }),
      event("final-thought", "model_streaming", 2, { kind: "reasoning_delta", assistantMessageId: "final-message", delta: "PRIVATE_THOUGHT_CANARY" }),
      event("final-tool-json", "model_streaming", 3, { kind: "tool_input_delta", assistantMessageId: "final-message", delta: "{\"private\":true}" }),
      event("final-text-1", "model_streaming", 4, { kind: "text_delta", assistantMessageId: "final-message", delta: "Native final " }),
      event("final-text-2", "model_streaming", 5, { kind: "text_delta", assistantMessageId: "final-message", delta: "reply." }),
      event("empty-completion", "turn_complete", 6, { response: "", resultType: "cancelled" }),
    ],
    turnResult: { turnId: "another-turn", response: "WRONG_TURN_CANARY", events: [] },
  });

  assert.equal(projection.reply.role, "agent");
  assert.equal(projection.reply.source, "stream");
  assert.equal(projection.reply.text, "Native final reply.");
  assert.equal(projection.reply.text.includes("PRIVATE_THOUGHT_CANARY"), false);
  assert.equal(projection.reply.text.includes("private"), false);
  assert.equal(projection.reply.text.includes("WRONG_TURN_CANARY"), false);
  assert.equal(projection.lifecycle, "cancelled");
});

test("same required tool ID from a different session or turn cannot verify the current turn", () => {
  const projection = projectTurn({
    sessionId,
    turnId,
    events: [
      event("foreign-turn-success", "tool_call_result", 1, {
        toolCallId: "required-read",
        result: { success: true, content: "ignore" },
      }, { turnId: "different-turn" }),
      event("foreign-session-success", "tool_call_result", 2, {
        toolCallId: "required-read",
        result: { success: true, content: "ignore" },
      }, { sessionId: "different-session" }),
      event("current-complete", "turn_complete", 3, { response: "The read succeeded.", resultType: "success" }),
    ],
    requiredToolCallIds: ["required-read"],
  });

  assert.equal(projection.lifecycle, "completed");
  assert.equal(projection.reply.text, "The read succeeded.");
  assert.equal(projection.evidenceStatus, "unverified");
  assert.deepEqual(projection.toolReceipts, []);
});
