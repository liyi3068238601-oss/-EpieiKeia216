import { isJsonValue, type JsonValue } from "./json-value.js";

/** Source sequence and observation time describe delivery, not event facts. */
export type TerminalStatus = "success" | "failure" | "cancel" | "interrupted";

export type RuntimeEventKind =
  | "fact"
  | "draft"
  | TerminalStatus
  | "operation_intent"
  | "operation_receipt";

/** Generic event scope may be incomplete; a turn projection requires a bound scope. */
export interface EventScope {
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly runId: string | null;
  readonly taskId: string | null;
}

export interface BoundEventScope {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly taskId: string;
}

interface RuntimeEventFields<K extends RuntimeEventKind> {
  readonly source: string;
  readonly eventId: string;
  readonly scope: EventScope;
  readonly attemptId: string | null;
  readonly operationId: string | null;
  readonly kind: K;
  readonly occurredAt: string;
  readonly observedAt: string;
  /** Native 0 means unassigned and is normalized to null. */
  readonly sourceSequence: number | null;
  readonly payload: JsonValue;
}

type OperationEventKind = "operation_intent" | "operation_receipt";
type OrdinaryEventKind = Exclude<RuntimeEventKind, OperationEventKind>;

/** Operation intent/receipt events require a stable non-null operation ID. */
export type RuntimeEventInput =
  | RuntimeEventFields<OrdinaryEventKind>
  | (Omit<RuntimeEventFields<OperationEventKind>, "operationId"> & { readonly operationId: string });

/** Canonical facts deliberately exclude observedAt and sourceSequence. */
export type CanonicalEventFacts =
  | Omit<RuntimeEventFields<OrdinaryEventKind>, "observedAt" | "sourceSequence">
  | (Omit<RuntimeEventFields<OperationEventKind>, "operationId" | "observedAt" | "sourceSequence"> & { readonly operationId: string });

/** A validated, immutable event snapshot. Writer commit sequence is not a fact field. */
export type NormalizedEvent = RuntimeEventInput;

/** The writer's accepted-event receipt is separate from any operation-effect receipt. */
export interface WriterOrderedEvent {
  readonly commitSequence: number;
  readonly event: NormalizedEvent;
}

export interface SourceEventIdentity {
  readonly source: string;
  readonly eventId: string;
}

export interface OperationIntent {
  /** Stable across retries; attempt-scoped data is not part of this description. */
  readonly operationId: string;
  readonly occurredAt: string;
  readonly operation: string;
  readonly input: JsonValue;
}

/** External effect receipt; it does not prove that an event row was committed. */
/** An unknown receipt records uncertainty and does not authorize replay. */
export interface OperationReceipt {
  readonly operationId: string;
  readonly status: "success" | "failure" | "unknown";
  readonly observedAt: string;
  readonly result: JsonValue | null;
}

export interface AttemptProjectionTarget {
  readonly scope: BoundEventScope;
  readonly attemptId: string;
}

export interface EventReference extends SourceEventIdentity {
  readonly scope: EventScope;
  readonly attemptId: string | null;
}

export type EventAudit =
  | { readonly kind: "duplicate"; readonly event: EventReference }
  | {
      readonly kind: "redelivery_resequenced";
      readonly event: EventReference;
      readonly firstSourceSequence: number | null;
      readonly observedSourceSequence: number | null;
    }
  | { readonly kind: "identity_conflict"; readonly event: EventReference }
  | {
      readonly kind: "source_sequence_regressed";
      readonly event: EventReference;
      readonly priorMaximum: number;
      readonly observed: number;
    }
  | {
      readonly kind: "old_attempt";
      readonly event: EventReference;
      readonly currentAttemptId: string;
    }
  | {
      readonly kind: "after_terminal";
      readonly event: EventReference;
      readonly terminal: TerminalStatus;
    };

export interface AttemptTerminal {
  readonly status: TerminalStatus;
  readonly event: EventReference;
  readonly commitSequence: number;
  readonly occurredAt: string;
  /** Present only when the first success terminal carries an authoritative string response. */
  readonly authoritativeResponse: string | null;
}

export interface AttemptProjection {
  readonly attemptId: string;
  readonly lifecycle: TerminalStatus | "in_progress";
  readonly terminal: AttemptTerminal | null;
  readonly authoritativeResponse: string | null;
  readonly events: readonly NormalizedEvent[];
  readonly drafts: readonly NormalizedEvent[];
  readonly audit: readonly EventAudit[];
}

/** Rejects invalid source sequence values; native zero maps to unassigned null. */
export function normalizeSourceSequence(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("sourceSequence must be null or a non-negative safe integer");
  }
  return value === 0 ? null : value;
}

/** Validates strict keys and snapshots payloads so later caller mutation cannot alter facts. */
export function normalizeRuntimeEvent(value: unknown): NormalizedEvent {
  if (!hasExactDataFields(value, EVENT_FIELDS)) {
    throw new TypeError("runtime event has invalid fields");
  }
  const record = value as Record<string, unknown>;
  const source = requireNonEmptyString(record.source, "source");
  const eventId = requireNonEmptyString(record.eventId, "eventId");
  const scope = normalizeEventScope(record.scope);
  const attemptId = normalizeNullableString(record.attemptId, "attemptId");
  const operationId = normalizeNullableString(record.operationId, "operationId");
  const kind = normalizeEventKind(record.kind);
  if ((kind === "operation_intent" || kind === "operation_receipt") && operationId === null) {
    throw new TypeError("operation events require a stable operationId");
  }
  const occurredAt = requireNonEmptyString(record.occurredAt, "occurredAt");
  const observedAt = requireNonEmptyString(record.observedAt, "observedAt");
  const sourceSequence = normalizeSourceSequence(record.sourceSequence);
  if (!isJsonValue(record.payload)) throw new TypeError("payload must be strict JsonValue");
  const payload = cloneAndFreezeJson(record.payload);

  return Object.freeze({
    source,
    eventId,
    scope,
    attemptId,
    operationId,
    kind,
    occurredAt,
    observedAt,
    sourceSequence,
    payload,
  }) as NormalizedEvent;
}

/** Canonical JSON with recursively sorted object keys. */
export function canonicalizeJson(value: JsonValue): string {
  if (!isJsonValue(value)) throw new TypeError("value must be strict JsonValue");
  return encodeCanonical(cloneAndFreezeJson(value));
}

/** Stable fact representation; observation metadata and writer sequence are excluded. */
export function canonicalizeEventFacts(event: NormalizedEvent): string {
  const normalized = normalizeRuntimeEvent(event);
  const facts = {
    source: normalized.source,
    eventId: normalized.eventId,
    scope: normalized.scope,
    attemptId: normalized.attemptId,
    operationId: normalized.operationId,
    kind: normalized.kind,
    occurredAt: normalized.occurredAt,
    payload: normalized.payload,
  } as unknown as CanonicalEventFacts;
  return canonicalizeJson(facts as unknown as JsonValue);
}

/**
 * Projects one explicitly bound attempt in writer commit order. Source sequence and
 * timestamps remain evidence; neither can reorder or replace the first terminal.
 */
export function projectAttempt(
  entries: readonly WriterOrderedEvent[],
  target: AttemptProjectionTarget,
): AttemptProjection {
  const normalizedTarget = normalizeProjectionTarget(target);
  if (!Array.isArray(entries)) throw new TypeError("writer events must be an array");

  const ordered: WriterOrderedEvent[] = [];
  const commitFacts = new Map<number, { readonly identity: string; readonly canonicalFacts: string }>();
  for (const entry of entries as readonly unknown[]) {
    if (!hasExactDataFields(entry, WRITER_EVENT_FIELDS)) {
      throw new TypeError("writer event must contain only commitSequence and event");
    }
    const record = entry as Record<string, unknown>;
    const commitSequence = record.commitSequence;
    if (typeof commitSequence !== "number" || !Number.isSafeInteger(commitSequence) || commitSequence <= 0) {
      throw new TypeError("commitSequence must be a positive safe integer");
    }
    const event = normalizeRuntimeEvent(record.event);
    assertBoundScope(event.scope, normalizedTarget.scope);
    const identity = identityKey(event);
    const canonicalFacts = canonicalizeEventFacts(event);
    const prior = commitFacts.get(commitSequence);
    if (prior !== undefined && (prior.identity !== identity || prior.canonicalFacts !== canonicalFacts)) {
      throw new TypeError("writer commit sequence collision between different facts");
    }
    commitFacts.set(commitSequence, { identity, canonicalFacts });
    ordered.push(Object.freeze({ commitSequence, event }));
  }
  ordered.sort((left, right) => left.commitSequence - right.commitSequence);

  const seen = new Map<string, { readonly canonicalFacts: string; readonly event: NormalizedEvent }>();
  const sourceSequenceMax = new Map<string, number>();
  const audit: EventAudit[] = [];
  const accepted: NormalizedEvent[] = [];
  const drafts: NormalizedEvent[] = [];
  let terminal: AttemptTerminal | null = null;

  for (const entry of ordered) {
    const event = entry.event;
    const reference = eventReference(event);
    if (event.sourceSequence !== null) {
      const priorMaximum = sourceSequenceMax.get(event.source);
      if (priorMaximum !== undefined && event.sourceSequence < priorMaximum) {
        audit.push(Object.freeze({
          kind: "source_sequence_regressed",
          event: reference,
          priorMaximum,
          observed: event.sourceSequence,
        }));
      }
      sourceSequenceMax.set(event.source, Math.max(priorMaximum ?? 0, event.sourceSequence));
    }

    const identity = identityKey(event);
    const canonicalFacts = canonicalizeEventFacts(event);
    const prior = seen.get(identity);
    if (prior !== undefined) {
      if (prior.canonicalFacts !== canonicalFacts) {
        audit.push(Object.freeze({ kind: "identity_conflict", event: reference }));
      } else {
        audit.push(Object.freeze({ kind: "duplicate", event: reference }));
        if (prior.event.sourceSequence !== event.sourceSequence) {
          audit.push(Object.freeze({
            kind: "redelivery_resequenced",
            event: reference,
            firstSourceSequence: prior.event.sourceSequence,
            observedSourceSequence: event.sourceSequence,
          }));
        }
      }
      continue;
    }
    seen.set(identity, { canonicalFacts, event });

    if (event.attemptId !== normalizedTarget.attemptId) {
      audit.push(Object.freeze({
        kind: "old_attempt",
        event: reference,
        currentAttemptId: normalizedTarget.attemptId,
      }));
      continue;
    }
    if (terminal !== null) {
      audit.push(Object.freeze({ kind: "after_terminal", event: reference, terminal: terminal.status }));
      continue;
    }

    accepted.push(event);
    if (event.kind === "draft") drafts.push(event);
    if (isTerminalStatus(event.kind)) {
      const authoritativeResponse = event.kind === "success" ? readResponse(event.payload) : null;
      terminal = Object.freeze({
        status: event.kind,
        event: reference,
        commitSequence: entry.commitSequence,
        occurredAt: event.occurredAt,
        authoritativeResponse,
      });
    }
  }

  return Object.freeze({
    attemptId: normalizedTarget.attemptId,
    lifecycle: terminal?.status ?? "in_progress",
    terminal,
    authoritativeResponse: terminal?.authoritativeResponse ?? null,
    events: Object.freeze(accepted),
    drafts: Object.freeze(drafts),
    audit: Object.freeze(audit),
  });
}

const EVENT_FIELDS = [
  "source", "eventId", "scope", "attemptId", "operationId", "kind",
  "occurredAt", "observedAt", "sourceSequence", "payload",
] as const;
const SCOPE_FIELDS = ["sessionId", "turnId", "runId", "taskId"] as const;
const WRITER_EVENT_FIELDS = ["commitSequence", "event"] as const;
const EVENT_KINDS = new Set<RuntimeEventKind>([
  "fact", "draft", "success", "failure", "cancel", "interrupted",
  "operation_intent", "operation_receipt",
]);
const TERMINAL_STATUSES = new Set<TerminalStatus>(["success", "failure", "cancel", "interrupted"]);

function hasExactDataFields(value: unknown, fields: readonly string[]): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== fields.length || ownKeys.some((key) => typeof key !== "string" || !fields.includes(key))) {
      return false;
    }
    return fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function normalizeEventScope(value: unknown): EventScope {
  if (!hasExactDataFields(value, SCOPE_FIELDS)) throw new TypeError("scope has invalid fields");
  const record = value as Record<string, unknown>;
  const normalized = Object.create(null) as Record<string, string | null>;
  for (const field of SCOPE_FIELDS) normalized[field] = normalizeNullableString(record[field], field);
  return Object.freeze(normalized) as unknown as EventScope;
}

function normalizeProjectionTarget(value: AttemptProjectionTarget): {
  readonly scope: BoundEventScope;
  readonly attemptId: string;
} {
  if (!hasExactDataFields(value, ["scope", "attemptId"])) {
    throw new TypeError("projection target has invalid fields");
  }
  const record = value as unknown as Record<string, unknown>;
  const scopeValue = record.scope;
  if (!hasExactDataFields(scopeValue, SCOPE_FIELDS)) throw new TypeError("projection scope has invalid fields");
  const sourceScope = scopeValue as Record<string, unknown>;
  const scope = Object.create(null) as Record<string, string>;
  for (const field of SCOPE_FIELDS) scope[field] = requireNonEmptyString(sourceScope[field], field);
  return Object.freeze({
    scope: Object.freeze(scope) as unknown as BoundEventScope,
    attemptId: requireNonEmptyString(record.attemptId, "attemptId"),
  });
}

function assertBoundScope(actual: EventScope, expected: BoundEventScope): void {
  for (const field of SCOPE_FIELDS) {
    if (actual[field] !== expected[field]) throw new TypeError(`event scope does not match projection ${field}`);
  }
}

function normalizeNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireNonEmptyString(value, label);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeEventKind(value: unknown): RuntimeEventKind {
  if (typeof value !== "string" || !EVENT_KINDS.has(value as RuntimeEventKind)) {
    throw new TypeError("runtime event kind is unsupported");
  }
  return value as RuntimeEventKind;
}

function cloneAndFreezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreezeJson(item)));
  }
  const object = value as { readonly [key: string]: JsonValue };
  const clone = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(object).sort()) clone[key] = cloneAndFreezeJson(object[key]!);
  return Object.freeze(clone);
}

function encodeCanonical(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeCanonical(object[key]!)}`).join(",")}}`;
}

function identityKey(event: SourceEventIdentity): string {
  return canonicalizeJson([event.source, event.eventId]);
}

function eventReference(event: NormalizedEvent): EventReference {
  return Object.freeze({
    source: event.source,
    eventId: event.eventId,
    scope: event.scope,
    attemptId: event.attemptId,
  });
}

function isTerminalStatus(value: RuntimeEventKind): value is TerminalStatus {
  return TERMINAL_STATUSES.has(value as TerminalStatus);
}

function readResponse(payload: JsonValue): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const response = (payload as Record<string, JsonValue>).response;
  return typeof response === "string" ? response : null;
}
