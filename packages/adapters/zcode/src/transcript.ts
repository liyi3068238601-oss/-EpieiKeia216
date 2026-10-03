import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { canonicalizeJson } from "../../../contracts/src/events.js";
import type { JsonValue } from "../../../contracts/src/json-value.js";

const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const STATUS_LIMIT = 64;
const DEFAULT_MAX_PENDING = 32;

export type TranscriptHookEvent = "UserPromptSubmit" | "Stop";

export interface UserPromptSubmitTranscriptInput {
  readonly hookEventName: "UserPromptSubmit";
  readonly sessionId: string;
  readonly turnId: string;
  readonly transcriptPath: string;
  readonly prompt: string;
}

export interface StopTranscriptInput {
  readonly hookEventName: "Stop";
  readonly sessionId: string;
  readonly turnId: string;
  readonly transcriptPath: string;
  readonly responseText?: string;
  readonly responsePreview?: string;
}

export type TranscriptHookInput = UserPromptSubmitTranscriptInput | StopTranscriptInput;

export interface TranscriptHookTrace {
  readonly hookEventName: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface CaptureTranscriptInput {
  readonly hookInput: TranscriptHookInput;
  readonly trace: TranscriptHookTrace;
  readonly ownedTempRoot: string;
  readonly sourcePin: string;
}

export type CaptureRejectionCode =
  | "invalid_input"
  | "trace_mismatch"
  | "outside_owned_temp"
  | "linked_path"
  | "not_regular_file"
  | "missing"
  | "unreadable"
  | "too_large"
  | "unstable_read"
  | "invalid_utf8"
  | "incomplete_line"
  | "malformed_jsonl"
  | "message_mismatch";

export interface TranscriptMessageSnapshot {
  readonly role: "user" | "assistant";
  readonly text: "[REDACTED]";
  readonly textBytes: number;
  readonly textSha256: string;
}

export interface TranscriptSnapshot {
  readonly schemaVersion: 1;
  readonly redactionVersion: "full-mask-v1";
  readonly messages: readonly TranscriptMessageSnapshot[];
}

export interface TranscriptOrigin {
  /** Relative to ownedTempRoot and retained only as historical provenance. */
  readonly temporaryLocator: string;
  readonly locatorUse: "historical-only";
  readonly rawBytes: number;
  readonly rawSha256: string;
  readonly sourcePin: string;
  readonly extent: "current-message";
  readonly rawRetained: false;
}

export interface TranscriptCapture {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly hookEventName: TranscriptHookEvent;
  readonly origin: TranscriptOrigin;
  readonly snapshot: TranscriptSnapshot;
  readonly snapshotSha256: string;
}

export type CaptureTranscriptResult =
  | { readonly status: "captured"; readonly capture: TranscriptCapture }
  | { readonly status: "rejected"; readonly code: CaptureRejectionCode };

export type TranscriptSinkReceipt =
  | { readonly status: "saved"; readonly receiptId: string; readonly snapshotSha256: string }
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "unknown"; readonly code: string };

export type TranscriptSink = (capture: Readonly<TranscriptCapture>) => Promise<TranscriptSinkReceipt>;

export type TranscriptJobState = "queued" | "saving" | "saved" | "failed" | "unknown";

export interface TranscriptJobStatus {
  readonly jobId: number;
  readonly status: TranscriptJobState;
  readonly snapshotSha256: string;
  readonly receiptId?: string;
  readonly code?: string;
}

export type TranscriptEnqueueResult =
  | { readonly status: "queued"; readonly jobId: number }
  | { readonly status: "queue_full" | "closed" | "invalid_capture" };

export interface TranscriptQueueOptions {
  readonly sink: TranscriptSink;
  /** Maximum in-flight plus waiting jobs. Defaults to 32; accepted range is 1..64. */
  readonly maxPending?: number;
}

export interface TranscriptQueue {
  enqueue(capture: TranscriptCapture): TranscriptEnqueueResult;
  getStatus(jobId: number): TranscriptJobStatus | undefined;
  readRecentStatuses(limit?: number): readonly TranscriptJobStatus[];
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Capture the one current Hook message while its transient JSONL still exists. */
export function captureTranscript(input: CaptureTranscriptInput): CaptureTranscriptResult {
  try {
    const normalized = validateCaptureInput(input);
    const read = readOwnedTranscript(normalized.ownedTempRoot, normalized.hookInput.transcriptPath);
    const record = parseTranscriptRecord(read.bytes);
    const expectedRole = normalized.hookInput.hookEventName === "UserPromptSubmit" ? "user" : "assistant";
    const expectedText = normalized.hookInput.hookEventName === "UserPromptSubmit"
      ? normalized.hookInput.prompt
      : normalized.hookInput.responseText ?? normalized.hookInput.responsePreview;
    if (record.role !== expectedRole || expectedText === undefined || record.text !== expectedText) {
      throw new CaptureFailure("message_mismatch");
    }

    const message: TranscriptMessageSnapshot = Object.freeze({
      role: expectedRole,
      text: "[REDACTED]",
      textBytes: Buffer.byteLength(record.text, "utf8"),
      textSha256: sha256(Buffer.from(record.text, "utf8")),
    });
    const snapshot: TranscriptSnapshot = Object.freeze({
      schemaVersion: 1,
      redactionVersion: "full-mask-v1",
      messages: Object.freeze([message]),
    });
    const rootRelativePath = path.relative(normalized.ownedTempRoot, normalized.transcriptPath);
    const temporaryLocator = rootRelativePath.split(path.sep).join("/");
    const origin: TranscriptOrigin = Object.freeze({
      temporaryLocator,
      locatorUse: "historical-only",
      rawBytes: read.bytes.byteLength,
      rawSha256: sha256(read.bytes),
      sourcePin: normalized.sourcePin,
      extent: "current-message",
      rawRetained: false,
    });
    const capture: TranscriptCapture = Object.freeze({
      schemaVersion: 1,
      sessionId: normalized.hookInput.sessionId,
      turnId: normalized.hookInput.turnId,
      hookEventName: normalized.hookInput.hookEventName,
      origin,
      snapshot,
      snapshotSha256: snapshotSha256(snapshot),
    });
    return Object.freeze({ status: "captured", capture });
  } catch (error) {
    return Object.freeze({ status: "rejected", code: rejectionCode(error) });
  }
}

/** A bounded, single-writer queue; enqueue never waits for sink work. */
export function createTranscriptQueue(options: TranscriptQueueOptions): TranscriptQueue {
  if (!isPlainRecord(options) || typeof options.sink !== "function") {
    throw new TypeError("transcript queue requires a sink function");
  }
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > STATUS_LIMIT) {
    throw new RangeError("transcript queue maxPending must be an integer from 1 through 64");
  }

  let closed = false;
  let pumping = false;
  let pumpScheduled = false;
  let nextJobId = 1;
  const waiting: QueueJob[] = [];
  const pending = new Map<number, QueueJob>();
  const statuses = new Map<number, TranscriptJobStatus>();
  const setStatus = (status: TranscriptJobStatus): void => {
    statuses.set(status.jobId, Object.freeze({ ...status }));
    while (statuses.size > STATUS_LIMIT) {
      const oldest = statuses.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      statuses.delete(oldest);
    }
  };

  const schedulePump = (): void => {
    if (pumping || pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      void pump();
    });
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length > 0) {
        const job = waiting.shift();
        if (!job) continue;
        setStatus({ jobId: job.jobId, status: "saving", snapshotSha256: job.capture.snapshotSha256 });
        let terminal: TranscriptJobStatus;
        try {
          terminal = resolveSinkReceipt(job, await options.sink(job.capture));
        } catch {
          terminal = { jobId: job.jobId, status: "unknown", snapshotSha256: job.capture.snapshotSha256, code: "sink_threw" };
        }
        setStatus(terminal);
        pending.delete(job.jobId);
        job.resolveSettled();
      }
    } finally {
      pumping = false;
      if (waiting.length > 0) schedulePump();
    }
  };

  const drain = (): Promise<void> => {
    const acceptedFrontier = [...pending.values()].map((job) => job.settled);
    return acceptedFrontier.length === 0 ? Promise.resolve() : Promise.all(acceptedFrontier).then(() => undefined);
  };

  return Object.freeze({
    enqueue(capture: TranscriptCapture): TranscriptEnqueueResult {
      if (closed) return Object.freeze({ status: "closed" });
      if (pending.size >= maxPending) return Object.freeze({ status: "queue_full" });
      const snapshot = copyValidatedCapture(capture);
      if (!snapshot) return Object.freeze({ status: "invalid_capture" });
      const jobId = nextJobId;
      if (!Number.isSafeInteger(jobId)) throw new RangeError("transcript queue job id space exhausted");
      nextJobId += 1;
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
      const job: QueueJob = { jobId, capture: snapshot, settled, resolveSettled };
      pending.set(jobId, job);
      waiting.push(job);
      setStatus({ jobId, status: "queued", snapshotSha256: snapshot.snapshotSha256 });
      schedulePump();
      return Object.freeze({ status: "queued", jobId });
    },
    getStatus(jobId: number): TranscriptJobStatus | undefined {
      return statuses.get(jobId);
    },
    readRecentStatuses(limit = STATUS_LIMIT): readonly TranscriptJobStatus[] {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > STATUS_LIMIT) {
        throw new RangeError("transcript status read limit must be an integer from 0 through 64");
      }
      return Object.freeze(limit === 0 ? [] : [...statuses.values()].slice(-limit));
    },
    drain,
    async close(): Promise<void> {
      closed = true;
      await drain();
    },
  });
}

interface NormalizedCaptureInput {
  readonly hookInput: TranscriptHookInput;
  readonly ownedTempRoot: string;
  readonly transcriptPath: string;
  readonly sourcePin: string;
}

interface ReadTranscriptResult {
  readonly bytes: Buffer;
}

interface ParsedTranscriptRecord {
  readonly role: "user" | "assistant";
  readonly text: string;
}

interface QueueJob {
  readonly jobId: number;
  readonly capture: TranscriptCapture;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

class CaptureFailure extends Error {
  constructor(readonly code: CaptureRejectionCode) {
    super(code);
  }
}

function validateCaptureInput(input: unknown): NormalizedCaptureInput {
  if (!isPlainRecord(input) || !hasExactKeys(input, ["hookInput", "trace", "ownedTempRoot", "sourcePin"])) {
    throw new CaptureFailure("invalid_input");
  }
  const hook = input.hookInput;
  const trace = input.trace;
  if (!isPlainRecord(hook) || !isPlainRecord(trace) ||
      typeof input.ownedTempRoot !== "string" || !path.isAbsolute(input.ownedTempRoot) ||
      typeof input.sourcePin !== "string" || input.sourcePin.length === 0 || input.sourcePin.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(input.sourcePin)) {
    throw new CaptureFailure("invalid_input");
  }

  const event = hook.hookEventName;
  const commonKeys = ["hookEventName", "sessionId", "turnId", "transcriptPath"];
  let validMessage = false;
  if (event === "UserPromptSubmit") {
    validMessage = hasExactKeys(hook, [...commonKeys, "prompt"]) && typeof hook.prompt === "string";
  } else if (event === "Stop") {
    const keys = Object.keys(hook);
    validMessage = keys.every((key) => [...commonKeys, "responseText", "responsePreview"].includes(key)) &&
      commonKeys.every((key) => Object.hasOwn(hook, key)) &&
      (hook.responseText === undefined || typeof hook.responseText === "string") &&
      (hook.responsePreview === undefined || typeof hook.responsePreview === "string") &&
      (typeof hook.responseText === "string" || typeof hook.responsePreview === "string");
  }
  if (!validMessage || !hasExactKeys(trace, ["hookEventName", "sessionId", "turnId"])) {
    throw new CaptureFailure("invalid_input");
  }
  if (event !== "UserPromptSubmit" && event !== "Stop") throw new CaptureFailure("invalid_input");
  for (const key of ["sessionId", "turnId", "transcriptPath"] as const) {
    if (typeof hook[key] !== "string" || hook[key].length === 0 || /[\u0000-\u001f\u007f]/u.test(hook[key] as string)) {
      throw new CaptureFailure("invalid_input");
    }
  }
  if (typeof trace.hookEventName !== "string" || typeof trace.sessionId !== "string" || typeof trace.turnId !== "string") {
    throw new CaptureFailure("invalid_input");
  }
  if (trace.hookEventName !== event || trace.sessionId !== hook.sessionId || trace.turnId !== hook.turnId) {
    throw new CaptureFailure("trace_mismatch");
  }
  if (typeof hook.transcriptPath !== "string" || !path.isAbsolute(hook.transcriptPath)) {
    throw new CaptureFailure("invalid_input");
  }

  const hookInput = event === "UserPromptSubmit"
    ? Object.freeze({
        hookEventName: event,
        sessionId: hook.sessionId as string,
        turnId: hook.turnId as string,
        transcriptPath: hook.transcriptPath,
        prompt: hook.prompt as string,
      })
    : Object.freeze({
        hookEventName: event,
        sessionId: hook.sessionId as string,
        turnId: hook.turnId as string,
        transcriptPath: hook.transcriptPath,
        ...(typeof hook.responseText === "string" ? { responseText: hook.responseText } : {}),
        ...(typeof hook.responsePreview === "string" ? { responsePreview: hook.responsePreview } : {}),
      });
  return Object.freeze({
    hookInput,
    ownedTempRoot: path.resolve(input.ownedTempRoot),
    transcriptPath: path.resolve(hook.transcriptPath),
    sourcePin: input.sourcePin,
  });
}

function readOwnedTranscript(ownedTempRoot: string, transcriptPath: string): ReadTranscriptResult {
  let descriptor: number | undefined;
  try {
    const rootRealPath = realpathSync(ownedTempRoot);
    const rootStats = lstatSync(rootRealPath);
    if (!rootStats.isDirectory()) throw new CaptureFailure("not_regular_file");
    const relative = path.relative(ownedTempRoot, transcriptPath);
    if (!isContainedPath(ownedTempRoot, transcriptPath) || relative.length === 0) {
      throw new CaptureFailure("outside_owned_temp");
    }
    const segments = relative.split(path.sep);
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new CaptureFailure("outside_owned_temp");
    }

    let current = rootRealPath;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) throw new CaptureFailure("linked_path");
      const last = index === segments.length - 1;
      if (last ? !stats.isFile() : !stats.isDirectory()) throw new CaptureFailure("not_regular_file");
    }
    const realFilePath = realpathSync(current);
    if (!isContainedPath(rootRealPath, realFilePath)) throw new CaptureFailure("outside_owned_temp");

    const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
    descriptor = openSync(realFilePath, flags);
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new CaptureFailure("not_regular_file");
    if (before.size > MAX_TRANSCRIPT_BYTES) throw new CaptureFailure("too_large");

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_TRANSCRIPT_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_TRANSCRIPT_BYTES + 1 - total));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_TRANSCRIPT_BYTES) throw new CaptureFailure("too_large");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(realFilePath);
    if (pathAfter.isSymbolicLink()) throw new CaptureFailure("linked_path");
    if (!sameFileVersion(before, after) || !sameFileVersion(after, pathAfter) || total !== after.size) {
      throw new CaptureFailure("unstable_read");
    }
    return { bytes: Buffer.concat(chunks, total) };
  } catch (error) {
    if (error instanceof CaptureFailure) throw error;
    throw new CaptureFailure(fsErrorCode(error));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseTranscriptRecord(bytes: Buffer): ParsedTranscriptRecord {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CaptureFailure("invalid_utf8");
  }
  if (!text.endsWith("\n")) throw new CaptureFailure("incomplete_line");
  const line = text.slice(0, -1);
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) throw new CaptureFailure("malformed_jsonl");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new CaptureFailure("malformed_jsonl");
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.message) ||
      (parsed.message.role !== "user" && parsed.message.role !== "assistant") ||
      !Array.isArray(parsed.message.content)) {
    throw new CaptureFailure("malformed_jsonl");
  }
  let messageText = "";
  for (const item of parsed.message.content) {
    if (!isPlainRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") messageText += item.text;
  }
  return { role: parsed.message.role, text: messageText };
}

function copyValidatedCapture(value: unknown): TranscriptCapture | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "sessionId", "turnId", "hookEventName", "origin", "snapshot", "snapshotSha256",
  ]) || value.schemaVersion !== 1 ||
      (value.hookEventName !== "UserPromptSubmit" && value.hookEventName !== "Stop") ||
      !isNonEmptyString(value.sessionId) || !isNonEmptyString(value.turnId) ||
      !isSha256(value.snapshotSha256) || !isPlainRecord(value.origin) || !isPlainRecord(value.snapshot)) {
    return undefined;
  }
  const origin = value.origin;
  const snapshot = value.snapshot;
  if (!hasExactKeys(origin, ["temporaryLocator", "locatorUse", "rawBytes", "rawSha256", "sourcePin", "extent", "rawRetained"]) ||
      !isSafeRelativeLocator(origin.temporaryLocator) || origin.locatorUse !== "historical-only" ||
      !Number.isSafeInteger(origin.rawBytes) || (origin.rawBytes as number) < 0 || (origin.rawBytes as number) > MAX_TRANSCRIPT_BYTES ||
      !isSha256(origin.rawSha256) || !isNonEmptyString(origin.sourcePin) || origin.sourcePin.length > 256 ||
      origin.extent !== "current-message" || origin.rawRetained !== false ||
      !hasExactKeys(snapshot, ["schemaVersion", "redactionVersion", "messages"]) ||
      snapshot.schemaVersion !== 1 || snapshot.redactionVersion !== "full-mask-v1" ||
      !Array.isArray(snapshot.messages) || snapshot.messages.length !== 1) {
    return undefined;
  }
  const message = snapshot.messages[0];
  if (!isPlainRecord(message) || !hasExactKeys(message, ["role", "text", "textBytes", "textSha256"]) ||
      (message.role !== "user" && message.role !== "assistant") ||
      (value.hookEventName === "UserPromptSubmit" ? message.role !== "user" : message.role !== "assistant") ||
      message.text !== "[REDACTED]" || !Number.isSafeInteger(message.textBytes) ||
      (message.textBytes as number) < 0 || !isSha256(message.textSha256)) {
    return undefined;
  }

  const safeMessage: TranscriptMessageSnapshot = Object.freeze({
    role: message.role,
    text: "[REDACTED]",
    textBytes: message.textBytes as number,
    textSha256: message.textSha256,
  });
  const safeSnapshot: TranscriptSnapshot = Object.freeze({
    schemaVersion: 1,
    redactionVersion: "full-mask-v1",
    messages: Object.freeze([safeMessage]),
  });
  const calculatedSnapshotHash = snapshotSha256(safeSnapshot);
  if (calculatedSnapshotHash !== value.snapshotSha256) return undefined;

  const safeOrigin: TranscriptOrigin = Object.freeze({
    temporaryLocator: origin.temporaryLocator,
    locatorUse: "historical-only",
    rawBytes: origin.rawBytes as number,
    rawSha256: origin.rawSha256,
    sourcePin: origin.sourcePin,
    extent: "current-message",
    rawRetained: false,
  });
  return Object.freeze({
    schemaVersion: 1,
    sessionId: value.sessionId,
    turnId: value.turnId,
    hookEventName: value.hookEventName,
    origin: safeOrigin,
    snapshot: safeSnapshot,
    snapshotSha256: calculatedSnapshotHash,
  });
}

function resolveSinkReceipt(job: QueueJob, receipt: unknown): TranscriptJobStatus {
  if (!isPlainRecord(receipt) || typeof receipt.status !== "string") {
    return unknownStatus(job, "invalid_receipt");
  }
  if (receipt.status === "saved" && hasExactKeys(receipt, ["status", "receiptId", "snapshotSha256"]) &&
      isNonEmptyString(receipt.receiptId) && receipt.receiptId.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(receipt.receiptId) && receipt.snapshotSha256 === job.capture.snapshotSha256) {
    return {
      jobId: job.jobId,
      status: "saved",
      snapshotSha256: job.capture.snapshotSha256,
      receiptId: receipt.receiptId,
    };
  }
  if ((receipt.status === "failed" || receipt.status === "unknown") &&
      hasExactKeys(receipt, ["status", "code"]) && isSafeStatusCode(receipt.code)) {
    return {
      jobId: job.jobId,
      status: receipt.status,
      snapshotSha256: job.capture.snapshotSha256,
      code: receipt.code,
    };
  }
  return unknownStatus(job, "invalid_receipt");
}

function unknownStatus(job: QueueJob, code: string): TranscriptJobStatus {
  return { jobId: job.jobId, status: "unknown", snapshotSha256: job.capture.snapshotSha256, code };
}

function rejectionCode(error: unknown): CaptureRejectionCode {
  return error instanceof CaptureFailure ? error.code : fsErrorCode(error);
}

function fsErrorCode(error: unknown): CaptureRejectionCode {
  const code = error !== null && typeof error === "object" && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "unreadable";
  return "invalid_input";
}

function sameFileVersion(left: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isSafeRelativeLocator(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    !value.includes(":") && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isSafeStatusCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_.-]{1,64}$/iu.test(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotSha256(snapshot: TranscriptSnapshot): string {
  return sha256(Buffer.from(canonicalizeJson(snapshot as unknown as JsonValue), "utf8"));
}
