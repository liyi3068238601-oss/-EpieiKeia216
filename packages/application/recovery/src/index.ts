import { createHash } from "node:crypto";
import {
  canonicalizeJson, normalizeRuntimeEvent, projectAttempt,
  type AttemptProjection, type BoundEventScope, type NormalizedEvent,
  type OperationIntent, type OperationReceipt, type WriterOrderedEvent,
} from "../../../contracts/src/events.js";
import type { JsonValue } from "../../../contracts/src/json-value.js";
import type { AppendResult, EventStore, ReadPage, ReadQuery } from "../../../storage/events/src/index.js";

const SOURCE = "xiadie.recovery/v1";
const MAX_PAGES = 32;
const PAGE_SIZE = 256;
type RecoveryStore = Pick<EventStore, "read" | "readObservations" | "append">;
export interface OperationOwner { readonly sessionId: string; readonly taskId: string }
export interface OperationQuery {
  readonly owner: OperationOwner;
  readonly operationId: string;
  readonly expected?: { readonly operation: string; readonly input: JsonValue };
}
export interface OperationDecision {
  readonly status: "absent" | "known_success" | "known_failure" | "unknown" | "conflict" | "unavailable";
  readonly operationId: string;
  readonly autoReplay: false;
  readonly needsReview: boolean;
  readonly inputSha256: string | null;
  readonly receipt: {
    readonly status: "success" | "failure";
    readonly result: JsonValue | null;
    readonly event: { readonly source: string; readonly eventId: string };
    readonly commitSequence: number;
  } | null;
  readonly reason: "NO_HISTORY" | "KNOWN_RECEIPT" | "NO_KNOWN_RECEIPT" | "HISTORY_CONFLICT" | "READ_UNAVAILABLE" | "INTENT_NOT_COMMITTED";
}
export interface OperationExecution {
  readonly scope: BoundEventScope;
  readonly attemptId: string;
  readonly intent: OperationIntent;
}
export interface EffectOutcome {
  readonly status: OperationReceipt["status"];
  readonly result: JsonValue | null;
}
export interface AttemptRecovery {
  readonly status: "absent" | "recovered" | "unavailable";
  readonly needsReview: boolean;
  readonly projection: AttemptProjection | null;
}

/** Committed operation history, across turns and attempts; never an automatic replay policy. */
export function inspectOperation(store: RecoveryStore, query: OperationQuery): OperationDecision {
  const owner = snapshotOwner(query.owner);
  const operationId = nonempty(query.operationId);
  const expected = query.expected === undefined ? undefined : descriptor(query.expected);
  try {
    const facts = readAll(store.read.bind(store), { operationId });
    // Conflict candidates can change operationId (and owner). Complete identity auditing
    // therefore cannot rely on the candidate's operation filter. U05 has no identity query.
    const identities = new Set(facts.map((row) => canonicalizeJson([row.event.source, row.event.eventId])));
    const observations = readAll(store.readObservations.bind(store), {}).filter((row) =>
      row.event.operationId === operationId || identities.has(canonicalizeJson([row.event.source, row.event.eventId])));
    if (facts.length === 0 && observations.length === 0) return decision(operationId, "absent", "NO_HISTORY");
    let conflict = observations.some((item) => item.disposition === "identity_conflict");
    let intentDescriptor: string | undefined;
    let inputSha256: string | null = null;
    let receipt: OperationDecision["receipt"] = null;
    let knownSignature: string | undefined;
    for (const entry of facts) {
      const event = normalizeRuntimeEvent(entry.event);
      if (event.operationId !== operationId || !sameOwner(event.scope, owner)) { conflict = true; continue; }
      if (event.kind === "operation_intent") {
        const payload = objectPayload(event.payload);
        if (payload.operationId !== operationId || typeof payload.occurredAt !== "string" || payload.occurredAt.length === 0) {
          conflict = true; continue;
        }
        const current = descriptor({ operation: payload.operation as string, input: payload.input! });
        if (intentDescriptor !== undefined && current !== intentDescriptor) conflict = true;
        intentDescriptor ??= current;
        inputSha256 ??= sha(canonicalizeJson(payload.input!));
        if (expected !== undefined && expected !== current) conflict = true;
      } else if (event.kind === "operation_receipt") {
        const payload = objectPayload(event.payload);
        if (payload.operationId !== operationId || typeof payload.observedAt !== "string" || payload.observedAt.length === 0 ||
            !Object.hasOwn(payload, "result") || !["success", "failure", "unknown"].includes(payload.status as string)) {
          conflict = true; continue;
        }
        if (payload.status === "unknown") continue;
        const signature = canonicalizeJson({ status: payload.status!, result: payload.result! });
        if (knownSignature !== undefined && knownSignature !== signature) conflict = true;
        knownSignature ??= signature;
        receipt ??= Object.freeze({
          status: payload.status as "success" | "failure", result: payload.result!,
          event: Object.freeze({ source: event.source, eventId: event.eventId }), commitSequence: entry.commitSequence,
        });
      }
    }
    // A receipt without a committed intent is evidence requiring review, not permission to run.
    if (intentDescriptor === undefined && receipt !== null) conflict = true;
    if (conflict) return decision(operationId, "conflict", "HISTORY_CONFLICT", inputSha256, receipt);
    if (receipt !== null) return decision(operationId, receipt.status === "success" ? "known_success" : "known_failure", "KNOWN_RECEIPT", inputSha256, receipt);
    return decision(operationId, "unknown", "NO_KNOWN_RECEIPT", inputSha256);
  } catch {
    return decision(operationId, "unavailable", "READ_UNAVAILABLE");
  }
}

/** Only a newly ACKed intent may dispatch. A duplicate or uncertain ACK can never dispatch. */
export async function executeOperationOnce(
  store: RecoveryStore, input: OperationExecution,
  perform: (intent: OperationIntent) => Promise<EffectOutcome> | EffectOutcome,
): Promise<OperationDecision & { readonly dispatched: boolean }> {
  const scope = snapshotScope(input.scope);
  const attemptId = nonempty(input.attemptId);
  const intentEvent = makeEvent("operation_intent", {
    sessionId: scope.sessionId, taskId: scope.taskId, turnId: null, runId: null,
  }, null, input.intent.operationId, `intent:${sha(nonempty(input.intent.operationId))}`,
  input.intent.occurredAt, input.intent as unknown as JsonValue);
  const intent = intentEvent.payload as unknown as OperationIntent;
  const query: OperationQuery = { owner: scope, operationId: intent.operationId, expected: { operation: intent.operation, input: intent.input } };
  // Snapshot and validate before the first await; no mutable caller input crosses the ACK boundary.
  descriptor(query.expected!);
  const prior = inspectOperation(store, query);
  if (prior.status !== "absent") return dispatched(prior, false);
  const committed = await append(store, intentEvent);
  if (committed?.status !== "committed") {
    const reread = inspectOperation(store, query);
    return dispatched(reread.status === "absent"
      ? decision(intent.operationId, "unavailable", "INTENT_NOT_COMMITTED") : reread, false);
  }
  // A separate writer may have committed contradictory history during admission.
  const afterIntent = inspectOperation(store, query);
  if (afterIntent.status !== "unknown") return dispatched(afterIntent, false);
  let outcome: EffectOutcome;
  try {
    outcome = await perform(intent);
    // Validate outcome using the same immutable receipt snapshot as reconciliation.
    receiptEvent(scope, attemptId, {
      operationId: intent.operationId, observedAt: new Date().toISOString(), status: outcome.status, result: outcome.result,
    });
  } catch {
    outcome = { status: "unknown", result: null };
  }
  const receipt = receiptEvent(scope, attemptId, {
    operationId: intent.operationId, observedAt: new Date().toISOString(), status: outcome.status, result: outcome.result,
  });
  await append(store, receipt);
  // An effect result alone is insufficient; actual committed history decides durable knowledge.
  return dispatched(inspectOperation(store, query), true);
}

/** Trusted reconciliation only. This API records an attested outcome and never invokes an effect. */
export async function recordVerifiedReceipt(
  store: RecoveryStore,
  input: { readonly scope: BoundEventScope; readonly attemptId: string; readonly receipt: OperationReceipt },
): Promise<OperationDecision> {
  const scope = snapshotScope(input.scope);
  const event = receiptEvent(scope, nonempty(input.attemptId), input.receipt);
  const query: OperationQuery = { owner: scope, operationId: event.operationId! };
  const prior = inspectOperation(store, query);
  if (prior.status === "absent" || prior.status === "unavailable" || prior.status === "conflict" || prior.inputSha256 === null) return prior;
  await append(store, event);
  return inspectOperation(store, query);
}

/** Recover committed evidence; an absent attempt is never fabricated into interrupted history. */
export async function recoverAttempt(
  store: RecoveryStore, input: { readonly scope: BoundEventScope; readonly attemptId: string },
): Promise<AttemptRecovery> {
  const scope = snapshotScope(input.scope);
  const attemptId = nonempty(input.attemptId);
  const readProjection = (): AttemptProjection | null => {
    const facts = readAll(store.read.bind(store), { scope });
    const observations = readAll(store.readObservations.bind(store), { scope });
    const bySequence = new Map<number, WriterOrderedEvent>();
    for (const row of [...facts, ...observations]) {
      if (!sameScope(row.event.scope, scope)) throw new Error("scope mismatch");
      bySequence.set(row.commitSequence, { commitSequence: row.commitSequence, event: row.event });
    }
    if (![...bySequence.values()].some((row) => row.event.attemptId === attemptId)) return null;
    return projectAttempt([...bySequence.values()], { scope, attemptId });
  };
  try {
    let projection = readProjection();
    if (projection === null) return Object.freeze({ status: "absent", needsReview: false, projection: null });
    if (projection.terminal === null) {
      // This derived fact describes the evidenced unclosed attempt, not a guessed crash
      // instant. Its fact time is the first committed attempt event; discovery time is
      // observation metadata. Concurrent discoveries then share identical canonical facts.
      const occurredAt = projection.events[0]!.occurredAt;
      const event = makeEvent("interrupted", scope, attemptId, null,
        `interrupted:${sha(canonicalizeJson({ scope: scope as unknown as JsonValue, attemptId }))}`,
        occurredAt, { reason: "restart", needsReview: true, timeBasis: "first_committed_attempt_event" },
        new Date().toISOString());
      await append(store, event);
      projection = readProjection();
      if (projection === null || projection.terminal === null) return Object.freeze({ status: "unavailable", needsReview: true, projection });
    }
    return Object.freeze({ status: "recovered", needsReview: projection.lifecycle === "interrupted" ||
      projection.audit.some((item) => item.kind === "identity_conflict"), projection });
  } catch {
    return Object.freeze({ status: "unavailable", needsReview: true, projection: null });
  }
}

function readAll<T extends { readonly commitSequence: number }>(
  read: (query: ReadQuery) => ReadPage<T>, query: ReadQuery,
): T[] {
  const items: T[] = [];
  let after = 0;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const page = read({ ...query, limit: PAGE_SIZE, afterCommitSequence: after });
    if (!Array.isArray(page.items) || page.items.length > PAGE_SIZE || typeof page.hasMore !== "boolean") throw new Error("invalid page");
    let last = after;
    for (const item of page.items) {
      if (!Number.isSafeInteger(item.commitSequence) || item.commitSequence <= last) throw new Error("invalid frontier");
      last = item.commitSequence;
      items.push(item);
    }
    if (!page.hasMore) return items;
    if (last <= after || page.nextAfterCommitSequence !== last) throw new Error("nonadvancing frontier");
    after = last;
  }
  throw new Error("incomplete history");
}

async function append(store: RecoveryStore, event: NormalizedEvent): Promise<AppendResult | null> {
  const raw = canonicalizeJson(event as unknown as JsonValue);
  try {
    const admission = store.append({ event, origin: {
      sourcePin: SOURCE, historicalLocator: `derived:${event.eventId}`, rawSha256: sha(raw),
      rawBytes: Buffer.byteLength(raw), extent: "derived-operation-event", rawRetained: false,
    } });
    return admission.status === "queued" ? await admission.completion : null;
  } catch { return null; }
}

function receiptEvent(scope: BoundEventScope, attemptId: string, value: OperationReceipt): NormalizedEvent {
  nonempty(value.operationId);
  nonempty(value.observedAt);
  if (!["success", "failure", "unknown"].includes(value.status)) throw new TypeError("invalid receipt status");
  const payload = { operationId: value.operationId, status: value.status, observedAt: value.observedAt, result: value.result };
  return makeEvent("operation_receipt", scope, attemptId, value.operationId,
    `receipt:${sha(canonicalizeJson({ scope: scope as unknown as JsonValue, attemptId, payload }))}`,
    value.observedAt, payload);
}
function makeEvent(kind: NormalizedEvent["kind"], scope: NormalizedEvent["scope"], attemptId: string | null,
  operationId: string | null, eventId: string, occurredAt: string, payload: JsonValue,
  observedAt = occurredAt): NormalizedEvent {
  return normalizeRuntimeEvent({ source: SOURCE, eventId, scope, attemptId, operationId, kind,
    occurredAt, observedAt, sourceSequence: null, payload });
}
function descriptor(value: { readonly operation: string; readonly input: JsonValue }): string {
  return canonicalizeJson({ operation: nonempty(value.operation), input: value.input });
}
function objectPayload(payload: JsonValue): Record<string, JsonValue> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("invalid operation payload");
  return payload as Record<string, JsonValue>;
}
function snapshotOwner(owner: OperationOwner): OperationOwner {
  return Object.freeze({ sessionId: nonempty(owner.sessionId), taskId: nonempty(owner.taskId) });
}
function snapshotScope(scope: BoundEventScope): BoundEventScope {
  return Object.freeze({ sessionId: nonempty(scope.sessionId), taskId: nonempty(scope.taskId),
    turnId: nonempty(scope.turnId), runId: nonempty(scope.runId) });
}
function sameOwner(scope: NormalizedEvent["scope"], owner: OperationOwner): boolean {
  return scope.sessionId === owner.sessionId && scope.taskId === owner.taskId;
}
function sameScope(actual: NormalizedEvent["scope"], expected: BoundEventScope): boolean {
  return sameOwner(actual, expected) && actual.turnId === expected.turnId && actual.runId === expected.runId;
}
function nonempty(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("expected nonempty string");
  return value;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function decision(operationId: string, status: OperationDecision["status"], reason: OperationDecision["reason"],
  inputSha256: string | null = null, receipt: OperationDecision["receipt"] = null): OperationDecision {
  return Object.freeze({ operationId, status, autoReplay: false, needsReview: !["absent", "known_success", "known_failure"].includes(status),
    inputSha256, receipt, reason });
}
function dispatched(value: OperationDecision, flag: boolean): OperationDecision & { readonly dispatched: boolean } {
  return Object.freeze({ ...value, dispatched: flag });
}
