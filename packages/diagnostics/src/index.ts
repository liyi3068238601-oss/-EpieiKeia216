import { createHash, randomBytes } from "node:crypto";
import {
  canonicalizeEventFacts,
  canonicalizeJson,
  normalizeRuntimeEvent,
  projectAttempt,
  type AttemptProjection,
  type BoundEventScope,
  type NormalizedEvent,
  type RuntimeEventKind,
  type TerminalStatus,
  type WriterOrderedEvent,
} from "../../contracts/src/events.js";
import type { JsonValue } from "../../contracts/src/json-value.js";
import {
  OWNED_ARTIFACT_INTEGRITY_PROFILE,
  type EvidenceReport,
} from "../../application/evidence/src/index.js";
import type {
  EventObservation,
  EventStore,
  ReadPage,
  ReceiptLookup,
} from "../../storage/events/src/index.js";

const REDACTION_POLICY = "turn-diagnostics-allowlist/v2" as const;
const NATIVE_PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const RECOVERY_SOURCE = "xiadie.recovery/v1";
const PAGE_SIZE = 256;
const MAX_PAGES = 32;
const MAX_INPUT_REPORTS = 32;
const MAX_IDENTIFIER_BYTES = 1024;
const MAX_REFERENCE_BYTES = 4096;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const NATIVE_TYPES = ["turn_started", "turn_complete", "turn_error", "tool_call_started", "tool_call_result", "tool_call_error",
  "hook_run_started", "hook_run_completed", "hook_run_failed", "hook_run_blocked"] as const;

export type DiagnosticShaRef = string & { readonly __brand: "DiagnosticShaRef" };

export type DiagnosticCode =
  | "EVIDENCE_SCOPE_MISMATCH"
  | "EVENT_STORE_CORRUPT"
  | "PAGE_LIMIT"
  | "CURSOR_STALLED"
  | "SOURCE_NOT_VERIFIED"
  | "PROCESS_FAILED"
  | "ARTIFACT_MISSING"
  | "TOOL_RECEIPT_MISSING"
  | "TOOL_RECEIPT_INVALID"
  | "TOOL_RECEIPT_UNVERIFIED"
  | "COMMAND_NOT_VERIFIED"
  | "OTHER";

export type DiagnosticScanStatus = "complete" | "partial";
export type DiagnosticLifecycle = TerminalStatus | "in_progress" | "unavailable";

export interface BuildTurnDiagnosticsInput {
  readonly scope: BoundEventScope;
  readonly attemptId: string;
  readonly store: Readonly<Pick<EventStore, "read" | "readObservations" | "queryReceipt">>;
  readonly evidenceReports?: readonly EvidenceReport[];
  /** Reference-only annotations, not committed memories or candidate content. */
  readonly memoryCandidates?: readonly DiagnosticMemoryCandidateInput[];
}

export interface DiagnosticMemoryCandidateInput {
  readonly candidateId: string;
  readonly scope: BoundEventScope;
  readonly attemptId: string;
  readonly sources: readonly Readonly<{ source: string; eventId: string }>[];
}

export interface DiagnosticCommandSummary {
  readonly status: "verified" | "unverified" | "unavailable";
  readonly kind: "node-script" | null;
  readonly nodeVersion: string | null;
  readonly scriptRef: DiagnosticShaRef | null;
  readonly argumentCount: number | null;
}

export interface DiagnosticEvidenceSummary {
  readonly profile: typeof OWNED_ARTIFACT_INTEGRITY_PROFILE | "unknown";
  readonly operationRef: DiagnosticShaRef | null;
  readonly toolCallRef: DiagnosticShaRef | null;
  readonly execution: Readonly<{
    readonly status: "passed" | "failed" | "unverified";
    readonly exitCode: number | null;
    readonly stdout: Readonly<{ readonly bytes: number; readonly sha256Ref: DiagnosticShaRef }> | null;
    readonly stderr: Readonly<{ readonly bytes: number; readonly sha256Ref: DiagnosticShaRef }> | null;
    readonly command: DiagnosticCommandSummary;
  }>;
  readonly toolReceipt: Readonly<{
    readonly status: "verified" | "missing" | "invalid" | "unverified";
    readonly eventRef: DiagnosticShaRef | null;
    readonly commitSequence: number | null;
    readonly canonicalHashRef: DiagnosticShaRef | null;
  }>;
  readonly artifact: Readonly<{
    readonly status: "verified" | "missing" | "unreadable";
    readonly artifactRef: DiagnosticShaRef | null;
    readonly bytes: number | null;
    readonly sha256Ref: DiagnosticShaRef | null;
  }>;
  readonly sourceRevision: "verified" | "mismatch" | "unavailable";
  readonly profileResult: "passed" | "failed" | "blocked";
  readonly codes: readonly DiagnosticCode[];
}

export interface DiagnosticFactSummary {
  readonly eventRef: DiagnosticShaRef;
  readonly operationRef: DiagnosticShaRef | null;
  readonly kind: RuntimeEventKind;
  readonly commitSequence: number;
  readonly category: "message" | "tool" | "runtime" | "operation" | "other";
  readonly nativeType: typeof NATIVE_TYPES[number] | null;
  readonly tool: Readonly<{ readonly name: "Read" | "other"; readonly status: "started" | "result" | "error";
    readonly toolCallRef: DiagnosticShaRef | null }> | null;
}

export interface DiagnosticObservationSummary {
  readonly eventRef: DiagnosticShaRef;
  readonly observationRef: DiagnosticShaRef;
  readonly disposition: EventObservation["disposition"];
  readonly commitSequence: number;
  readonly candidateHashRef: DiagnosticShaRef;
}

export interface DiagnosticCaptureSummary {
  readonly eventRef: DiagnosticShaRef;
  readonly observationRef: DiagnosticShaRef;
  readonly hookEventName: "UserPromptSubmit" | "Stop";
  readonly messageCount: 1;
  readonly byteCounts: readonly number[];
  readonly snapshotSha256Ref: DiagnosticShaRef;
  readonly rawSource: Readonly<{
    readonly historicalSha256Ref: DiagnosticShaRef;
    readonly bytes: number;
    readonly currentValidation: "NOT_VERIFIED";
  }>;
}

export interface TurnDiagnosticsReport {
  readonly schemaVersion: 1;
  readonly redactionPolicy: typeof REDACTION_POLICY;
  readonly scopeRefs: Readonly<Record<"session" | "turn" | "run" | "task", DiagnosticShaRef>>;
  readonly attemptRef: DiagnosticShaRef;
  readonly sourceVersion: Readonly<{
    readonly acceptedNative40Pin: string | null;
    readonly adapter: "recovery-v1" | "unknown";
    readonly otherSourcePins: readonly DiagnosticShaRef[];
  }>;
  readonly evidenceReports: readonly DiagnosticEvidenceSummary[];
  readonly facts: readonly DiagnosticFactSummary[];
  readonly observations: readonly DiagnosticObservationSummary[];
  readonly captures: readonly DiagnosticCaptureSummary[];
  readonly memoryCandidates: readonly Readonly<{ candidateRef: DiagnosticShaRef; kind: "reference-annotation";
    sourceStatus: "matched" | "missing" | "outside_attempt" | "unavailable";
    sources: readonly Readonly<{ eventRef: DiagnosticShaRef; status: "matched" | "not_found" | "outside_attempt" | "unavailable" }>[] }>[];
  readonly lifecycle: DiagnosticLifecycle;
  readonly terminalEventRef: DiagnosticShaRef | null;
  readonly codes: readonly DiagnosticCode[];
  readonly pageScan: Readonly<{ readonly facts: DiagnosticScanStatus; readonly observations: DiagnosticScanStatus }>;
  readonly turnSeal: "unavailable";
}

export type BuildTurnDiagnosticsResult =
  | Readonly<{ readonly status: "built"; readonly report: TurnDiagnosticsReport }>
  | Readonly<{ readonly status: "rejected"; readonly code: "EVIDENCE_SCOPE_MISMATCH" | "CANDIDATE_SCOPE_MISMATCH" }>;

interface NormalizedInput {
  readonly scope: BoundEventScope;
  readonly attemptId: string;
  readonly store: BuildTurnDiagnosticsInput["store"];
  readonly evidenceReports: readonly EvidenceReport[];
  readonly memoryCandidates: readonly DiagnosticMemoryCandidateInput[];
}

interface FactScan {
  readonly entries: WriterOrderedEvent[];
  readonly factByIdentity: Map<string, WriterOrderedEvent>;
  readonly complete: boolean;
}

interface ObservationScan {
  readonly items: EventObservation[];
  readonly complete: boolean;
  readonly acceptedNativePin: boolean;
  readonly recoveryAdapter: boolean;
  readonly otherSourcePinRefs: Set<DiagnosticShaRef>;
}

interface ReportSalt {
  readonly bytes: Buffer;
}

/** Builds a report-local, allowlisted view of a bound attempt and its persisted evidence. */
export async function buildTurnDiagnostics(input: BuildTurnDiagnosticsInput): Promise<BuildTurnDiagnosticsResult> {
  const normalized = normalizeInput(input);
  if (normalized.evidenceReports.some((report) => evidenceScopeMismatch(report, normalized.scope, normalized.attemptId))) {
    return Object.freeze({ status: "rejected", code: "EVIDENCE_SCOPE_MISMATCH" });
  }
  if (normalized.memoryCandidates.some((candidate) => evidenceScopeMismatch(candidate, normalized.scope, normalized.attemptId))) {
    return Object.freeze({ status: "rejected", code: "CANDIDATE_SCOPE_MISMATCH" });
  }

  const salt: ReportSalt = Object.freeze({ bytes: randomBytes(32) });
  const codes = new Set<DiagnosticCode>();
  const facts = scanFacts(normalized.store, normalized.scope, codes);
  const observations = scanObservations(normalized.store, normalized.scope, normalized.attemptId, facts, salt, codes);

  let projection: AttemptProjection | undefined;
  let factScanComplete = facts.complete;
  if (facts.complete) {
    try {
      projection = projectAttempt(facts.entries, { scope: normalized.scope, attemptId: normalized.attemptId });
    } catch {
      factScanComplete = false;
      codes.add("EVENT_STORE_CORRUPT");
    }
  }

  const evidenceSummaries = normalized.evidenceReports.map((report) =>
    summarizeEvidence(report, normalized.scope, normalized.attemptId, facts, normalized.store, salt, codes));
  if (evidenceSummaries.some((summary) => summary.codes.includes("EVENT_STORE_CORRUPT"))) factScanComplete = false;

  const observationsByIdentity = new Map<string, EventObservation[]>();
  for (const observation of observations.items) {
    const key = identityKey(observation.event);
    const items = observationsByIdentity.get(key) ?? [];
    items.push(observation);
    observationsByIdentity.set(key, items);
  }
  const factSummaries = facts.entries
    .filter(({ event }) => event.attemptId === normalized.attemptId && matchesScope(event.scope, normalized.scope))
    .map(({ event, commitSequence }) => Object.freeze({
      eventRef: eventRef(salt, event),
      operationRef: event.operationId === null ? null : opaqueRef(salt, "operation", event.operationId),
      kind: event.kind,
      commitSequence,
      ...summarizeFactType(event, observationsByIdentity.get(identityKey(event)) ?? [], salt),
    }));

  const targetObservations = observations.items.filter(({ event }) =>
    event.attemptId === normalized.attemptId && matchesScope(event.scope, normalized.scope));
  const observationSummaries = targetObservations.map((item) => Object.freeze({
    eventRef: eventRef(salt, item.event),
    observationRef: opaqueRef(salt, "observation", item.observationKey),
    disposition: item.disposition,
    commitSequence: item.commitSequence,
    candidateHashRef: opaqueRef(salt, "candidate-hash", item.candidateHash),
  }));
  const captures = targetObservations.flatMap((item) => {
    const capture = item.capture;
    if (capture === undefined) return [];
    const message = capture.snapshot.messages[0];
    if (message === undefined) {
      codes.add("EVENT_STORE_CORRUPT");
      return [];
    }
    return [Object.freeze({
      eventRef: eventRef(salt, item.event),
      observationRef: opaqueRef(salt, "observation", item.observationKey),
      hookEventName: capture.hookEventName,
      messageCount: 1 as const,
      byteCounts: Object.freeze([message.textBytes]),
      snapshotSha256Ref: opaqueRef(salt, "snapshot-hash", capture.snapshotSha256),
      rawSource: Object.freeze({
        historicalSha256Ref: opaqueRef(salt, "historical-source-hash", capture.origin.rawSha256),
        bytes: capture.origin.rawBytes,
        currentValidation: "NOT_VERIFIED" as const,
      }),
    })];
  });

  let lifecycle: DiagnosticLifecycle = "unavailable";
  let terminalEventRef: DiagnosticShaRef | null = null;
  const hasTargetAttempt = facts.entries.some(({ event }) =>
    event.attemptId === normalized.attemptId && matchesScope(event.scope, normalized.scope));
  if (factScanComplete && projection !== undefined && hasTargetAttempt) {
    lifecycle = projection.lifecycle;
    if (projection.terminal !== null) terminalEventRef = eventRefFromIdentity(salt, projection.terminal.event.source, projection.terminal.event.eventId);
  }

  const sourceVersion = sourceVersionSummary(observations, salt, codes);
  const report: TurnDiagnosticsReport = Object.freeze({
    schemaVersion: 1,
    redactionPolicy: REDACTION_POLICY,
    scopeRefs: Object.freeze({
      session: opaqueRef(salt, "scope:session", normalized.scope.sessionId),
      turn: opaqueRef(salt, "scope:turn", normalized.scope.turnId),
      run: opaqueRef(salt, "scope:run", normalized.scope.runId),
      task: opaqueRef(salt, "scope:task", normalized.scope.taskId),
    }),
    attemptRef: opaqueRef(salt, "attempt", normalized.attemptId),
    sourceVersion,
    evidenceReports: Object.freeze(evidenceSummaries),
    facts: Object.freeze(factSummaries),
    observations: Object.freeze(observationSummaries),
    captures: Object.freeze(captures),
    memoryCandidates: Object.freeze(normalized.memoryCandidates.map((candidate) => {
      const sources = candidate.sources.map((source) => {
        const found = facts.factByIdentity.get(identityKey(source));
        const status = found !== undefined
          ? found.event.attemptId === normalized.attemptId ? "matched" as const : "outside_attempt" as const
          : factScanComplete ? "not_found" as const : "unavailable" as const;
        return Object.freeze({ eventRef: eventRefFromIdentity(salt, source.source, source.eventId), status });
      });
      const sourceStatus = !factScanComplete ? "unavailable" as const
        : sources.some((source) => source.status === "outside_attempt") ? "outside_attempt" as const
        : sources.some((source) => source.status !== "matched") ? "missing" as const : "matched" as const;
      return Object.freeze({ candidateRef: opaqueRef(salt, "memory-candidate", candidate.candidateId),
        kind: "reference-annotation" as const, sourceStatus, sources: Object.freeze(sources) });
    })),
    lifecycle,
    terminalEventRef,
    codes: Object.freeze([...codes]),
    pageScan: Object.freeze({ facts: factScanComplete ? "complete" : "partial", observations: observations.complete ? "complete" : "partial" }),
    turnSeal: "unavailable",
  });
  return Object.freeze({ status: "built", report });
}

function normalizeInput(value: BuildTurnDiagnosticsInput): NormalizedInput {
  if (!hasExactDataFields(value, ["scope", "attemptId", "store"], ["evidenceReports", "memoryCandidates"])) {
    throw new TypeError("diagnostics input has invalid fields");
  }
  const scopeValue = ownData(value, "scope");
  if (!hasExactDataFields(scopeValue, ["sessionId", "turnId", "runId", "taskId"])) {
    throw new TypeError("diagnostics scope is invalid");
  }
  const sessionId = boundedIdentifier(ownData(scopeValue, "sessionId"));
  const turnId = boundedIdentifier(ownData(scopeValue, "turnId"));
  const runId = boundedIdentifier(ownData(scopeValue, "runId"));
  const taskId = boundedIdentifier(ownData(scopeValue, "taskId"));
  if (sessionId === null || turnId === null || runId === null || taskId === null) {
    throw new TypeError("diagnostics scope identifiers are invalid");
  }
  const scope = Object.freeze({
    sessionId,
    turnId,
    runId,
    taskId,
  });
  const attemptId = boundedIdentifier(ownData(value, "attemptId"));
  if (attemptId === null) throw new TypeError("diagnostics attemptId is invalid");
  const storeValue = ownData(value, "store");
  if (!isRecord(storeValue) || typeof ownData(storeValue, "read") !== "function" ||
      typeof ownData(storeValue, "readObservations") !== "function" || typeof ownData(storeValue, "queryReceipt") !== "function") {
    throw new TypeError("diagnostics store is invalid");
  }
  const reportsValue = ownData(value, "evidenceReports");
  const evidenceReports = reportsValue === undefined ? [] : reportsValue;
  if (!Array.isArray(evidenceReports) || evidenceReports.length > MAX_INPUT_REPORTS) {
    throw new TypeError("diagnostics evidenceReports are invalid or exceed the fixed bound");
  }
  const candidates = ownData(value, "memoryCandidates") ?? [];
  if (!Array.isArray(candidates) || candidates.length > MAX_INPUT_REPORTS) throw new TypeError("memoryCandidates exceed the fixed bound");
  const memoryCandidates = Array.from({ length: candidates.length }, (_, index): DiagnosticMemoryCandidateInput => {
    const candidate = candidates[index];
    if (!hasExactDataFields(candidate, ["candidateId", "scope", "attemptId", "sources"])) throw new TypeError("invalid memory candidate annotation");
    const candidateId = boundedIdentifier(ownData(candidate, "candidateId"));
    const candidateAttempt = boundedIdentifier(ownData(candidate, "attemptId"));
    const candidateScope = ownData(candidate, "scope");
    if (candidateId === null || candidateAttempt === null ||
        !hasExactDataFields(candidateScope, ["sessionId", "turnId", "runId", "taskId"]) ||
        ["sessionId", "turnId", "runId", "taskId"].some((key) => boundedIdentifier(ownData(candidateScope, key)) === null)) {
      throw new TypeError("invalid memory candidate scope");
    }
    const sourceValues = ownData(candidate, "sources");
    if (!Array.isArray(sourceValues) || sourceValues.length === 0 || sourceValues.length > MAX_INPUT_REPORTS) throw new TypeError("invalid candidate sources");
    const sources = Array.from({ length: sourceValues.length }, (_, sourceIndex) => {
      const source = sourceValues[sourceIndex];
      if (!hasExactDataFields(source, ["source", "eventId"])) throw new TypeError("invalid candidate source identity");
      const namespace = boundedIdentifier(ownData(source, "source"));
      const eventId = boundedIdentifier(ownData(source, "eventId"));
      if (namespace === null || eventId === null) throw new TypeError("invalid candidate source identity");
      return Object.freeze({ source: namespace, eventId });
    });
    return Object.freeze({ candidateId, attemptId: candidateAttempt,
      scope: Object.freeze({ sessionId: ownData(candidateScope, "sessionId") as string, turnId: ownData(candidateScope, "turnId") as string,
        runId: ownData(candidateScope, "runId") as string, taskId: ownData(candidateScope, "taskId") as string }), sources: Object.freeze(sources) });
  });
  return Object.freeze({ scope, attemptId, store: storeValue as NormalizedInput["store"], evidenceReports, memoryCandidates: Object.freeze(memoryCandidates) });
}

function summarizeFactType(event: NormalizedEvent, observations: readonly EventObservation[], salt: ReportSalt)
  : Pick<DiagnosticFactSummary, "category" | "nativeType" | "tool"> {
  const canonicalHash = hashCanonicalFacts(event);
  const matching = observations.filter((observation) => observation.disposition !== "identity_conflict" && observation.candidateHash === canonicalHash);
  const payload = safeRecord(event.payload);
  const rawType = ownData(payload, "nativeType");
  const nativeType = event.source === "zcode.native/v1" && matching.some((item) => item.origin.sourcePin === NATIVE_PIN) &&
    typeof rawType === "string" && (NATIVE_TYPES as readonly string[]).includes(rawType)
    ? rawType as typeof NATIVE_TYPES[number] : null;
  let tool: DiagnosticFactSummary["tool"] = null;
  if (nativeType === "tool_call_started" || nativeType === "tool_call_result" || nativeType === "tool_call_error") {
    const callId = boundedIdentifier(ownData(payload, "toolCallId"));
    tool = Object.freeze({ name: ownData(payload, "toolName") === "Read" ? "Read" : "other",
      status: nativeType === "tool_call_started" ? "started" : nativeType === "tool_call_result" ? "result" : "error",
      toolCallRef: callId === null ? null : opaqueRef(salt, "tool-call", callId) });
  }
  const message = matching.some((item) => item.capture !== undefined) ||
    (nativeType === "turn_complete" && event.kind === "success");
  const category = tool !== null ? "tool" as const : message ? "message" as const : nativeType !== null ? "runtime" as const
    : event.operationId !== null ? "operation" as const : "other" as const;
  return Object.freeze({ category, nativeType, tool });
}

function scanFacts(
  store: NormalizedInput["store"],
  scope: BoundEventScope,
  codes: Set<DiagnosticCode>,
): FactScan {
  const entries: WriterOrderedEvent[] = [];
  const factByIdentity = new Map<string, WriterOrderedEvent>();
  let complete = true;
  let afterCommitSequence = 0;
  let totalBytes = 0;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const pageStartCursor = afterCommitSequence;
    let page: ReadPage<WriterOrderedEvent>;
    try {
      page = store.read({ scope, afterCommitSequence, limit: PAGE_SIZE });
    } catch {
      codes.add("EVENT_STORE_CORRUPT");
      complete = false;
      break;
    }
    if (!validPageShape(page, PAGE_SIZE)) {
      codes.add("EVENT_STORE_CORRUPT");
      complete = false;
      break;
    }
    let stalled = page.hasMore && page.items.length === 0;
    for (const item of page.items) {
      try {
        const entry = normalizeWriterEntry(item, afterCommitSequence, scope);
        const identity = identityKey(entry.event);
        if (factByIdentity.has(identity)) {
          codes.add("EVENT_STORE_CORRUPT");
          complete = false;
          break;
        }
        const eventBytes = Buffer.byteLength(canonicalizeJson(entry.event as unknown as JsonValue), "utf8");
        totalBytes += eventBytes;
        if (totalBytes > MAX_SCAN_BYTES) {
          codes.add("PAGE_LIMIT");
          complete = false;
          break;
        }
        let receipt: ReceiptLookup;
        try {
          receipt = store.queryReceipt({ source: entry.event.source, eventId: entry.event.eventId });
        } catch {
          codes.add("EVENT_STORE_CORRUPT");
          complete = false;
          break;
        }
        if (!receiptMatchesFact(receipt, entry)) {
          codes.add("EVENT_STORE_CORRUPT");
          complete = false;
          break;
        }
        entries.push(entry);
        factByIdentity.set(identity, entry);
        afterCommitSequence = entry.commitSequence;
      } catch {
        codes.add("EVENT_STORE_CORRUPT");
        complete = false;
        break;
      }
    }
    if (!complete) break;
    if (page.hasMore) {
      if (stalled || page.nextAfterCommitSequence === null || page.nextAfterCommitSequence <= pageStartCursor ||
          page.nextAfterCommitSequence !== afterCommitSequence) {
        codes.add("CURSOR_STALLED");
        complete = false;
        break;
      }
      if (pageIndex === MAX_PAGES - 1) {
        codes.add("PAGE_LIMIT");
        complete = false;
        break;
      }
      continue;
    }
    if (page.nextAfterCommitSequence !== null) {
      codes.add("EVENT_STORE_CORRUPT");
      complete = false;
    }
    break;
  }
  return { entries, factByIdentity, complete };
}

function scanObservations(
  store: NormalizedInput["store"],
  scope: BoundEventScope,
  attemptId: string,
  facts: FactScan,
  salt: ReportSalt,
  codes: Set<DiagnosticCode>,
): ObservationScan {
  const items: EventObservation[] = [];
  const otherSourcePinRefs = new Set<DiagnosticShaRef>();
  let complete = true;
  let afterCommitSequence = 0;
  let totalBytes = 0;
  let acceptedNativePin = false;
  let recoveryAdapter = false;

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const pageStartCursor = afterCommitSequence;
    let page: ReadPage<EventObservation>;
    try {
      page = store.readObservations({ scope, afterCommitSequence, limit: PAGE_SIZE });
    } catch {
      codes.add("EVENT_STORE_CORRUPT");
      complete = false;
      break;
    }
    if (!validPageShape(page, PAGE_SIZE)) {
      codes.add("EVENT_STORE_CORRUPT");
      complete = false;
      break;
    }
    let stalled = page.hasMore && page.items.length === 0;
    for (const raw of page.items) {
      try {
        const item = normalizeObservation(raw, afterCommitSequence, scope, facts);
        const eventBytes = Buffer.byteLength(canonicalizeJson(item as unknown as JsonValue), "utf8");
        totalBytes += eventBytes;
        if (totalBytes > MAX_SCAN_BYTES) {
          codes.add("PAGE_LIMIT");
          complete = false;
          break;
        }
        if (item.event.attemptId === attemptId) {
          const pin = boundedString(item.origin.sourcePin, MAX_IDENTIFIER_BYTES);
          if (pin === NATIVE_PIN) acceptedNativePin = true;
          else if (pin === RECOVERY_SOURCE && item.event.source === RECOVERY_SOURCE) recoveryAdapter = true;
          else if (pin !== null) otherSourcePinRefs.add(opaqueRef(salt, "source-pin", pin));
          items.push(item);
        }
        afterCommitSequence = item.commitSequence;
      } catch {
        codes.add("EVENT_STORE_CORRUPT");
        complete = false;
        break;
      }
    }
    if (!complete) break;
    if (page.hasMore) {
      if (stalled || page.nextAfterCommitSequence === null || page.nextAfterCommitSequence <= pageStartCursor ||
          page.nextAfterCommitSequence !== afterCommitSequence) {
        codes.add("CURSOR_STALLED");
        complete = false;
        break;
      }
      if (pageIndex === MAX_PAGES - 1) {
        codes.add("PAGE_LIMIT");
        complete = false;
        break;
      }
      continue;
    }
    if (page.nextAfterCommitSequence !== null) {
      codes.add("EVENT_STORE_CORRUPT");
      complete = false;
    }
    break;
  }
  if (otherSourcePinRefs.size > 0) codes.add("SOURCE_NOT_VERIFIED");
  return { items, complete, acceptedNativePin, recoveryAdapter, otherSourcePinRefs };
}

function summarizeEvidence(
  value: EvidenceReport,
  scope: BoundEventScope,
  attemptId: string,
  facts: FactScan,
  store: NormalizedInput["store"],
  salt: ReportSalt,
  codes: Set<DiagnosticCode>,
): DiagnosticEvidenceSummary {
  const localCodes = new Set<DiagnosticCode>();
  const report = value as unknown as Record<string, unknown>;
  const profileValue = ownData(report, "profile");
  const profile = profileValue === OWNED_ARTIFACT_INTEGRITY_PROFILE ? OWNED_ARTIFACT_INTEGRITY_PROFILE : "unknown";
  if (profile === "unknown") localCodes.add("OTHER");

  const operationId = boundedString(ownData(report, "operationId"), MAX_IDENTIFIER_BYTES);
  const toolCallId = boundedString(ownData(report, "toolCallId"), MAX_IDENTIFIER_BYTES);
  const execution = safeRecord(ownData(report, "execution"));
  const executionStatus = closedValue(ownData(execution, "status"), ["passed", "failed", "unverified"] as const, "unverified");
  const exitCode = safeIntegerOrNull(ownData(execution, "exitCode"));
  const stdout = summarizeDigest(ownData(execution, "stdout"), salt, "stdout", localCodes);
  const stderr = summarizeDigest(ownData(execution, "stderr"), salt, "stderr", localCodes);
  if (executionStatus === "failed") localCodes.add("PROCESS_FAILED");
  if (executionStatus === "unverified") localCodes.add("OTHER");

  const rawToolReceipt = safeRecord(ownData(report, "toolReceipt"));
  const declaredReceiptStatus = closedValue(ownData(rawToolReceipt, "status"), ["verified", "missing", "invalid"] as const, "invalid");
  const receiptSource = boundedString(ownData(rawToolReceipt, "source"), MAX_IDENTIFIER_BYTES);
  const receiptEventId = boundedString(ownData(rawToolReceipt, "eventId"), MAX_IDENTIFIER_BYTES);
  const receiptCommitSequence = safePositiveIntegerOrNull(ownData(rawToolReceipt, "commitSequence"));
  const receiptCanonicalHash = normalizedSha256(ownData(rawToolReceipt, "canonicalHash"));
  let receiptStatus: DiagnosticEvidenceSummary["toolReceipt"]["status"] = declaredReceiptStatus;
  let receiptEventRef: DiagnosticShaRef | null = null;
  let receiptSequence: number | null = null;
  let receiptHashRef: DiagnosticShaRef | null = null;
  let matchedReceiptCommand: unknown;
  if (declaredReceiptStatus === "missing") {
    localCodes.add("TOOL_RECEIPT_MISSING");
  } else if (declaredReceiptStatus === "invalid") {
    localCodes.add("TOOL_RECEIPT_INVALID");
  } else if (receiptSource === null || receiptEventId === null || receiptCommitSequence === null || receiptCanonicalHash === null) {
    receiptStatus = "invalid";
    localCodes.add("TOOL_RECEIPT_INVALID");
  } else {
    const identity = identityKeyFromStrings(receiptSource, receiptEventId);
    let lookup: ReceiptLookup | undefined;
    let queryFailed = false;
    try {
      lookup = store.queryReceipt({ source: receiptSource, eventId: receiptEventId });
    } catch {
      localCodes.add("EVENT_STORE_CORRUPT");
      codes.add("EVENT_STORE_CORRUPT");
      queryFailed = true;
    }
    const fact = facts.factByIdentity.get(identity);
    const firstReceipt = lookup?.status === "found" ? lookup.firstReceipt : undefined;
    const receiptPayload = fact === undefined ? Object.create(null) as Record<string, unknown> : safeRecord(fact.event.payload);
    const receiptResult = safeRecord(ownData(receiptPayload, "result"));
    const valid = lookup?.status === "found" && firstReceipt !== undefined && fact !== undefined &&
      matchesScope(fact.event.scope, scope) && fact.event.attemptId === attemptId &&
      fact.event.kind === "operation_receipt" && fact.event.operationId === operationId &&
      ownData(receiptPayload, "operationId") === operationId && ownData(receiptPayload, "status") === "success" &&
      ownData(receiptResult, "toolCallId") === toolCallId &&
      firstReceipt.source === receiptSource && firstReceipt.eventId === receiptEventId &&
      firstReceipt.commitSequence === fact.commitSequence && firstReceipt.commitSequence === receiptCommitSequence &&
      firstReceipt.canonicalHash.toLowerCase() === receiptCanonicalHash &&
      receiptCanonicalHash === hashCanonicalFacts(fact.event);
    if (queryFailed || (lookup === undefined) ||
        (lookup.status === "found" && fact === undefined && !facts.complete)) {
      receiptStatus = "unverified";
      localCodes.add("TOOL_RECEIPT_UNVERIFIED");
    } else if (lookup.status === "not_found") {
      receiptStatus = "missing";
      localCodes.add("TOOL_RECEIPT_MISSING");
    } else if (!valid) {
      receiptStatus = "invalid";
      localCodes.add("TOOL_RECEIPT_INVALID");
    } else {
      receiptEventRef = eventRef(salt, fact.event);
      receiptSequence = firstReceipt.commitSequence;
      receiptHashRef = opaqueRef(salt, "receipt-canonical-hash", firstReceipt.canonicalHash);
      matchedReceiptCommand = ownData(receiptResult, "command");
    }
  }

  const artifact = safeRecord(ownData(report, "artifact"));
  const artifactStatus = closedValue(ownData(artifact, "status"), ["verified", "missing", "unreadable"] as const, "unreadable");
  const artifactLocator = boundedString(ownData(artifact, "locator"), MAX_REFERENCE_BYTES);
  const artifactBytes = safeNonNegativeIntegerOrNull(ownData(artifact, "bytes"));
  const artifactSha = normalizedSha256(ownData(artifact, "sha256"));
  const artifactRef = artifactLocator === null ? null : opaqueRef(salt, "artifact-locator", artifactLocator);
  const artifactHashRef = artifactSha === null ? null : opaqueRef(salt, "artifact-sha256", artifactSha);
  if (artifactStatus === "missing") localCodes.add("ARTIFACT_MISSING");
  else if (artifactStatus === "unreadable") localCodes.add("OTHER");

  const sourceRevisionRecord = safeRecord(ownData(report, "sourceRevision"));
  const sourceRevision = closedValue(ownData(sourceRevisionRecord, "status"), ["verified", "mismatch", "unavailable"] as const, "unavailable");
  if (sourceRevision !== "verified") localCodes.add("SOURCE_NOT_VERIFIED");

  const profileResultRecord = safeRecord(ownData(report, "profileResult"));
  const profileResult = closedValue(ownData(profileResultRecord, "status"), ["passed", "failed", "blocked"] as const, "blocked");
  const reasonValues = ownData(profileResultRecord, "reasons");
  if (Array.isArray(reasonValues)) {
    for (const reason of reasonValues.slice(0, 64)) localCodes.add(mapEvidenceReason(reason));
  } else {
    localCodes.add("OTHER");
  }
  if (profileResult === "failed" && localCodes.size === 0) localCodes.add("OTHER");
  const command = summarizeCommand(profile === OWNED_ARTIFACT_INTEGRITY_PROFILE ? ownData(execution, "command") : undefined,
    matchedReceiptCommand, salt, localCodes);
  for (const code of localCodes) codes.add(code);

  return Object.freeze({
    profile,
    operationRef: operationId === null ? null : opaqueRef(salt, "operation", operationId),
    toolCallRef: toolCallId === null ? null : opaqueRef(salt, "tool-call", toolCallId),
    execution: Object.freeze({
      status: executionStatus,
      exitCode,
      stdout,
      stderr,
      command,
    }),
    toolReceipt: Object.freeze({
      status: receiptStatus,
      eventRef: receiptEventRef,
      commitSequence: receiptSequence,
      canonicalHashRef: receiptHashRef,
    }),
    artifact: Object.freeze({ status: artifactStatus, artifactRef, bytes: artifactBytes, sha256Ref: artifactHashRef }),
    sourceRevision,
    profileResult,
    codes: Object.freeze([...localCodes]),
  });
}

function summarizeCommand(value: unknown, committed: unknown, salt: ReportSalt, codes: Set<DiagnosticCode>): DiagnosticCommandSummary {
  const unavailable = (status: "unverified" | "unavailable"): DiagnosticCommandSummary =>
    Object.freeze({ status, kind: null, nodeVersion: null, scriptRef: null, argumentCount: null });
  if (value === null || value === undefined) return unavailable("unavailable");
  const valid = (item: unknown) => hasExactDataFields(item, ["kind", "nodeVersion", "scriptSha256", "argumentCount"]) &&
    ownData(item, "kind") === "node-script" && typeof ownData(item, "nodeVersion") === "string" &&
    /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ownData(item, "nodeVersion") as string) &&
    normalizedSha256(ownData(item, "scriptSha256")) !== null && safeNonNegativeIntegerOrNull(ownData(item, "argumentCount")) !== null;
  if (!valid(value) || !valid(committed) ||
      ["kind", "nodeVersion", "scriptSha256", "argumentCount"].some((key) => ownData(value, key) !== ownData(committed, key))) {
    codes.add("COMMAND_NOT_VERIFIED");
    return unavailable("unverified");
  }
  return Object.freeze({ status: "verified", kind: "node-script", nodeVersion: ownData(value, "nodeVersion") as string,
    scriptRef: opaqueRef(salt, "command:script", ownData(value, "scriptSha256") as string),
    argumentCount: ownData(value, "argumentCount") as number });
}

function summarizeDigest(
  value: unknown,
  salt: ReportSalt,
  domain: "stdout" | "stderr",
  codes: Set<DiagnosticCode>,
): Readonly<{ readonly bytes: number; readonly sha256Ref: DiagnosticShaRef }> | null {
  if (value === null) return null;
  const digest = safeRecord(value);
  const bytes = safeNonNegativeIntegerOrNull(ownData(digest, "bytes"));
  const sha = normalizedSha256(ownData(digest, "sha256"));
  if (bytes === null || sha === null) {
    codes.add("OTHER");
    return null;
  }
  return Object.freeze({ bytes, sha256Ref: opaqueRef(salt, `${domain}-sha256`, `${bytes}:${sha}`) });
}

function normalizeWriterEntry(value: WriterOrderedEvent, priorSequence: number, scope: BoundEventScope): WriterOrderedEvent {
  if (!hasExactDataFields(value, ["commitSequence", "event"])) throw new TypeError("invalid event row");
  const commitSequence = ownData(value, "commitSequence");
  if (typeof commitSequence !== "number" || !Number.isSafeInteger(commitSequence) ||
      commitSequence <= priorSequence || commitSequence <= 0) throw new TypeError("invalid writer sequence");
  const event = normalizeRuntimeEvent(ownData(value, "event"));
  if (!matchesScope(event.scope, scope) || !boundedString(event.source, MAX_IDENTIFIER_BYTES) ||
      !boundedString(event.eventId, MAX_IDENTIFIER_BYTES) ||
      (event.operationId !== null && !boundedString(event.operationId, MAX_IDENTIFIER_BYTES))) {
    throw new TypeError("event is outside the bounded scope");
  }
  return Object.freeze({ commitSequence, event });
}

function normalizeObservation(
  value: EventObservation,
  priorSequence: number,
  scope: BoundEventScope,
  facts: FactScan,
): EventObservation {
  if (!isRecord(value)) throw new TypeError("invalid observation row");
  const commitSequence = ownData(value, "commitSequence");
  const firstCommitSequence = ownData(value, "firstCommitSequence");
  const observationKey = normalizedSha256(ownData(value, "observationKey"));
  const candidateHash = normalizedSha256(ownData(value, "candidateHash"));
  const disposition = ownData(value, "disposition");
  if (typeof commitSequence !== "number" || !Number.isSafeInteger(commitSequence) || commitSequence <= priorSequence ||
      commitSequence <= 0 || typeof firstCommitSequence !== "number" || !Number.isSafeInteger(firstCommitSequence) ||
      firstCommitSequence <= 0 || observationKey === null || candidateHash === null ||
      !isObservationDisposition(disposition)) throw new TypeError("invalid observation receipt");
  const event = normalizeRuntimeEvent(ownData(value, "event"));
  if (!matchesScope(event.scope, scope) || !boundedString(event.source, MAX_IDENTIFIER_BYTES) ||
      !boundedString(event.eventId, MAX_IDENTIFIER_BYTES) ||
      (event.operationId !== null && !boundedString(event.operationId, MAX_IDENTIFIER_BYTES))) {
    throw new TypeError("observation is outside the bounded scope");
  }
  if (candidateHash !== hashCanonicalFacts(event) || firstCommitSequence > commitSequence) {
    throw new TypeError("observation hash or commit order is invalid");
  }
  const firstFact = facts.factByIdentity.get(identityKey(event));
  if (facts.complete && firstFact === undefined) throw new TypeError("observation has no persisted first fact");
  if (firstFact !== undefined) {
    if (firstCommitSequence !== firstFact.commitSequence) throw new TypeError("observation first sequence does not match its fact");
    const isSameFact = hashCanonicalFacts(firstFact.event) === candidateHash;
    if ((disposition === "identity_conflict") === isSameFact) throw new TypeError("observation disposition does not match its candidate hash");
  }
  const origin = normalizeOrigin(ownData(value, "origin"));
  const captureValue = ownData(value, "capture");
  const capture = captureValue === undefined ? undefined : normalizeCaptureSummaryInput(captureValue);
  if (capture !== undefined && (capture.sessionId !== scope.sessionId || capture.turnId !== scope.turnId)) {
    throw new TypeError("capture belongs to another turn");
  }
  return Object.freeze({
    observationKey,
    commitSequence,
    firstCommitSequence,
    disposition,
    candidateHash,
    event,
    origin,
    ...(capture === undefined ? {} : { capture }),
  });
}

function normalizeOrigin(value: unknown): EventObservation["origin"] {
  if (!isRecord(value)) throw new TypeError("invalid origin");
  const sourcePin = ownData(value, "sourcePin");
  const historicalLocator = ownData(value, "historicalLocator");
  const rawSha256 = normalizedSha256(ownData(value, "rawSha256"));
  const rawBytes = safeNonNegativeIntegerOrNull(ownData(value, "rawBytes"));
  const extent = ownData(value, "extent");
  const rawRetained = ownData(value, "rawRetained");
  if (boundedString(sourcePin, MAX_IDENTIFIER_BYTES) === null || boundedString(historicalLocator, MAX_REFERENCE_BYTES) === null ||
      rawSha256 === null || rawBytes === null || typeof extent !== "string" || rawRetained !== false) {
    throw new TypeError("invalid stored origin");
  }
  return Object.freeze({
    sourcePin: sourcePin as string,
    historicalLocator: historicalLocator as string,
    rawSha256,
    rawBytes,
    extent,
    rawRetained: false,
  });
}

function normalizeCaptureSummaryInput(value: unknown): NonNullable<EventObservation["capture"]> {
  if (!hasExactDataFields(value, ["schemaVersion", "sessionId", "turnId", "hookEventName", "origin", "snapshot", "snapshotSha256"])) {
    throw new TypeError("invalid capture");
  }
  if (ownData(value, "schemaVersion") !== 1) throw new TypeError("capture schema is invalid");
  const sessionId = boundedIdentifier(ownData(value, "sessionId"));
  const turnId = boundedIdentifier(ownData(value, "turnId"));
  if (sessionId === null || turnId === null) throw new TypeError("capture scope is invalid");
  const snapshot = ownData(value, "snapshot");
  const snapshotRecord = safeRecord(snapshot);
  const messages = ownData(snapshotRecord, "messages");
  const message = Array.isArray(messages) && messages.length === 1 ? messages[0] : undefined;
  const messageRecord = safeRecord(message);
  const text = ownData(messageRecord, "text");
  const textBytes = safeNonNegativeIntegerOrNull(ownData(messageRecord, "textBytes"));
  const textSha256 = normalizedSha256(ownData(messageRecord, "textSha256"));
  const snapshotSha256 = normalizedSha256(ownData(value, "snapshotSha256"));
  const hookEventName = ownData(value, "hookEventName");
  const captureOrigin = ownData(value, "origin");
  if (!hasExactDataFields(snapshot, ["schemaVersion", "redactionVersion", "messages"]) ||
      ownData(snapshotRecord, "schemaVersion") !== 1 || ownData(snapshotRecord, "redactionVersion") !== "full-mask-v1" ||
      !Array.isArray(messages) || messages.length !== 1 ||
      !hasExactDataFields(message, ["role", "text", "textBytes", "textSha256"]) ||
      text !== "[REDACTED]" || textBytes === null || textSha256 === null || snapshotSha256 === null ||
      (hookEventName !== "UserPromptSubmit" && hookEventName !== "Stop") || !isRecord(captureOrigin)) {
    throw new TypeError("capture did not satisfy the full-mask contract");
  }
  if (!hasExactDataFields(captureOrigin, ["temporaryLocator", "locatorUse", "rawBytes", "rawSha256", "sourcePin", "extent", "rawRetained"]) ||
      boundedString(ownData(captureOrigin, "temporaryLocator"), MAX_REFERENCE_BYTES) === null ||
      ownData(captureOrigin, "locatorUse") !== "historical-only" || ownData(captureOrigin, "extent") !== "current-message" ||
      ownData(captureOrigin, "rawRetained") !== false) {
    throw new TypeError("capture provenance is invalid");
  }
  const captureOriginSha = normalizedSha256(ownData(captureOrigin, "rawSha256"));
  const captureOriginBytes = safeNonNegativeIntegerOrNull(ownData(captureOrigin, "rawBytes"));
  const captureOriginPin = boundedString(ownData(captureOrigin, "sourcePin"), MAX_IDENTIFIER_BYTES);
  if (captureOriginSha === null || captureOriginBytes === null || captureOriginPin === null) {
    throw new TypeError("capture source metadata is invalid");
  }
  const role = ownData(messageRecord, "role");
  const expectedRole = hookEventName === "UserPromptSubmit" ? "user" : "assistant";
  if (role !== expectedRole) throw new TypeError("capture hook role does not match");
  const safeSnapshot = Object.freeze({
    schemaVersion: 1 as const,
    redactionVersion: "full-mask-v1" as const,
    messages: Object.freeze([Object.freeze({
      role,
      text: "[REDACTED]" as const,
      textBytes,
      textSha256,
    })]),
  });
  const calculatedSnapshotSha256 = createHash("sha256")
    .update(canonicalizeJson(safeSnapshot as unknown as JsonValue), "utf8")
    .digest("hex");
  if (calculatedSnapshotSha256 !== snapshotSha256) throw new TypeError("capture snapshot hash is invalid");
  return value as NonNullable<EventObservation["capture"]>;
}

function receiptMatchesFact(value: ReceiptLookup, entry: WriterOrderedEvent): boolean {
  if (value.status !== "found" || value.firstReceipt === undefined) return false;
  const receipt = value.firstReceipt;
  return receipt.source === entry.event.source && receipt.eventId === entry.event.eventId &&
    receipt.commitSequence === entry.commitSequence && receipt.canonicalHash.toLowerCase() === hashCanonicalFacts(entry.event);
}

function sourceVersionSummary(
  observations: ObservationScan,
  salt: ReportSalt,
  codes: Set<DiagnosticCode>,
): TurnDiagnosticsReport["sourceVersion"] {
  if (observations.otherSourcePinRefs.size > 0) codes.add("SOURCE_NOT_VERIFIED");
  return Object.freeze({
    acceptedNative40Pin: observations.acceptedNativePin ? NATIVE_PIN : null,
    adapter: observations.recoveryAdapter ? "recovery-v1" : "unknown",
    otherSourcePins: Object.freeze([...observations.otherSourcePinRefs].sort()),
  });
}

function mapEvidenceReason(value: unknown): DiagnosticCode {
  switch (value) {
    case "PROCESS_NOT_SUCCESSFUL": return "PROCESS_FAILED";
    case "TOOL_RECEIPT_MISSING": return "TOOL_RECEIPT_MISSING";
    case "TOOL_RECEIPT_INVALID": return "TOOL_RECEIPT_INVALID";
    case "ARTIFACT_MISSING": return "ARTIFACT_MISSING";
    case "SOURCE_REVISION_MISMATCH":
    case "SOURCE_REVISION_UNAVAILABLE":
    case "SOURCE_EXPECTATION_MISMATCH":
    case "SOURCE_DIRTY_AT_LAUNCH":
    case "REPOSITORY_MISMATCH": return "SOURCE_NOT_VERIFIED";
    default: return "OTHER";
  }
}

function evidenceScopeMismatch(reportValue: Pick<EvidenceReport, "scope" | "attemptId">, scope: BoundEventScope, attemptId: string): boolean {
  const report = safeRecord(reportValue);
  const reportScope = ownData(report, "scope");
  if (!isRecord(reportScope)) return true;
  for (const field of ["sessionId", "turnId", "runId", "taskId"] as const) {
    if (ownData(reportScope, field) !== scope[field]) return true;
  }
  return ownData(report, "attemptId") !== attemptId;
}

function normalizeRuntimeScope(value: NormalizedEvent["scope"]): BoundEventScope | null {
  const sessionId = boundedIdentifier(value.sessionId);
  const turnId = boundedIdentifier(value.turnId);
  const runId = boundedIdentifier(value.runId);
  const taskId = boundedIdentifier(value.taskId);
  if (sessionId === null || turnId === null || runId === null || taskId === null) return null;
  return Object.freeze({ sessionId, turnId, runId, taskId });
}

function matchesScope(actual: NormalizedEvent["scope"], expected: BoundEventScope): boolean {
  const normalized = normalizeRuntimeScope(actual);
  return normalized !== null && normalized.sessionId === expected.sessionId && normalized.turnId === expected.turnId &&
    normalized.runId === expected.runId && normalized.taskId === expected.taskId;
}

function validPageShape<T>(value: ReadPage<T>, maximumItems: number): boolean {
  if (!isRecord(value) || !Array.isArray(ownData(value, "items")) ||
      typeof ownData(value, "hasMore") !== "boolean") return false;
  const items = ownData(value, "items") as unknown[];
  const next = ownData(value, "nextAfterCommitSequence");
  return items.length <= maximumItems &&
    (next === null || (typeof next === "number" && Number.isSafeInteger(next) && next >= 0));
}

function identityKey(event: Pick<NormalizedEvent, "source" | "eventId">): string {
  return identityKeyFromStrings(event.source, event.eventId);
}

function identityKeyFromStrings(source: string, eventId: string): string {
  return canonicalizeJson([source, eventId] as unknown as JsonValue);
}

function eventRef(salt: ReportSalt, event: Pick<NormalizedEvent, "source" | "eventId">): DiagnosticShaRef {
  return eventRefFromIdentity(salt, event.source, event.eventId);
}

function eventRefFromIdentity(salt: ReportSalt, source: string, eventId: string): DiagnosticShaRef {
  return opaqueJsonRef(salt, "event", [source, eventId] as unknown as JsonValue);
}

function hashCanonicalFacts(event: NormalizedEvent): string {
  return createHash("sha256").update(canonicalizeEventFacts(event), "utf8").digest("hex");
}

function opaqueRef(salt: ReportSalt, domain: string, value: string): DiagnosticShaRef {
  return opaqueBytesRef(salt, domain, Buffer.from(value, "utf8"));
}

function opaqueJsonRef(salt: ReportSalt, domain: string, value: JsonValue): DiagnosticShaRef {
  return opaqueRef(salt, domain, canonicalizeJson(value));
}

function opaqueBytesRef(salt: ReportSalt, domain: string, value: Buffer): DiagnosticShaRef {
  const hash = createHash("sha256");
  hash.update("xiadie-turn-diagnostics/v1\0", "utf8");
  hash.update(salt.bytes);
  hash.update("\0", "utf8");
  hash.update(domain, "utf8");
  hash.update("\0", "utf8");
  hash.update(value);
  return hash.digest("hex") as DiagnosticShaRef;
}

function boundedIdentifier(value: unknown): string | null {
  return boundedString(value, MAX_IDENTIFIER_BYTES);
}

function boundedString(value: unknown, maximumBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maximumBytes) return null;
  return value;
}

function normalizedSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value.toLowerCase() : null;
}

function safeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function safePositiveIntegerOrNull(value: unknown): number | null {
  const number = safeIntegerOrNull(value);
  return number !== null && number > 0 ? number : null;
}

function safeNonNegativeIntegerOrNull(value: unknown): number | null {
  const number = safeIntegerOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function isObservationDisposition(value: unknown): value is EventObservation["disposition"] {
  return value === "accepted" || value === "duplicate" || value === "redelivery_resequenced" || value === "identity_conflict";
}

function closedValue<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && allowed.includes(value) ? value as T[number] : fallback;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : Object.create(null) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownData(value: unknown, field: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasExactDataFields(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  if (!isRecord(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
        required.some((field) => !keys.includes(field))) return false;
    return keys.every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}
