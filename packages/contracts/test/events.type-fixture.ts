import type {
  NormalizedEvent,
  OperationIntent,
  OperationReceipt,
  RuntimeEventInput,
  WriterOrderedEvent,
} from "../src/index.js";

const ordinary: RuntimeEventInput = {
  source: "runtime/session-1",
  eventId: "evt-1",
  scope: { sessionId: "session-1", turnId: null, runId: null, taskId: null },
  attemptId: null,
  operationId: null,
  kind: "fact",
  occurredAt: "2026-10-03T00:00:00.000Z",
  observedAt: "2026-10-03T00:00:01.000Z",
  sourceSequence: null,
  payload: { ok: true },
};
void ordinary;

const intent: OperationIntent = {
  operationId: "operation-1",
  occurredAt: "2026-10-03T00:00:00.000Z",
  operation: "tool.call",
  input: { name: "synthetic" },
};
const receipt: OperationReceipt = {
  operationId: "operation-1",
  status: "unknown",
  observedAt: "2026-10-03T00:00:01.000Z",
  result: null,
};
void intent;
void receipt;

declare const normalized: NormalizedEvent;
const writerEntry: WriterOrderedEvent = { commitSequence: 1, event: normalized };
void writerEntry;

// @ts-expect-error writer sequence belongs to its separate envelope
const forgedCommitSequence: NormalizedEvent = { ...ordinary, commitSequence: 1 };
void forgedCommitSequence;

// @ts-expect-error operation events need a stable non-null association ID
const unlinkedOperation: RuntimeEventInput = { ...ordinary, kind: "operation_receipt", operationId: null };
void unlinkedOperation;

// @ts-expect-error operation intents cannot use a nullable operation ID
const unlinkedIntent: OperationIntent = { ...intent, operationId: null };
void unlinkedIntent;

// @ts-expect-error an unknown operation receipt still needs its operation ID
const unlinkedReceipt: OperationReceipt = { ...receipt, operationId: null };
void unlinkedReceipt;
