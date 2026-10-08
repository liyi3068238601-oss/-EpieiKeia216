import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

export const MAX_TOPIC_BYTES = 2 * 1024;
export const TURN_SNAPSHOT_KEY = Symbol.for("xiadie.p03.u02.native-memory-turn-snapshot");

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile() &&
    left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function decodeUtf8(bytes, filename) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("NUL is not allowed in a memory topic");
    return text;
  } catch (error) {
    const invalid = new Error(`P03_MEMORY_INVALID_UTF8: ${filename}`);
    invalid.code = "P03_MEMORY_INVALID_UTF8";
    invalid.cause = error;
    throw invalid;
  }
}

/** Read one owned topic through a stable file handle; never resolve arbitrary memory paths. */
export function readSelectedProjectMemory({ filename, memoryRoot, maxBytes = MAX_TOPIC_BYTES }) {
  const requested = path.resolve(filename);
  const rootPath = path.resolve(memoryRoot);
  const selectedPath = path.join(rootPath, "selected.md");
  if (requested !== selectedPath) {
    const error = new Error(`P03_MEMORY_PATH_NOT_ALLOWED: ${requested}`);
    error.code = "P03_MEMORY_PATH_NOT_ALLOWED";
    throw error;
  }

  let descriptor;
  try {
    const canonicalRoot = realpathSync(rootPath);
    if (!isWithin(canonicalRoot, requested)) {
      const error = new Error("P03_MEMORY_PATH_ESCAPE");
      error.code = "P03_MEMORY_PATH_ESCAPE";
      throw error;
    }
    const beforePath = lstatSync(requested);
    if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
      const error = new Error("P03_MEMORY_NOT_REGULAR_FILE");
      error.code = "P03_MEMORY_NOT_REGULAR_FILE";
      throw error;
    }
    if (realpathSync(requested) !== requested) {
      const error = new Error("P03_MEMORY_CANONICAL_PATH_CHANGED");
      error.code = "P03_MEMORY_CANONICAL_PATH_CHANGED";
      throw error;
    }
    descriptor = openSync(requested, "r");
    const openedBefore = fstatSync(descriptor);
    if (!openedBefore.isFile() || openedBefore.size > maxBytes) {
      const error = new Error(openedBefore.isFile() ? "P03_MEMORY_TOO_LARGE" : "P03_MEMORY_NOT_REGULAR_FILE");
      error.code = openedBefore.isFile() ? "too_large" : "P03_MEMORY_NOT_REGULAR_FILE";
      throw error;
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) {
      const error = new Error("P03_MEMORY_TOO_LARGE");
      error.code = "too_large";
      throw error;
    }
    const bytes = buffer.subarray(0, length);
    const openedAfter = fstatSync(descriptor);
    const afterPath = lstatSync(requested);
    if (!sameFileIdentity(openedBefore, openedAfter) || !sameFileIdentity(openedAfter, afterPath) ||
        realpathSync(requested) !== requested) {
      const error = new Error("P03_MEMORY_SOURCE_CHANGED_DURING_READ");
      error.code = "P03_MEMORY_SOURCE_CHANGED";
      throw error;
    }
    const text = decodeUtf8(bytes, requested);
    return {
      path: requested,
      bytes: Buffer.from(bytes),
      text,
      sizeBytes: bytes.byteLength,
      mtimeMs: openedAfter.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Per-Host synchronous snapshot state; callers must not share it across app instances. */
/** Synchronous host-admission provider. It returns only a data-partition record. */
export function createProjectMemoryDataProvider({ memoryPath, memoryRoot, projectId, samples }) {
  return function dataProvider(sessionIdOrInput, operation = "turn") {
    globalThis[TURN_SNAPSHOT_KEY] = undefined;
    const sessionId = typeof sessionIdOrInput === "string" ? sessionIdOrInput : sessionIdOrInput?.sessionId;
    if (typeof sessionIdOrInput === "object" && sessionIdOrInput !== null && typeof sessionIdOrInput.operation === "string") {
      operation = sessionIdOrInput.operation;
    }
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("P03_MEMORY_SESSION_REQUIRED");
    }
    if (operation !== "turn") {
      samples.push({ status: "not_sampled", operation, reason: "non-turn admission" });
      return { state: [], evidence: [], content: [] };
    }
    const sampledAt = new Date().toISOString();
    let source;
    try {
      source = readSelectedProjectMemory({ filename: memoryPath, memoryRoot });
    } catch (error) {
      samples.push({ status: "failed", sessionId, operation, projectId, path: memoryPath, code: error?.code ?? "unknown" });
      throw error;
    }
    const sourceRef = `project-memory:${projectId}/selected.md@sha256:${source.sha256}`;
    const record = {
      source_refs: [sourceRef],
      value: {
        kind: "project-memory-topic",
        project_id: projectId,
        topic_path: "selected.md",
        sha256: source.sha256,
        sampled_at: sampledAt,
        authority: "experience-lead; verify against current source",
        text: source.text,
      },
    };
    globalThis[TURN_SNAPSHOT_KEY] = Object.freeze({
      sessionId,
      operation,
      projectId,
      memoryPath: source.path,
      sha256: source.sha256,
      sampledAt,
      bytes: source.bytes,
      text: source.text,
    });
    samples.push({
      status: "sampled",
      sessionId,
      operation,
      projectId,
      path: source.path,
      sha256: source.sha256,
      bytes: source.sizeBytes,
      sampledAt,
    });
    return { state: [], evidence: [], content: [record] };
  };
}

/** Native Read is bound to the exact admitted snapshot and fails if the source changed. */
export function readCurrentTurnMemory({ filename, memoryRoot }) {
  const snapshot = globalThis[TURN_SNAPSHOT_KEY];
  if (!snapshot || path.resolve(filename) !== snapshot.memoryPath) {
    const error = new Error(`P03_MEMORY_READ_NOT_SELECTED: ${path.resolve(filename)}`);
    error.code = "P03_MEMORY_READ_NOT_SELECTED";
    throw error;
  }
  const current = readSelectedProjectMemory({ filename, memoryRoot });
  if (current.sha256 !== snapshot.sha256 || current.text !== snapshot.text) {
    const error = new Error("P03_MEMORY_READ_SOURCE_CHANGED_AFTER_PREFLIGHT");
    error.code = "P03_MEMORY_SOURCE_CHANGED";
    throw error;
  }
  return { ...snapshot, bytes: Buffer.from(current.bytes), mtimeMs: current.mtimeMs };
}

export function fileStatIfPresent(filename) {
  try { return statSync(filename); }
  catch { return undefined; }
}
