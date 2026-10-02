export type TurnLifecycle = "in_progress" | "completed" | "failed" | "cancelled" | "unknown";
export type EvidenceStatus = "not_required" | "verified" | "partial" | "failed" | "unverified" | "blocked";
export type ToolReceiptStatus = "scheduled" | "running" | "succeeded" | "failed" | "unknown";
export type ReplySource = "turn_result" | "turn_complete" | "stream" | "none";

export interface TurnProjection {
  readonly sessionId: string;
  readonly turnId: string;
  readonly reply: { readonly role: "agent"; readonly text: string; readonly source: ReplySource };
  readonly lifecycle: TurnLifecycle;
  readonly resultType?: string;
  readonly evidenceStatus: EvidenceStatus;
  readonly requiredToolCallIds: readonly string[];
  readonly toolReceipts: readonly {
    readonly toolCallId: string;
    readonly toolName?: string;
    readonly status: ToolReceiptStatus;
    readonly errorType?: string;
  }[];
  readonly hookBlocked: boolean;
}

export interface TurnResultLike {
  readonly response?: unknown;
  readonly turnId?: unknown;
  readonly events?: readonly unknown[];
}

export interface ProjectTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly events?: readonly unknown[];
  readonly turnResult?: TurnResultLike;
  readonly requiredToolCallIds?: readonly string[];
}

interface NativeEvent {
  readonly id?: unknown;
  readonly sessionId?: unknown;
  readonly turnId?: unknown;
  readonly sequenceNumber?: unknown;
  readonly type?: unknown;
  readonly payload?: unknown;
}

interface OrderedEvent {
  readonly event: NativeEvent;
  readonly arrival: number;
  readonly ambiguous?: boolean;
}

interface MutableReceipt {
  toolCallId: string;
  toolName?: string;
  status: ToolReceiptStatus;
  errorType?: string;
  terminalStatus?: "succeeded" | "failed" | "unknown";
}

const TERMINAL_TOOL_STATES = new Set<ToolReceiptStatus>(["succeeded", "failed", "unknown"]);

export function projectTurn(input: ProjectTurnInput): TurnProjection {
  const events = mergeCurrentTurnEvents(input.sessionId, input.turnId, [
    ...(input.events ?? []),
    ...(input.turnResult?.events ?? []),
  ]);
  const receipts = collectToolReceipts(events);
  const requiredToolCallIds = uniqueStrings(input.requiredToolCallIds ?? []);
  const hookBlocked = events.some(({ event }) => event.type === "hook_run_blocked");
  const terminal = latestTerminalEvent(events);
  const resultType = terminal?.event.type === "turn_complete"
    ? stringValue(record(terminal.event.payload)?.resultType)
    : undefined;
  const lifecycle = projectLifecycle(terminal, resultType, input.turnResult, input.turnId);
  const evidenceStatus = projectEvidence(requiredToolCallIds, receipts, hookBlocked);
  const reply = projectReply(events, input.turnResult, input.turnId);

  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    reply: { role: "agent", text: reply.text, source: reply.source },
    lifecycle,
    ...(resultType === undefined ? {} : { resultType }),
    evidenceStatus,
    requiredToolCallIds,
    toolReceipts: receipts.map(({ toolCallId, toolName, status, errorType }) => ({
      toolCallId,
      ...(toolName === undefined ? {} : { toolName }),
      status,
      ...(errorType === undefined ? {} : { errorType }),
    })),
    hookBlocked,
  };
}

/**
 * One short-lived collector per native input. Subscribe before submission, then bind
 * the turn ID returned by sendInput or TurnResult before projecting the turn.
 */
export function createTurnEventCollector(sessionId: string): {
  readonly onSessionEvent: (event: unknown) => void;
  bindTurn(turnId: string): void;
  project(turnResult?: TurnResultLike, requiredToolCallIds?: readonly string[]): TurnProjection;
  close(): void;
} {
  let turnId: string | undefined;
  let closed = false;
  const events: unknown[] = [];

  const onSessionEvent = (event: unknown): void => {
    if (closed || record(event)?.sessionId !== sessionId) return;
    events.push(event);
    if (turnId !== undefined && eventTurnId(record(event)!) !== turnId) events.pop();
  };

  return {
    onSessionEvent,
    bindTurn(nextTurnId: string): void {
      if (closed) throw new Error("turn event collector is closed");
      if (!nextTurnId) throw new Error("turn ID is required");
      if (turnId !== undefined && turnId !== nextTurnId) throw new Error("turn event collector is already bound");
      turnId = nextTurnId;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (eventTurnId(record(events[index])!) !== turnId) events.splice(index, 1);
      }
    },
    project(turnResult?: TurnResultLike, requiredToolCallIds?: readonly string[]): TurnProjection {
      if (closed) throw new Error("turn event collector is closed");
      if (turnId === undefined) throw new Error("bind the native turn ID before projecting");
      return projectTurn({
        sessionId,
        turnId,
        events,
        ...(turnResult === undefined ? {} : { turnResult }),
        ...(requiredToolCallIds === undefined ? {} : { requiredToolCallIds }),
      });
    },
    close(): void {
      closed = true;
      events.length = 0;
    },
  };
}

function mergeCurrentTurnEvents(sessionId: string, turnId: string, values: readonly unknown[]): OrderedEvent[] {
  const deduplicated = new Map<string, OrderedEvent>();
  const unkeyed: OrderedEvent[] = [];
  values.forEach((value, arrival) => {
    const event = record(value) as NativeEvent | undefined;
    if (!event || typeof event.type !== "string") return;
    const ordered: OrderedEvent = { event, arrival };
    const key = eventKey(event);
    if (key === undefined) {
      if (isCurrentTurnEvent(event, sessionId, turnId)) unkeyed.push(ordered);
    } else {
      const prior = deduplicated.get(key);
      if (!prior) deduplicated.set(key, ordered);
      else if (!sameEventFacts(prior.event, event)) {
        deduplicated.set(key, {
          ...preferCurrentTurnEvent(prior, ordered, sessionId, turnId),
          ambiguous: true,
        });
      } else {
        const preferred = preferCommittedSequence(prior, ordered);
        deduplicated.set(key, prior.ambiguous || ordered.ambiguous
          ? { ...preferred, ambiguous: true }
          : preferred);
      }
    }
  });
  return [...deduplicated.values(), ...unkeyed]
    .filter(({ event }) => isCurrentTurnEvent(event, sessionId, turnId))
    .sort((left, right) => {
    const leftSequence = finiteNumber(left.event.sequenceNumber);
    const rightSequence = finiteNumber(right.event.sequenceNumber);
    if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
    if (leftSequence !== undefined && rightSequence === undefined) return -1;
    if (leftSequence === undefined && rightSequence !== undefined) return 1;
    return left.arrival - right.arrival;
    });
}

function eventKey(event: NativeEvent): string | undefined {
  if (typeof event.id === "string" && event.id.length > 0) return `id:${event.id}`;
  const sequence = finiteNumber(event.sequenceNumber);
  if (sequence !== undefined && sequence > 0 && typeof event.sessionId === "string") return `sequence:${event.sessionId}:${sequence}`;
  return undefined;
}

function isCurrentTurnEvent(event: NativeEvent, sessionId: string, turnId: string): boolean {
  return event.sessionId === sessionId && eventTurnId(event) === turnId;
}

function sameEventFacts(left: NativeEvent, right: NativeEvent): boolean {
  const leftPayload = stableJson(left.payload);
  const rightPayload = stableJson(right.payload);
  return leftPayload !== undefined
    && rightPayload !== undefined
    && left.sessionId === right.sessionId
    && left.turnId === right.turnId
    && left.type === right.type
    && leftPayload === rightPayload;
}

function stableJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return nested;
      return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
    });
  } catch {
    return undefined;
  }
}

function preferCurrentTurnEvent(left: OrderedEvent, right: OrderedEvent, sessionId: string, turnId: string): OrderedEvent {
  const leftInScope = isCurrentTurnEvent(left.event, sessionId, turnId);
  const rightInScope = isCurrentTurnEvent(right.event, sessionId, turnId);
  if (leftInScope !== rightInScope) return leftInScope ? left : right;
  const leftIsTerminal = terminalMeaning(left.event) !== undefined;
  const rightIsTerminal = terminalMeaning(right.event) !== undefined;
  if (leftIsTerminal !== rightIsTerminal) return leftIsTerminal ? left : right;
  return preferCommittedSequence(left, right);
}

function preferCommittedSequence(left: OrderedEvent, right: OrderedEvent): OrderedEvent {
  const leftSequence = finiteNumber(left.event.sequenceNumber);
  const rightSequence = finiteNumber(right.event.sequenceNumber);
  const leftCommitted = leftSequence !== undefined && leftSequence > 0;
  const rightCommitted = rightSequence !== undefined && rightSequence > 0;
  if (leftCommitted !== rightCommitted) return leftCommitted ? left : right;
  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
    return leftSequence > rightSequence ? left : right;
  }
  return left;
}

function collectToolReceipts(events: readonly OrderedEvent[]): MutableReceipt[] {
  const receipts = new Map<string, MutableReceipt>();
  for (const { event, ambiguous } of events) {
    const payload = record(event.payload);
    const toolCallId = stringValue(payload?.toolCallId);
    if (toolCallId === undefined) continue;
    const existing = receipts.get(toolCallId);
    const toolName = stringValue(payload?.toolName);

    if (ambiguous && (event.type === "tool_call_result" || event.type === "tool_call_error")) {
      const next = existing ?? { toolCallId, status: "unknown" as const };
      if (toolName !== undefined) next.toolName = toolName;
      next.status = "unknown";
      next.terminalStatus = "unknown";
      receipts.set(toolCallId, next);
      continue;
    }

    if (event.type === "tool_call_scheduled") {
      const next = existing ?? { toolCallId, status: "scheduled" as const };
      if (toolName !== undefined) next.toolName = toolName;
      receipts.set(toolCallId, next);
      continue;
    }
    if (event.type === "tool_call_started" || event.type === "tool_call_progress") {
      const next = existing ?? { toolCallId, status: "running" as const };
      if (toolName !== undefined) next.toolName = toolName;
      if (!TERMINAL_TOOL_STATES.has(next.status)) next.status = "running";
      receipts.set(toolCallId, next);
      continue;
    }
    if (event.type === "tool_call_result") {
      const success = record(payload?.result)?.success;
      const next = existing ?? { toolCallId, status: "unknown" as const };
      if (toolName !== undefined) next.toolName = toolName;
      applyTerminalStatus(next, success === true ? "succeeded" : success === false ? "failed" : "unknown");
      receipts.set(toolCallId, next);
      continue;
    }
    if (event.type === "tool_call_error") {
      const next = existing ?? { toolCallId, status: "failed" as const };
      if (toolName !== undefined) next.toolName = toolName;
      applyTerminalStatus(next, "failed");
      next.errorType = "tool_error";
      receipts.set(toolCallId, next);
    }
  }
  return [...receipts.values()];
}

function applyTerminalStatus(receipt: MutableReceipt, status: "succeeded" | "failed" | "unknown"): void {
  if (receipt.terminalStatus === undefined) {
    receipt.status = status;
    receipt.terminalStatus = status;
    return;
  }
  if (receipt.terminalStatus !== status && receipt.terminalStatus !== "unknown") {
    receipt.status = "unknown";
    receipt.terminalStatus = "unknown";
  }
}

function terminalMeaning(event: NativeEvent): string | undefined {
  const payload = record(event.payload);
  if (event.type === "tool_call_result") {
    const success = record(payload?.result)?.success;
    return `tool:${stringValue(payload?.toolCallId) ?? ""}:${success === true ? "success" : success === false ? "failure" : "unknown"}`;
  }
  if (event.type === "tool_call_error") return `tool:${stringValue(payload?.toolCallId) ?? ""}:failure`;
  if (event.type === "turn_complete") return `turn:${stringValue(payload?.resultType) ?? "unknown"}`;
  if (event.type === "turn_error") return "turn:error";
  return undefined;
}

function latestTerminalEvent(events: readonly OrderedEvent[]): OrderedEvent | undefined {
  let terminal: OrderedEvent | undefined;
  for (const ordered of events) {
    if (ordered.event.type === "turn_complete" || ordered.event.type === "turn_error") terminal = ordered;
  }
  return terminal;
}

function projectLifecycle(
  terminal: OrderedEvent | undefined,
  resultType: string | undefined,
  turnResult: TurnResultLike | undefined,
  turnId: string,
): TurnLifecycle {
  if (terminal?.ambiguous) return "unknown";
  if (terminal?.event.type === "turn_error") return "failed";
  if (terminal?.event.type === "turn_complete") {
    if (resultType === "cancelled") return "cancelled";
    return resultType === "success" ? "completed" : "failed";
  }
  if (turnResult?.turnId === turnId) return "completed";
  return "unknown";
}

function projectEvidence(
  requiredToolCallIds: readonly string[],
  receipts: readonly MutableReceipt[],
  hookBlocked: boolean,
): EvidenceStatus {
  if (hookBlocked) return "blocked";
  if (requiredToolCallIds.length === 0) return "not_required";
  const byId = new Map(receipts.map((receipt) => [receipt.toolCallId, receipt]));
  const required = requiredToolCallIds.map((id) => byId.get(id));
  const succeeded = required.filter((receipt) => receipt?.status === "succeeded").length;
  const failed = required.filter((receipt) => receipt?.status === "failed").length;
  if (succeeded === required.length) return "verified";
  if (succeeded > 0) return "partial";
  if (failed > 0) return "failed";
  return "unverified";
}

function projectReply(
  events: readonly OrderedEvent[],
  turnResult: TurnResultLike | undefined,
  turnId: string,
): { text: string; source: ReplySource } {
  if (turnResult?.turnId === turnId && typeof turnResult.response === "string" && turnResult.response.length > 0) {
    return { text: turnResult.response, source: "turn_result" };
  }
  let completedResponse: string | undefined;
  for (const { event } of events) {
    if (event.type !== "turn_complete") continue;
    const response = stringValue(record(event.payload)?.response);
    if (response !== undefined && response.length > 0) completedResponse = response;
  }
  if (completedResponse !== undefined) return { text: completedResponse, source: "turn_complete" };
  const streamed = collectFinalStreamText(events);
  return streamed.length > 0 ? { text: streamed, source: "stream" } : { text: "", source: "none" };
}

function collectFinalStreamText(events: readonly OrderedEvent[]): string {
  const streams = new Map<string, { text: string; lastSequence: number; arrival: number }>();
  for (const { event, arrival } of events) {
    if (event.type !== "model_streaming") continue;
    const payload = record(event.payload);
    if (!payload || (payload.kind !== undefined && payload.kind !== "text_delta")) continue;
    const delta = stringValue(payload.delta);
    if (delta === undefined || delta.length === 0) continue;
    const id = stringValue(payload.assistantMessageId) ?? "__anonymous__";
    const stream = streams.get(id) ?? {
      text: "",
      lastSequence: finiteNumber(event.sequenceNumber) ?? -1,
      arrival,
    };
    stream.text += delta;
    stream.lastSequence = finiteNumber(event.sequenceNumber) ?? stream.lastSequence;
    streams.set(id, stream);
  }
  return [...streams.values()].sort((left, right) => {
    if (left.lastSequence !== right.lastSequence) return left.lastSequence - right.lastSequence;
    return left.arrival - right.arrival;
  }).at(-1)?.text ?? "";
}

function eventTurnId(event: NativeEvent): string | undefined {
  return stringValue(event.turnId) ?? stringValue(record(event.payload)?.turnId);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
