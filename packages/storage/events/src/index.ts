import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { openSQLiteConnection, SQLiteIntegerRangeError, type SQLiteConnection } from "./sqlite.js";
import {
  canonicalizeEventFacts,
  canonicalizeJson,
  normalizeRuntimeEvent,
  type NormalizedEvent,
  type WriterOrderedEvent,
} from "../../../contracts/src/events.js";
import type { JsonValue } from "../../../contracts/src/json-value.js";
import type { TranscriptCapture } from "../../../adapters/zcode/src/transcript.js";
import { EVENT_STORE_SCHEMA_V1, EVENT_STORE_SCHEMA_VERSION } from "../../../../migrations/001-event-store.js";

const BUSY_TIMEOUT_MS = 180;
const DEFAULT_MAX_PENDING = 32;
const MAX_PENDING = 64;
const DEFAULT_READ_LIMIT = 128;
const MAX_READ_LIMIT = 256;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_CAPTURE_BYTES = 4096;
const MAX_RAW_CAPTURE_BYTES = 512 * 1024;
const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

export interface EventOriginInput {
  readonly sourcePin: string;
  readonly historicalLocator: string;
  readonly rawSha256: string;
  readonly rawBytes: number;
  readonly extent: string;
  readonly rawRetained: false;
}

export interface AppendInput {
  readonly event: NormalizedEvent;
  readonly origin: EventOriginInput;
  readonly capture?: TranscriptCapture;
}

export type StoreErrorCode =
  | "INVALID_INPUT"
  | "BUSY"
  | "FULL"
  | "READONLY"
  | "CORRUPT_STORE"
  | "UNSUPPORTED_SCHEMA"
  | "UNSUPPORTED_FUTURE_SCHEMA"
  | "SQLITE_ERROR"
  | "UNKNOWN_COMMIT"
  | "UNRESOLVED_TRANSACTION"
  | "SEQUENCE_EXHAUSTED"
  | "CLOSED";

export class EventStoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventStoreError";
    this.code = code;
  }
}

type AppendFailureCode = "BUSY" | "FULL" | "READONLY" | "CORRUPT_STORE" | "SQLITE_ERROR" | "SEQUENCE_EXHAUSTED";

export type AppendResult =
  | {
      readonly status: "committed" | "duplicate" | "conflict";
      readonly observationKey: string;
      readonly commitSequence: number;
      readonly firstCommitSequence: number;
      readonly canonicalHash: string;
    }
  | {
      readonly status: "failed";
      readonly observationKey: string;
      readonly code: AppendFailureCode;
    }
  | {
      readonly status: "unknown";
      readonly observationKey: string;
      readonly code: "UNKNOWN_COMMIT";
    };

export type AppendAdmission =
  | { readonly status: "queued"; readonly observationKey: string; readonly completion: Promise<AppendResult> }
  | { readonly status: "queue_full" | "closed" | "readonly" }
  | { readonly status: "invalid"; readonly code: "INVALID_INPUT" };

export interface ReadQuery {
  readonly limit?: number;
  readonly afterCommitSequence?: number;
  readonly scope?: Partial<{
    readonly sessionId: string | null;
    readonly turnId: string | null;
    readonly runId: string | null;
    readonly taskId: string | null;
  }>;
  readonly operationId?: string;
}

export interface ReadPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextAfterCommitSequence: number | null;
}

export interface EventObservation {
  readonly observationKey: string;
  readonly commitSequence: number;
  readonly firstCommitSequence: number;
  readonly disposition: "accepted" | "duplicate" | "redelivery_resequenced" | "identity_conflict";
  readonly candidateHash: string;
  readonly event: NormalizedEvent;
  readonly origin: EventOriginInput;
  readonly capture?: TranscriptCapture;
}

export interface ReceiptLookup {
  readonly status: "found" | "not_found";
  readonly firstReceipt?: {
    readonly source: string;
    readonly eventId: string;
    readonly canonicalHash: string;
    readonly commitSequence: number;
    readonly committedAt: string;
  };
  readonly observation?: {
    readonly observationKey: string;
    readonly commitSequence: number;
    readonly disposition: EventObservation["disposition"];
    readonly candidateHash: string;
  };
}

export interface EventStoreDiagnostics {
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeoutMs: number;
  readonly readOnly: boolean;
}

export interface EventStore {
  append(input: AppendInput): AppendAdmission;
  read(query?: ReadQuery): ReadPage<WriterOrderedEvent>;
  readObservations(query?: ReadQuery): ReadPage<EventObservation>;
  queryReceipt(identity: { readonly source: string; readonly eventId: string }, observationKey?: string): ReceiptLookup;
  getDiagnostics(): EventStoreDiagnostics;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenEventStoreOptions {
  readonly path: string;
  readonly maxPending?: number;
  readonly readOnly?: boolean;
}

interface NormalizedOrigin extends EventOriginInput {}

interface NormalizedBundle {
  readonly event: NormalizedEvent;
  readonly origin: NormalizedOrigin;
  readonly capture?: TranscriptCapture;
  readonly canonicalFacts: string;
  readonly canonicalHash: string;
  readonly eventJson: string;
  readonly originJson: string;
  readonly captureSnapshotJson?: string;
  readonly bundleJson: string;
  readonly observationKey: string;
}

interface PendingJob {
  readonly id: number;
  readonly bundle: NormalizedBundle;
  readonly completion: Promise<AppendResult>;
  readonly resolve: (result: AppendResult) => void;
}

interface AppendProcessingOutcome {
  readonly result: AppendResult;
  readonly stopWriter: boolean;
}

interface QueryPlan {
  readonly sql: string;
  readonly values: readonly (string | number | null)[];
  readonly limit: number;
}

interface FactRecord {
  readonly source: string;
  readonly eventId: string;
  readonly canonicalFacts: string;
  readonly canonicalHash: string;
  readonly firstCommitSequence: number;
  readonly firstEvent: NormalizedEvent;
  readonly firstOrigin: EventOriginInput;
  readonly firstObservation: EventObservation;
  readonly committedAt: string;
}

const SCOPE_COLUMNS = Object.freeze({
  sessionId: "session_id",
  turnId: "turn_id",
  runId: "run_id",
  taskId: "task_id",
});
const CANDIDATE_SCOPE_COLUMNS = Object.freeze({
  sessionId: "candidate_scope_session_id",
  turnId: "candidate_scope_turn_id",
  runId: "candidate_scope_run_id",
  taskId: "candidate_scope_task_id",
});

/** Opens a single-owner SQLite store. Future schema versions are checked through a read-only handle first. */
export function openEventStore(options: OpenEventStoreOptions): EventStore {
  const normalizedOptions = normalizeOpenOptions(options);
  const databasePath = normalizedOptions.path;
  const priorVersion = readUserVersionReadOnly(databasePath);
  if (priorVersion > EVENT_STORE_SCHEMA_VERSION) {
    throw new EventStoreError(
      "UNSUPPORTED_FUTURE_SCHEMA",
      `database schema version ${priorVersion} is newer than supported version ${EVENT_STORE_SCHEMA_VERSION}`,
    );
  }

  if (normalizedOptions.readOnly && !existsSync(databasePath)) {
    throw new EventStoreError("UNSUPPORTED_SCHEMA", "read-only event store does not exist");
  }

  let database: SQLiteConnection;
  try {
    database = openSQLiteConnection(databasePath, {
      readonly: normalizedOptions.readOnly,
      timeout: BUSY_TIMEOUT_MS,
    });
  } catch (error) {
    throw mapOpenError(error);
  }

  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 180;");
    const openedVersion = pragmaNumber(database, "user_version");
    if (openedVersion > EVENT_STORE_SCHEMA_VERSION) {
      throw new EventStoreError(
        "UNSUPPORTED_FUTURE_SCHEMA",
        `database schema version ${openedVersion} is newer than supported version ${EVENT_STORE_SCHEMA_VERSION}`,
      );
    }
    if (openedVersion === 0 && userTableCount(database) > 0) {
      throw new EventStoreError("UNSUPPORTED_SCHEMA", "schema version 0 database is non-empty; initialization was refused");
    }

    if (normalizedOptions.readOnly) {
      if (openedVersion !== EVENT_STORE_SCHEMA_VERSION) {
        throw new EventStoreError("UNSUPPORTED_SCHEMA", `read-only schema version ${openedVersion} is not supported`);
      }
      return createStore(database, normalizedOptions.maxPending, true);
    }

    const journalMode = String(database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode ?? "").toLowerCase();
    if (journalMode !== "wal") {
      throw new EventStoreError("SQLITE_ERROR", `SQLite refused WAL mode (reported ${journalMode || "empty"})`);
    }
    database.exec("PRAGMA synchronous = FULL; PRAGMA busy_timeout = 180;");

    if (openedVersion === 0) applyInitialMigration(database);
    const schemaVersion = pragmaNumber(database, "user_version");
    if (schemaVersion !== EVENT_STORE_SCHEMA_VERSION) {
      throw new EventStoreError("UNSUPPORTED_SCHEMA", `schema version ${schemaVersion} is not supported`);
    }
    return createStore(database, normalizedOptions.maxPending, false);
  } catch (error) {
    try { database.close(); } catch { /* Preserve the original open error. */ }
    if (error instanceof EventStoreError) throw error;
    throw mapOpenError(error);
  }
}

function createStore(database: SQLiteConnection, maxPending: number, readOnly: boolean): EventStore {
  const queue: PendingJob[] = [];
  const pending = new Map<number, PendingJob>();
  let nextJobId = 1;
  let pumpScheduled = false;
  let accepting = true;
  let closed = false;
  let writerPoisoned = false;
  let closePromise: Promise<void> | undefined;

  const schedulePump = (): void => {
    if (pumpScheduled || queue.length === 0 || closed) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      if (writerPoisoned) {
        settleQueuedAsUnknown();
        return;
      }
      const job = queue.shift();
      if (job === undefined || closed) return;
      const outcome = appendTransaction(database, job.bundle);
      pending.delete(job.id);
      if (outcome.stopWriter) {
        writerPoisoned = true;
        accepting = false;
      }
      job.resolve(outcome.result);
      if (writerPoisoned) settleQueuedAsUnknown();
      schedulePump();
    });
  };

  const settleQueuedAsUnknown = (): void => {
    while (queue.length > 0) {
      const job = queue.shift()!;
      pending.delete(job.id);
      job.resolve(Object.freeze({ status: "unknown", observationKey: job.bundle.observationKey, code: "UNKNOWN_COMMIT" }));
    }
  };

  const ensureOpen = (): void => {
    if (closed) throw new EventStoreError("CLOSED", "event store is closed");
    if (writerPoisoned) {
      throw new EventStoreError("UNRESOLVED_TRANSACTION", "event store has an unresolved transaction and is quarantined");
    }
  };

  return Object.freeze({
    append(input: AppendInput): AppendAdmission {
      if (!accepting) return Object.freeze({ status: "closed" });
      if (readOnly) return Object.freeze({ status: "readonly" });
      let bundle: NormalizedBundle;
      try {
        bundle = normalizeBundle(input);
      } catch {
        return Object.freeze({ status: "invalid", code: "INVALID_INPUT" });
      }
      if (pending.size >= maxPending) return Object.freeze({ status: "queue_full" });

      let resolve!: (result: AppendResult) => void;
      const completion = new Promise<AppendResult>((resolveCompletion) => { resolve = resolveCompletion; });
      const job: PendingJob = Object.freeze({ id: nextJobId++, bundle, completion, resolve });
      queue.push(job);
      pending.set(job.id, job);
      schedulePump();
      return Object.freeze({ status: "queued", observationKey: bundle.observationKey, completion });
    },

    read(query: ReadQuery = {}): ReadPage<WriterOrderedEvent> {
      ensureOpen();
      const plan = buildFactQuery(query);
      try {
        const rows = database.prepare(plan.sql).all(...plan.values) as unknown as Record<string, unknown>[];
        const hasMore = rows.length > plan.limit;
        const selected = rows.slice(0, plan.limit);
        const items = selected.map((row) => {
          const source = textColumn(row, "source");
          const eventId = textColumn(row, "event_id");
          const fact = loadFactRecord(database, source, eventId);
          return Object.freeze({ commitSequence: fact.firstCommitSequence, event: fact.firstEvent });
        });
        return makePage(items, hasMore);
      } catch (error) {
        throw mapReadError(error);
      }
    },

    readObservations(query: ReadQuery = {}): ReadPage<EventObservation> {
      ensureOpen();
      const plan = buildObservationQuery(query);
      try {
        const rows = database.prepare(plan.sql).all(...plan.values) as unknown as Record<string, unknown>[];
        const hasMore = rows.length > plan.limit;
        const selected = rows.slice(0, plan.limit);
        const items = selected.map((row) => {
          const source = textColumn(row, "source");
          const eventId = textColumn(row, "event_id");
          const fact = loadFactRecord(database, source, eventId);
          const observation = decodeObservation(database, row);
          validateObservationDisposition(observation, fact);
          return observation;
        });
        return makePage(items, hasMore);
      } catch (error) {
        throw mapReadError(error);
      }
    },

    queryReceipt(
      identity: { readonly source: string; readonly eventId: string },
      observationKey?: string,
    ): ReceiptLookup {
      ensureOpen();
      const normalizedIdentity = normalizeIdentity(identity);
      if (observationKey !== undefined && !isHash(observationKey)) {
        throw new EventStoreError("INVALID_INPUT", "observationKey must be a SHA-256 hex digest");
      }
      try {
        const row = database.prepare("SELECT 1 AS present FROM events WHERE source = ? AND event_id = ?")
          .get(normalizedIdentity.source, normalizedIdentity.eventId);
        if (row === undefined) return Object.freeze({ status: "not_found" });
        const fact = loadFactRecord(database, normalizedIdentity.source, normalizedIdentity.eventId);
        let observation: ReceiptLookup["observation"];
        if (observationKey !== undefined) {
          const observationRow = selectObservationRow(database, observationKey);
          if (observationRow === undefined || observationRow.source !== normalizedIdentity.source ||
              observationRow.event_id !== normalizedIdentity.eventId) {
            return Object.freeze({ status: "not_found" });
          }
          const decoded = decodeObservation(database, observationRow);
          validateObservationDisposition(decoded, fact);
          observation = Object.freeze({
            observationKey: decoded.observationKey,
            commitSequence: decoded.commitSequence,
            disposition: decoded.disposition,
            candidateHash: decoded.candidateHash,
          });
        }
        return Object.freeze({
          status: "found",
          firstReceipt: Object.freeze({
            source: fact.source,
            eventId: fact.eventId,
            canonicalHash: fact.canonicalHash,
            commitSequence: fact.firstCommitSequence,
            committedAt: fact.committedAt,
          }),
          ...(observation === undefined ? {} : { observation }),
        });
      } catch (error) {
        throw mapReadError(error);
      }
    },

    getDiagnostics(): EventStoreDiagnostics {
      ensureOpen();
      try {
        const version = pragmaNumber(database, "user_version");
        const journalMode = String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "");
        const synchronous = pragmaNumber(database, "synchronous");
        const foreignKeys = pragmaNumber(database, "foreign_keys");
        const busyTimeoutMs = pragmaNumber(database, "busy_timeout");
        return Object.freeze({ schemaVersion: version, journalMode, synchronous, foreignKeys, busyTimeoutMs, readOnly });
      } catch (error) {
        throw mapReadError(error);
      }
    },

    drain(): Promise<void> {
      const frontier = [...pending.values()].map((job) => job.completion);
      return Promise.all(frontier).then(() => undefined);
    },

    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      accepting = false;
      closePromise = thisDrainAndClose();
      return closePromise;
    },
  });

  function thisDrainAndClose(): Promise<void> {
    const frontier = [...pending.values()].map((job) => job.completion);
    return Promise.all(frontier).then(() => {
      if (!closed) {
        try {
          let transactionActive = false;
          try { transactionActive = database.isTransaction; } catch { /* Still attempt to close the connection. */ }
          if (transactionActive) {
            try { database.exec("ROLLBACK"); } catch { /* The connection is quarantined and will be closed. */ }
          }
          database.close();
        } finally {
          closed = true;
        }
      }
    });
  }
}

function normalizeOpenOptions(value: OpenEventStoreOptions): Required<OpenEventStoreOptions> {
  if (!hasExactFields(value, ["path"], ["maxPending", "readOnly"])) {
    throw new EventStoreError("INVALID_INPUT", "openEventStore options have invalid fields");
  }
  if (typeof value.path !== "string" || value.path.trim().length === 0 || value.path.includes("\0") ||
      value.path === ":memory:") {
    throw new EventStoreError("INVALID_INPUT", "event store path must be a non-empty file path");
  }
  const maxPending = value.maxPending === undefined ? DEFAULT_MAX_PENDING : value.maxPending;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING) {
    throw new EventStoreError("INVALID_INPUT", `maxPending must be an integer from 1 through ${MAX_PENDING}`);
  }
  const readOnly = value.readOnly === undefined ? false : value.readOnly;
  if (typeof readOnly !== "boolean") throw new EventStoreError("INVALID_INPUT", "readOnly must be boolean");
  return Object.freeze({ path: path.resolve(value.path), maxPending, readOnly });
}

function readUserVersionReadOnly(databasePath: string): number {
  if (!existsSync(databasePath)) return 0;
  let database: SQLiteConnection | undefined;
  try {
    database = openSQLiteConnection(databasePath, {
      readonly: true,
      timeout: BUSY_TIMEOUT_MS,
    });
    const version = pragmaNumber(database, "user_version");
    if (version === 0 && userTableCount(database) > 0) {
      throw new EventStoreError("UNSUPPORTED_SCHEMA", "schema version 0 database is non-empty; initialization was refused");
    }
    return version;
  } catch (error) {
    if (error instanceof EventStoreError) throw error;
    throw mapOpenError(error);
  } finally {
    try { database?.close(); } catch { /* No writable operation has been attempted. */ }
  }
}

function applyInitialMigration(database: SQLiteConnection): void {
  let inTransaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const lockedVersion = pragmaNumber(database, "user_version");
    if (lockedVersion > EVENT_STORE_SCHEMA_VERSION) {
      throw new EventStoreError("UNSUPPORTED_FUTURE_SCHEMA", `database schema version ${lockedVersion} is newer than supported`);
    }
    if (lockedVersion === EVENT_STORE_SCHEMA_VERSION) {
      database.exec("COMMIT");
      inTransaction = false;
      return;
    }
    if (lockedVersion !== 0 || userTableCount(database) > 0) {
      throw new EventStoreError("UNSUPPORTED_SCHEMA", "schema version 0 database is non-empty or unsupported");
    }
    database.exec(EVENT_STORE_SCHEMA_V1);
    database.exec(`PRAGMA user_version = ${EVENT_STORE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the migration error. */ }
    }
    throw mapOpenError(error);
  }
}

function userTableCount(database: SQLiteConnection): number {
  const row = database.prepare(`
    SELECT count(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as Record<string, unknown> | undefined;
  if (row === undefined || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
    throw new EventStoreError("SQLITE_ERROR", "SQLite could not read the existing table inventory");
  }
  return row.count;
}

function normalizeBundle(input: AppendInput): NormalizedBundle {
  if (!hasExactFields(input, ["event", "origin"], ["capture"])) {
    throw new TypeError("append input has invalid fields");
  }
  const event = normalizeRuntimeEvent(input.event);
  const origin = normalizeOrigin(input.origin);
  const canonicalFacts = canonicalizeEventFacts(event);
  const canonicalHash = sha256(canonicalFacts);
  const eventJson = canonicalizeJson(event as unknown as JsonValue);
  if (Buffer.byteLength(eventJson, "utf8") > MAX_EVENT_BYTES) throw new TypeError("event exceeds the byte limit");
  let capture: TranscriptCapture | undefined;
  let captureSnapshotJson: string | undefined;
  if (input.capture !== undefined) {
    capture = normalizeCapture(input.capture, event);
    captureSnapshotJson = canonicalizeJson(capture.snapshot as unknown as JsonValue);
    if (Buffer.byteLength(captureSnapshotJson, "utf8") > MAX_CAPTURE_BYTES) {
      throw new TypeError("capture snapshot exceeds the byte limit");
    }
  }
  const originJson = canonicalizeJson(origin as unknown as JsonValue);
  const bundle = Object.freeze({ event, origin, ...(capture === undefined ? {} : { capture }) });
  const bundleJson = canonicalizeJson(bundle as unknown as JsonValue);
  const observationKey = sha256(bundleJson);
  return Object.freeze({
    event,
    origin,
    ...(capture === undefined ? {} : { capture }),
    canonicalFacts,
    canonicalHash,
    eventJson,
    originJson,
    ...(captureSnapshotJson === undefined ? {} : { captureSnapshotJson }),
    bundleJson,
    observationKey,
  });
}

function normalizeOrigin(value: unknown): NormalizedOrigin {
  if (!hasExactFields(value, ["sourcePin", "historicalLocator", "rawSha256", "rawBytes", "extent", "rawRetained"])) {
    throw new TypeError("origin has invalid fields");
  }
  const record = value as Record<string, unknown>;
  const sourcePin = boundedString(record.sourcePin, "sourcePin", 256);
  const historicalLocator = boundedString(record.historicalLocator, "historicalLocator", 1024);
  const rawSha256 = normalizeHash(record.rawSha256, "rawSha256");
  if (typeof record.rawBytes !== "number" || !Number.isSafeInteger(record.rawBytes) || record.rawBytes < 0) {
    throw new TypeError("origin rawBytes must be a non-negative safe integer");
  }
  const extent = boundedString(record.extent, "extent", 128);
  if (record.rawRetained !== false) throw new TypeError("origin must state rawRetained:false");
  return Object.freeze({ sourcePin, historicalLocator, rawSha256, rawBytes: record.rawBytes, extent, rawRetained: false });
}

function normalizeCapture(value: unknown, event: NormalizedEvent): TranscriptCapture {
  if (!hasExactFields(value, ["schemaVersion", "sessionId", "turnId", "hookEventName", "origin", "snapshot", "snapshotSha256"])) {
    throw new TypeError("capture has invalid fields");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new TypeError("capture schemaVersion is unsupported");
  const sessionId = boundedString(record.sessionId, "capture sessionId", 256);
  const turnId = boundedString(record.turnId, "capture turnId", 256);
  if (record.hookEventName !== "UserPromptSubmit" && record.hookEventName !== "Stop") {
    throw new TypeError("capture hookEventName is unsupported");
  }
  const scope = event.scope;
  if (scope.sessionId !== sessionId || scope.turnId !== turnId) {
    throw new TypeError("capture session/turn does not match event scope");
  }
  const origin = normalizeTranscriptOrigin(record.origin);
  const snapshotRecord = record.snapshot;
  if (!hasExactFields(snapshotRecord, ["schemaVersion", "redactionVersion", "messages"])) {
    throw new TypeError("capture snapshot has invalid fields");
  }
  const snapshotSource = snapshotRecord as Record<string, unknown>;
  if (snapshotSource.schemaVersion !== 1 || snapshotSource.redactionVersion !== "full-mask-v1" ||
      !Array.isArray(snapshotSource.messages) || snapshotSource.messages.length !== 1) {
    throw new TypeError("capture snapshot version or messages are invalid");
  }
  const expectedRole = record.hookEventName === "UserPromptSubmit" ? "user" : "assistant";
  const messages = snapshotSource.messages.map((message) => {
    if (!hasExactFields(message, ["role", "text", "textBytes", "textSha256"])) {
      throw new TypeError("capture message has invalid fields");
    }
    const item = message as Record<string, unknown>;
    if (item.role !== "user" && item.role !== "assistant") throw new TypeError("capture message role is invalid");
    if (item.role !== expectedRole) throw new TypeError("capture message role does not match hook event");
    if (item.text !== "[REDACTED]") throw new TypeError("capture message is not fully masked");
    if (typeof item.textBytes !== "number" || !Number.isSafeInteger(item.textBytes) || item.textBytes < 0 ||
        item.textBytes > MAX_RAW_CAPTURE_BYTES) throw new TypeError("capture message byte extent is invalid");
    return Object.freeze({
      role: item.role,
      text: "[REDACTED]" as const,
      textBytes: item.textBytes,
      textSha256: normalizeHash(item.textSha256, "textSha256"),
    });
  });
  const snapshot = Object.freeze({
    schemaVersion: 1 as const,
    redactionVersion: "full-mask-v1" as const,
    messages: Object.freeze(messages),
  });
  const snapshotJson = canonicalizeJson(snapshot as unknown as JsonValue);
  if (Buffer.byteLength(snapshotJson, "utf8") > MAX_CAPTURE_BYTES) {
    throw new TypeError("capture snapshot exceeds the byte limit");
  }
  const snapshotSha256 = normalizeHash(record.snapshotSha256, "snapshotSha256");
  if (snapshotSha256 !== sha256(snapshotJson)) throw new TypeError("capture snapshot hash does not match");
  return Object.freeze({
    schemaVersion: 1,
    sessionId,
    turnId,
    hookEventName: record.hookEventName,
    origin,
    snapshot,
    snapshotSha256,
  });
}

function normalizeTranscriptOrigin(value: unknown): TranscriptCapture["origin"] {
  if (!hasExactFields(value, ["temporaryLocator", "locatorUse", "rawBytes", "rawSha256", "sourcePin", "extent", "rawRetained"])) {
    throw new TypeError("capture origin has invalid fields");
  }
  const record = value as Record<string, unknown>;
  const temporaryLocator = boundedString(record.temporaryLocator, "temporaryLocator", 1024);
  if (record.locatorUse !== "historical-only" || record.extent !== "current-message" || record.rawRetained !== false) {
    throw new TypeError("capture origin retention policy is invalid");
  }
  if (typeof record.rawBytes !== "number" || !Number.isSafeInteger(record.rawBytes) ||
      record.rawBytes < 0 || record.rawBytes > MAX_RAW_CAPTURE_BYTES) {
    throw new TypeError("capture origin rawBytes are invalid");
  }
  return Object.freeze({
    temporaryLocator,
    locatorUse: "historical-only",
    rawBytes: record.rawBytes,
    rawSha256: normalizeHash(record.rawSha256, "capture rawSha256"),
    sourcePin: boundedString(record.sourcePin, "capture sourcePin", 256),
    extent: "current-message",
    rawRetained: false,
  });
}

function appendTransaction(database: SQLiteConnection, bundle: NormalizedBundle): AppendProcessingOutcome {
  let commitAttempted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    const existingObservation = selectObservationRow(database, bundle.observationKey);
    if (existingObservation !== undefined) {
      const fact = loadFactRecord(database, String(existingObservation.source), String(existingObservation.event_id));
      const prior = decodeObservation(database, existingObservation);
      validateObservationDisposition(prior, fact);
      if (canonicalizeAppendBundle(prior) !== bundle.bundleJson) {
        throw new EventStoreError("CORRUPT_STORE", "observation key maps to different stored content");
      }
      commitAttempted = true;
      database.exec("COMMIT");
      return Object.freeze({
        result: Object.freeze({
          status: prior.disposition === "identity_conflict" ? "conflict" : "duplicate",
          observationKey: bundle.observationKey,
          commitSequence: prior.commitSequence,
          firstCommitSequence: fact.firstCommitSequence,
          canonicalHash: fact.canonicalHash,
        }),
        stopWriter: false,
      });
    }

    const existingFactRow = database.prepare("SELECT * FROM events WHERE source = ? AND event_id = ?")
      .get(bundle.event.source, bundle.event.eventId) as Record<string, unknown> | undefined;
    const priorFact = existingFactRow === undefined
      ? undefined
      : loadFactRecord(database, bundle.event.source, bundle.event.eventId);
    const isFirst = priorFact === undefined;
    const isConflict = priorFact !== undefined && priorFact.canonicalFacts !== bundle.canonicalFacts;
    const firstSourceSequence = priorFact?.firstEvent.sourceSequence ?? null;
    const disposition: EventObservation["disposition"] = isFirst
      ? "accepted"
      : isConflict
        ? "identity_conflict"
        : firstSourceSequence !== bundle.event.sourceSequence
          ? "redelivery_resequenced"
          : "duplicate";
    const sequence = nextCommitSequence(database);

    // events is inserted before its first observation because the FK is immediate.
    if (isFirst) insertFact(database, bundle, sequence);
    insertObservation(database, bundle, sequence, disposition, isConflict);
    if (isFirst) {
      database.prepare(`
        INSERT INTO event_origins (source, event_id, first_observation_key)
        VALUES (?, ?, ?)
      `).run(bundle.event.source, bundle.event.eventId, bundle.observationKey);
      database.prepare(`
        INSERT INTO event_receipts (source, event_id, canonical_hash, first_commit_sequence, committed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(bundle.event.source, bundle.event.eventId, bundle.canonicalHash, sequence, new Date().toISOString());
    }
    if (bundle.capture !== undefined) insertTranscriptMaterial(database, bundle);

    commitAttempted = true;
    database.exec("COMMIT");
    return Object.freeze({
      result: Object.freeze({
        status: isFirst ? "committed" : isConflict ? "conflict" : "duplicate",
        observationKey: bundle.observationKey,
        commitSequence: sequence,
        firstCommitSequence: priorFact?.firstCommitSequence ?? sequence,
        canonicalHash: bundle.canonicalHash,
      }),
      stopWriter: false,
    });
  } catch (error) {
    const mapped = error instanceof EventStoreError ? error : mapSqliteError(error);
    let rollbackReturned = false;
    let transactionActive = false;
    try { transactionActive = database.isTransaction; } catch { transactionActive = true; }
    if (transactionActive) {
      try {
        database.exec("ROLLBACK");
        rollbackReturned = true;
      } catch {
        rollbackReturned = false;
      }
      try { transactionActive = database.isTransaction; } catch { transactionActive = true; }
    }
    if (transactionActive) {
      return Object.freeze({
        result: Object.freeze({ status: "unknown", observationKey: bundle.observationKey, code: "UNKNOWN_COMMIT" }),
        stopWriter: true,
      });
    }
    if (commitAttempted && !rollbackReturned) {
      return Object.freeze({
        result: Object.freeze({ status: "unknown", observationKey: bundle.observationKey, code: "UNKNOWN_COMMIT" }),
        stopWriter: false,
      });
    }
    return Object.freeze({
      result: Object.freeze({
        status: "failed",
        observationKey: bundle.observationKey,
        code: asAppendFailureCode(mapped.code),
      }),
      stopWriter: false,
    });
  }
}

function nextCommitSequence(database: SQLiteConnection): number {
  const row = database.prepare("SELECT last_commit_sequence FROM writer_state WHERE singleton = 1").get();
  if (row === undefined) throw new EventStoreError("CORRUPT_STORE", "writer state is missing");
  const prior = numberColumn(row as Record<string, unknown>, "last_commit_sequence");
  const maximumRow = database.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS maximum FROM event_observations").get();
  if (maximumRow === undefined || prior !== numberColumn(maximumRow as Record<string, unknown>, "maximum")) {
    throw new EventStoreError("CORRUPT_STORE", "writer state does not match the committed observation frontier");
  }
  if (!Number.isSafeInteger(prior) || prior < 0 || prior >= MAX_SAFE_SEQUENCE) {
    throw new EventStoreError(prior >= MAX_SAFE_SEQUENCE ? "SEQUENCE_EXHAUSTED" : "CORRUPT_STORE", "writer sequence is invalid");
  }
  const next = prior + 1;
  database.prepare("UPDATE writer_state SET last_commit_sequence = ? WHERE singleton = 1").run(next);
  return next;
}

function insertFact(database: SQLiteConnection, bundle: NormalizedBundle, sequence: number): void {
  const event = bundle.event;
  database.prepare(`
    INSERT INTO events (
      source, event_id, session_id, turn_id, run_id, task_id, attempt_id, operation_id,
      kind, occurred_at, canonical_facts_json, canonical_hash, first_commit_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.source, event.eventId, event.scope.sessionId, event.scope.turnId, event.scope.runId, event.scope.taskId,
    event.attemptId, event.operationId, event.kind, event.occurredAt,
    bundle.canonicalFacts, bundle.canonicalHash, sequence,
  );
}

function insertObservation(
  database: SQLiteConnection,
  bundle: NormalizedBundle,
  sequence: number,
  disposition: EventObservation["disposition"],
  conflict: boolean,
): void {
  const event = bundle.event;
  database.prepare(`
    INSERT INTO event_observations (
      observation_key, source, event_id, commit_sequence, observed_at, source_sequence,
      candidate_hash, disposition, candidate_scope_session_id, candidate_scope_turn_id,
      candidate_scope_run_id, candidate_scope_task_id, candidate_attempt_id, candidate_operation_id,
      candidate_kind, event_json, conflict_facts_json, origin_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bundle.observationKey, event.source, event.eventId, sequence, event.observedAt, event.sourceSequence,
    bundle.canonicalHash, disposition, event.scope.sessionId, event.scope.turnId, event.scope.runId,
    event.scope.taskId, event.attemptId, event.operationId, event.kind, bundle.eventJson,
    conflict ? bundle.canonicalFacts : null, bundle.originJson,
  );
}

function insertTranscriptMaterial(database: SQLiteConnection, bundle: NormalizedBundle): void {
  const capture = bundle.capture!;
  const snapshotJson = bundle.captureSnapshotJson!;
  if (Buffer.byteLength(snapshotJson, "utf8") > MAX_CAPTURE_BYTES) {
    throw new EventStoreError("INVALID_INPUT", "capture snapshot exceeds the storage byte limit");
  }
  database.prepare(`
    INSERT INTO transcript_materials (
      observation_key, schema_version, session_id, turn_id, hook_event_name,
      capture_origin_json, snapshot_json, snapshot_sha256
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bundle.observationKey, capture.schemaVersion, capture.sessionId, capture.turnId, capture.hookEventName,
    canonicalizeJson(capture.origin as unknown as JsonValue), Buffer.from(snapshotJson, "utf8"), capture.snapshotSha256,
  );
}

function loadFactRecord(database: SQLiteConnection, source: string, eventId: string): FactRecord {
  const row = database.prepare("SELECT * FROM events WHERE source = ? AND event_id = ?").get(source, eventId) as
    Record<string, unknown> | undefined;
  if (row === undefined) throw new EventStoreError("CORRUPT_STORE", "event fact is missing");
  const storedSource = textColumn(row, "source");
  const storedEventId = textColumn(row, "event_id");
  const canonicalFacts = textColumn(row, "canonical_facts_json");
  const canonicalHash = normalizeHash(row.canonical_hash, "stored canonical_hash");
  const firstCommitSequence = positiveSequence(row.first_commit_sequence, "first_commit_sequence");
  const firstObservationRow = database.prepare(`
    SELECT * FROM event_observations
    WHERE source = ? AND event_id = ? AND commit_sequence = ?
  `).get(source, eventId, firstCommitSequence) as Record<string, unknown> | undefined;
  if (firstObservationRow === undefined) throw new EventStoreError("CORRUPT_STORE", "first event observation is missing");
  const firstObservation = decodeObservation(database, firstObservationRow);
  if (firstObservation.disposition !== "accepted" || firstObservation.commitSequence !== firstCommitSequence ||
      firstObservation.event.source !== source || firstObservation.event.eventId !== eventId) {
    throw new EventStoreError("CORRUPT_STORE", "first event observation does not match its identity");
  }
  const computedFacts = canonicalizeEventFacts(firstObservation.event);
  if (computedFacts !== canonicalFacts || sha256(canonicalFacts) !== canonicalHash) {
    throw new EventStoreError("CORRUPT_STORE", "stored canonical facts or hash do not match the first observation");
  }
  assertFactMirrors(row, firstObservation.event);

  const originRow = database.prepare(`
    SELECT first_observation_key FROM event_origins WHERE source = ? AND event_id = ?
  `).get(source, eventId) as Record<string, unknown> | undefined;
  if (originRow === undefined || originRow.first_observation_key !== firstObservation.observationKey) {
    throw new EventStoreError("CORRUPT_STORE", "first origin does not point at the first observation");
  }
  const receipt = database.prepare(`
    SELECT * FROM event_receipts WHERE source = ? AND event_id = ?
  `).get(source, eventId) as Record<string, unknown> | undefined;
  if (receipt === undefined || receipt.canonical_hash !== canonicalHash ||
      receipt.first_commit_sequence !== firstCommitSequence || typeof receipt.committed_at !== "string" ||
      receipt.committed_at.length === 0) {
    throw new EventStoreError("CORRUPT_STORE", "first event receipt does not match its fact");
  }
  return Object.freeze({
    source,
    eventId,
    canonicalFacts,
    canonicalHash,
    firstCommitSequence,
    firstEvent: firstObservation.event,
    firstOrigin: firstObservation.origin,
    firstObservation,
    committedAt: receipt.committed_at,
  });
}

function decodeObservation(database: SQLiteConnection, row: Record<string, unknown>): EventObservation {
  const observationKey = normalizeHash(row.observation_key, "stored observation_key");
  const source = textColumn(row, "source");
  const eventId = textColumn(row, "event_id");
  const commitSequence = positiveSequence(row.commit_sequence, "observation commit_sequence");
  const factSequenceRow = database.prepare(`
    SELECT first_commit_sequence FROM events WHERE source = ? AND event_id = ?
  `).get(source, eventId) as Record<string, unknown> | undefined;
  if (factSequenceRow === undefined) throw new EventStoreError("CORRUPT_STORE", "observation has no owning fact");
  const firstCommitSequence = positiveSequence(factSequenceRow.first_commit_sequence, "first_commit_sequence");
  const eventJson = textColumn(row, "event_json");
  const event = parseCanonicalEvent(eventJson);
  if (event.source !== source || event.eventId !== eventId || event.observedAt !== row.observed_at ||
      event.sourceSequence !== row.source_sequence) {
    throw new EventStoreError("CORRUPT_STORE", "observation event does not match its identity or delivery mirrors");
  }
  const canonicalFacts = canonicalizeEventFacts(event);
  const candidateHash = normalizeHash(row.candidate_hash, "stored candidate_hash");
  if (sha256(canonicalFacts) !== candidateHash) {
    throw new EventStoreError("CORRUPT_STORE", "observation candidate hash does not match its event");
  }
  assertObservationMirrors(row, event);
  const originJson = textColumn(row, "origin_json");
  const origin = parseCanonicalOrigin(originJson);
  const disposition = observationDisposition(row.disposition);
  const conflictFacts = row.conflict_facts_json;
  if (disposition === "identity_conflict") {
    if (conflictFacts !== canonicalFacts) throw new EventStoreError("CORRUPT_STORE", "conflict candidate mirror is invalid");
  } else if (conflictFacts !== null) {
    throw new EventStoreError("CORRUPT_STORE", "non-conflict observation contains conflict facts");
  }

  const materialRow = database.prepare("SELECT * FROM transcript_materials WHERE observation_key = ?")
    .get(observationKey) as Record<string, unknown> | undefined;
  let capture: TranscriptCapture | undefined;
  if (materialRow !== undefined) {
    capture = decodeTranscriptMaterial(materialRow, event);
  }
  const bundleJson = canonicalizeAppendBundle({
    event,
    origin,
    ...(capture === undefined ? {} : { capture }),
  });
  if (sha256(bundleJson) !== observationKey) {
    throw new EventStoreError("CORRUPT_STORE", "observation key does not match the stored bundle");
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

function decodeTranscriptMaterial(row: Record<string, unknown>, event: NormalizedEvent): TranscriptCapture {
  if (row.schema_version !== 1) throw new EventStoreError("CORRUPT_STORE", "transcript material schema is invalid");
  const snapshotBlob = row.snapshot_json;
  if (!(snapshotBlob instanceof Uint8Array) || snapshotBlob.byteLength < 1 || snapshotBlob.byteLength > MAX_CAPTURE_BYTES) {
    throw new EventStoreError("CORRUPT_STORE", "transcript snapshot blob is invalid");
  }
  const snapshotJson = new TextDecoder("utf-8", { fatal: true }).decode(snapshotBlob);
  let snapshotUnknown: unknown;
  try { snapshotUnknown = JSON.parse(snapshotJson); } catch (error) {
    throw new EventStoreError("CORRUPT_STORE", "transcript snapshot JSON is malformed", { cause: error });
  }
  const captureOriginJson = textColumn(row, "capture_origin_json");
  let originUnknown: unknown;
  try { originUnknown = JSON.parse(captureOriginJson); } catch (error) {
    throw new EventStoreError("CORRUPT_STORE", "capture origin JSON is malformed", { cause: error });
  }
  const captureInput = {
    schemaVersion: row.schema_version,
    sessionId: row.session_id,
    turnId: row.turn_id,
    hookEventName: row.hook_event_name,
    origin: originUnknown,
    snapshot: snapshotUnknown,
    snapshotSha256: row.snapshot_sha256,
  };
  let normalized: TranscriptCapture;
  try { normalized = normalizeCapture(captureInput, event); } catch (error) {
    throw new EventStoreError("CORRUPT_STORE", "stored transcript material failed validation", { cause: error });
  }
  const normalizedOriginJson = canonicalizeJson(normalized.origin as unknown as JsonValue);
  const normalizedSnapshotJson = canonicalizeJson(normalized.snapshot as unknown as JsonValue);
  if (normalizedOriginJson !== captureOriginJson || normalizedSnapshotJson !== snapshotJson ||
      normalized.snapshotSha256 !== row.snapshot_sha256 || normalized.sessionId !== row.session_id ||
      normalized.turnId !== row.turn_id || normalized.hookEventName !== row.hook_event_name) {
    throw new EventStoreError("CORRUPT_STORE", "stored transcript material mirrors do not match");
  }
  return normalized;
}

function validateObservationDisposition(observation: EventObservation, fact: FactRecord): void {
  const facts = canonicalizeEventFacts(observation.event);
  const expected = observation.commitSequence === fact.firstCommitSequence
    ? "accepted"
    : facts !== fact.canonicalFacts
      ? "identity_conflict"
      : observation.event.sourceSequence !== fact.firstEvent.sourceSequence
        ? "redelivery_resequenced"
        : "duplicate";
  if (observation.disposition !== expected ||
      (expected === "accepted" && observation.observationKey !== fact.firstObservation.observationKey)) {
    throw new EventStoreError("CORRUPT_STORE", "observation disposition does not match the first fact");
  }
}

function parseCanonicalEvent(value: string): NormalizedEvent {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new EventStoreError("CORRUPT_STORE", "stored event JSON is malformed", { cause: error });
  }
  let event: NormalizedEvent;
  try { event = normalizeRuntimeEvent(parsed); } catch (error) {
    throw new EventStoreError("CORRUPT_STORE", "stored event failed normalization", { cause: error });
  }
  if (canonicalizeJson(event as unknown as JsonValue) !== value) {
    throw new EventStoreError("CORRUPT_STORE", "stored event JSON is not canonical");
  }
  return event;
}

function parseCanonicalOrigin(value: string): EventOriginInput {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new EventStoreError("CORRUPT_STORE", "stored origin JSON is malformed", { cause: error });
  }
  let origin: NormalizedOrigin;
  try { origin = normalizeOrigin(parsed); } catch (error) {
    throw new EventStoreError("CORRUPT_STORE", "stored origin failed validation", { cause: error });
  }
  if (canonicalizeJson(origin as unknown as JsonValue) !== value) {
    throw new EventStoreError("CORRUPT_STORE", "stored origin JSON is not canonical");
  }
  return origin;
}

function canonicalizeAppendBundle(bundle: Pick<NormalizedBundle, "event" | "origin"> & { readonly capture?: TranscriptCapture }): string {
  return canonicalizeJson({
    event: bundle.event,
    origin: bundle.origin,
    ...(bundle.capture === undefined ? {} : { capture: bundle.capture }),
  } as unknown as JsonValue);
}

function assertFactMirrors(row: Record<string, unknown>, event: NormalizedEvent): void {
  for (const [field, column] of Object.entries(SCOPE_COLUMNS)) {
    if (row[column] !== event.scope[field as keyof typeof event.scope]) {
      throw new EventStoreError("CORRUPT_STORE", `event ${column} mirror does not match canonical facts`);
    }
  }
  if (row.source !== event.source || row.event_id !== event.eventId || row.attempt_id !== event.attemptId ||
      row.operation_id !== event.operationId || row.kind !== event.kind || row.occurred_at !== event.occurredAt) {
    throw new EventStoreError("CORRUPT_STORE", "event identity or operation mirrors do not match canonical facts");
  }
}

function assertObservationMirrors(row: Record<string, unknown>, event: NormalizedEvent): void {
  for (const [field, column] of Object.entries(CANDIDATE_SCOPE_COLUMNS)) {
    if (row[column] !== event.scope[field as keyof typeof event.scope]) {
      throw new EventStoreError("CORRUPT_STORE", `observation ${column} mirror does not match its event`);
    }
  }
  if (row.candidate_attempt_id !== event.attemptId || row.candidate_operation_id !== event.operationId ||
      row.candidate_kind !== event.kind) {
    throw new EventStoreError("CORRUPT_STORE", "observation candidate mirrors do not match its event");
  }
}

function buildFactQuery(query: ReadQuery): QueryPlan {
  const normalized = normalizeReadQuery(query);
  const clauses: string[] = [];
  const values: (string | number | null)[] = [];
  if (normalized.after !== undefined) { clauses.push("first_commit_sequence > ?"); values.push(normalized.after); }
  appendScopeFilters(clauses, values, normalized.scope, SCOPE_COLUMNS);
  if (normalized.operationId !== undefined) { clauses.push("operation_id = ?"); values.push(normalized.operationId); }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  return Object.freeze({
    sql: `SELECT source, event_id FROM events ${where} ORDER BY first_commit_sequence LIMIT ?`,
    values: Object.freeze([...values, normalized.limit + 1]),
    limit: normalized.limit,
  });
}

function buildObservationQuery(query: ReadQuery): QueryPlan {
  const normalized = normalizeReadQuery(query);
  const clauses: string[] = [];
  const values: (string | number | null)[] = [];
  if (normalized.after !== undefined) { clauses.push("commit_sequence > ?"); values.push(normalized.after); }
  appendScopeFilters(clauses, values, normalized.scope, CANDIDATE_SCOPE_COLUMNS);
  if (normalized.operationId !== undefined) { clauses.push("candidate_operation_id = ?"); values.push(normalized.operationId); }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  return Object.freeze({
    sql: `SELECT * FROM event_observations ${where} ORDER BY commit_sequence LIMIT ?`,
    values: Object.freeze([...values, normalized.limit + 1]),
    limit: normalized.limit,
  });
}

function normalizeReadQuery(query: ReadQuery): {
  readonly limit: number;
  readonly after?: number;
  readonly scope?: Partial<{ sessionId: string | null; turnId: string | null; runId: string | null; taskId: string | null }>;
  readonly operationId?: string;
} {
  if (!hasExactFields(query, [], ["limit", "afterCommitSequence", "scope", "operationId"])) {
    throw new EventStoreError("INVALID_INPUT", "read query has invalid fields");
  }
  const limit = query.limit ?? DEFAULT_READ_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    throw new EventStoreError("INVALID_INPUT", `read limit must be from 1 through ${MAX_READ_LIMIT}`);
  }
  let after: number | undefined;
  if (query.afterCommitSequence !== undefined) {
    if (!Number.isSafeInteger(query.afterCommitSequence) || query.afterCommitSequence < 0) {
      throw new EventStoreError("INVALID_INPUT", "afterCommitSequence must be a non-negative safe integer");
    }
    after = query.afterCommitSequence;
  }
  let scope: ReturnType<typeof normalizeScopeFilter> | undefined;
  if (query.scope !== undefined) scope = normalizeScopeFilter(query.scope);
  let operationId: string | undefined;
  if (query.operationId !== undefined) operationId = boundedString(query.operationId, "operationId", 1024);
  return Object.freeze({
    limit,
    ...(after === undefined ? {} : { after }),
    ...(scope === undefined ? {} : { scope }),
    ...(operationId === undefined ? {} : { operationId }),
  });
}

function normalizeScopeFilter(value: unknown): Partial<{ sessionId: string | null; turnId: string | null; runId: string | null; taskId: string | null }> {
  const fields = ["sessionId", "turnId", "runId", "taskId"] as const;
  if (!hasExactFields(value, [], fields)) throw new EventStoreError("INVALID_INPUT", "scope filter has invalid fields");
  const result: { sessionId?: string | null; turnId?: string | null; runId?: string | null; taskId?: string | null } = {};
  for (const field of fields) {
    const item = (value as Record<string, unknown>)[field];
    if (item === undefined) continue;
    if (item !== null && (typeof item !== "string" || item.trim().length === 0 || Buffer.byteLength(item, "utf8") > 1024)) {
      throw new EventStoreError("INVALID_INPUT", `scope ${field} filter is invalid`);
    }
    result[field] = item as string | null;
  }
  if (Object.keys(result).length === 0) throw new EventStoreError("INVALID_INPUT", "scope filter must select at least one field");
  return Object.freeze(result);
}

function appendScopeFilters(
  clauses: string[],
  values: (string | number | null)[],
  scope: ReturnType<typeof normalizeScopeFilter> | undefined,
  columns: Readonly<Record<string, string>>,
): void {
  if (scope === undefined) return;
  for (const [field, value] of Object.entries(scope)) {
    clauses.push(`${columns[field]} IS ?`);
    values.push(value ?? null);
  }
}

function makePage<T>(items: readonly T[], hasMore: boolean): ReadPage<T> {
  const last = items.at(-1) as (T & { readonly commitSequence?: number }) | undefined;
  return Object.freeze({
    items: Object.freeze([...items]),
    hasMore,
    nextAfterCommitSequence: hasMore && last !== undefined && typeof last.commitSequence === "number"
      ? last.commitSequence
      : null,
  });
}

function selectObservationRow(database: SQLiteConnection, observationKey: string): Record<string, unknown> | undefined {
  return database.prepare("SELECT * FROM event_observations WHERE observation_key = ?")
    .get(observationKey) as Record<string, unknown> | undefined;
}

function normalizeIdentity(value: { readonly source: string; readonly eventId: string }): { source: string; eventId: string } {
  if (!hasExactFields(value, ["source", "eventId"])) throw new EventStoreError("INVALID_INPUT", "identity has invalid fields");
  return Object.freeze({
    source: boundedString(value.source, "source", 1024),
    eventId: boundedString(value.eventId, "eventId", 1024),
  });
}

function hasExactFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
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

function boundedString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > maxBytes) throw new TypeError(`${name} is invalid or too long`);
  return value;
}

function normalizeHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new TypeError(`${name} must be SHA-256 hex`);
  return value.toLowerCase();
}

function isHash(value: string): boolean { return HASH_PATTERN.test(value); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function observationDisposition(value: unknown): EventObservation["disposition"] {
  if (value === "accepted" || value === "duplicate" || value === "redelivery_resequenced" || value === "identity_conflict") {
    return value;
  }
  throw new EventStoreError("CORRUPT_STORE", "stored observation disposition is unsupported");
}

function pragmaNumber(database: SQLiteConnection, name: "user_version" | "synchronous" | "foreign_keys" | "busy_timeout"): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  if (row === undefined) throw new EventStoreError("SQLITE_ERROR", `PRAGMA ${name} returned no row`);
  const value = name === "busy_timeout" ? row.timeout : row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new EventStoreError("SQLITE_ERROR", `PRAGMA ${name} returned an invalid value`);
  }
  return value;
}

function positiveSequence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new EventStoreError("CORRUPT_STORE", `${label} is not a positive safe integer`);
  }
  return value;
}

function textColumn(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new EventStoreError("CORRUPT_STORE", `${column} is not text`);
  return value;
}

function numberColumn(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new EventStoreError("CORRUPT_STORE", `${column} is not a safe integer`);
  }
  return value;
}

function mapReadError(error: unknown): EventStoreError {
  if (error instanceof EventStoreError) return error;
  const mapped = mapSqliteError(error);
  if (mapped.code === "BUSY" || mapped.code === "FULL" || mapped.code === "READONLY") return mapped;
  return new EventStoreError("CORRUPT_STORE", "event store could not validate its stored rows", { cause: error });
}

function mapOpenError(error: unknown): EventStoreError {
  if (error instanceof EventStoreError) return error;
  return mapSqliteError(error);
}

function mapSqliteError(error: unknown): EventStoreError {
  if (error instanceof SQLiteIntegerRangeError) {
    return new EventStoreError("CORRUPT_STORE", "SQLite returned an integer outside the JavaScript safe integer range", { cause: error });
  }
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = `${String(record.code ?? "")} ${String(record.errcode ?? "")} ${message}`.toUpperCase();
  if (diagnostic.includes("SQLITE_BUSY") || /DATABASE IS (LOCKED|BUSY)/i.test(message)) {
    return new EventStoreError("BUSY", "SQLite writer remained busy within the bounded wait", { cause: error });
  }
  if (diagnostic.includes("SQLITE_FULL") || /DATABASE OR DISK IS FULL/i.test(message)) {
    return new EventStoreError("FULL", "SQLite database reached its configured page limit", { cause: error });
  }
  if (diagnostic.includes("SQLITE_READONLY") || /READ-ONLY|READONLY/i.test(message)) {
    return new EventStoreError("READONLY", "SQLite database is read-only", { cause: error });
  }
  if (diagnostic.includes("SQLITE_CORRUPT") || diagnostic.includes("SQLITE_NOTADB") || /MALFORMED|NOT A DATABASE/i.test(message)) {
    return new EventStoreError("CORRUPT_STORE", "SQLite database is corrupt or has an unknown format", { cause: error });
  }
  return new EventStoreError("SQLITE_ERROR", "SQLite operation failed", { cause: error });
}

function asAppendFailureCode(code: StoreErrorCode): AppendFailureCode {
  if (code === "BUSY" || code === "FULL" || code === "READONLY" || code === "CORRUPT_STORE" ||
      code === "SEQUENCE_EXHAUSTED") return code;
  return "SQLITE_ERROR";
}
