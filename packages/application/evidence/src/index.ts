import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalizeEventFacts,
  normalizeRuntimeEvent,
  type BoundEventScope,
  type NormalizedEvent,
  type WriterOrderedEvent,
} from "../../../contracts/src/events.js";
import type { EventStore } from "../../../storage/events/src/index.js";

export const OWNED_ARTIFACT_INTEGRITY_PROFILE = "owned-artifact-integrity/v1" as const;

type Digest = Readonly<{ bytes: number; sha256: string }>;
type RunStatus = "exited" | "timed_out" | "spawn_failed";
type GitRevision = Readonly<{ commit: string; clean: boolean }>;

/** Identity metadata only: never includes paths, argument contents or shell text. */
export interface NodeCommandEvidence {
  readonly kind: "node-script";
  readonly nodeVersion: string;
  readonly scriptSha256: string;
  readonly argumentCount: number;
}

export interface OwnedNodeRun {
  readonly runId: string;
  readonly processId: number | null;
  readonly status: RunStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly expectedSourceCommit: string;
  readonly sourceCommitAtLaunch: string;
  readonly scriptSha256: string;
  readonly command: NodeCommandEvidence;
  readonly sourceCleanAtLaunch: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stdout: Digest;
  readonly stderr: Digest;
}

export interface RunOwnedNodeOptions {
  readonly repositoryRoot: string;
  /** Coordinator-frozen Xiadie revision the fixture is meant to exercise. */
  readonly expectedSourceCommit: string;
  /** A committed Node script path, relative to repositoryRoot. */
  readonly script: string;
  readonly args?: readonly string[];
}

export interface LocalEvidenceReaderOptions {
  readonly repositoryRoot: string;
  /** Existing output directory outside the source repository. */
  readonly artifactRoot: string;
  /** Coordinator-fixed native event source; not accepted from a receipt payload. */
  readonly expectedReceiptSource: string;
  readonly eventStore: EventStore;
}

export interface BuildEvidenceInput {
  readonly run: unknown;
  readonly scope: BoundEventScope;
  readonly attemptId: string;
  readonly operationId: string;
  readonly toolCallId: string;
  readonly artifactLocator: string;
}

/** Coordinator-internal trusted read seam; callers cannot supply their own pass facts. */
export interface EvidenceReader {
  inspectRevision(): GitRevision;
  inspectOwnedArtifact(locator: string): Promise<Digest | null>;
  readOperationFacts(operationId: string): WriterOrderedEvent[];
  readOperationObservations(operationId: string): unknown[];
  queryWriterReceipt(source: string, eventId: string): ReturnType<EventStore["queryReceipt"]>;
}

export interface EvidenceReport {
  readonly schemaVersion: 1;
  readonly profile: typeof OWNED_ARTIFACT_INTEGRITY_PROFILE;
  readonly scope: BoundEventScope;
  readonly attemptId: string;
  readonly operationId: string;
  readonly toolCallId: string;
  readonly execution: Readonly<{
    status: "passed" | "failed" | "unverified";
    processId: number | null;
    exitCode: number | null;
    signal: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    stdout: Digest | null;
    stderr: Digest | null;
    command: NodeCommandEvidence | null;
  }>;
  readonly toolReceipt: Readonly<{
    status: "verified" | "missing" | "invalid";
    source: string | null;
    eventId: string | null;
    commitSequence: number | null;
    canonicalHash: string | null;
  }>;
  readonly artifact: Readonly<{
    status: "verified" | "missing" | "unreadable";
    locator: string;
    bytes: number | null;
    sha256: string | null;
  }>;
  readonly sourceRevision: Readonly<{
    status: "verified" | "mismatch" | "unavailable";
    expectedCommit: string | null;
    commitAtLaunch: string | null;
    currentCommit: string | null;
    cleanAtLaunch: boolean | null;
    cleanNow: boolean | null;
  }>;
  readonly profileResult: Readonly<{
    status: "passed" | "failed" | "blocked";
    reasons: readonly string[];
  }>;
}

interface ReceiptData {
  readonly event: NormalizedEvent;
  readonly entry: WriterOrderedEvent;
  readonly operationId: string;
  readonly status: "success" | "failure" | "unknown";
  readonly result: {
    readonly profile: string;
    readonly runId: string;
    readonly processId: number;
    readonly toolCallId: string;
    readonly sourceCommitAtLaunch: string;
    readonly command?: NodeCommandEvidence;
    readonly artifact: { readonly locator: string; readonly bytes: number; readonly sha256: string };
  };
}

const ownedRuns = new WeakSet<object>();
const localReaders = new WeakSet<object>();
const ownedRunRoots = new WeakMap<object, string>();
const localReaderRoots = new WeakMap<object, string>();
const localReaderReceiptSources = new WeakMap<object, string>();
const MAX_RUN_MS = 30_000;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_PAGES = 32;

/**
 * Runs one committed Node script without a shell. The script must equal its HEAD
 * blob byte-for-byte. This fixed profile does not verify the script's dependency closure.
 * Output is reduced to byte counts and hashes as it streams; argv/raw output are never returned.
 */
export async function runOwnedNode(options: RunOwnedNodeOptions): Promise<OwnedNodeRun> {
  assertExactKeys(options, ["repositoryRoot", "expectedSourceCommit", "script"], ["args"]);
  if (typeof options.repositoryRoot !== "string" || typeof options.script !== "string" ||
      typeof options.expectedSourceCommit !== "string" ||
      !/^[a-f0-9]{40,64}$/i.test(options.expectedSourceCommit)) {
    throw new TypeError("repositoryRoot, script and a frozen expectedSourceCommit are required");
  }
  const argsInput = options.args ?? [];
  if (!Array.isArray(argsInput) || argsInput.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new TypeError("args must be strings");
  }
  const args = Object.freeze([...argsInput]);

  const repositoryRoot = await realpath(options.repositoryRoot);
  const rootStat = await lstat(repositoryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TypeError("repositoryRoot must be a real directory");
  const scriptPath = path.resolve(repositoryRoot, options.script);
  assertContained(repositoryRoot, scriptPath, false);
  const physicalScript = await realpath(scriptPath);
  assertContained(repositoryRoot, physicalScript, false);
  const scriptStat = await lstat(physicalScript);
  if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) throw new TypeError("script must be a regular file in repositoryRoot");
  if (scriptStat.size > MAX_SCRIPT_BYTES) throw new RangeError("script exceeds the fixed size limit");
  const scriptRelativePath = path.relative(repositoryRoot, physicalScript).split(path.sep).join("/");
  const trackedScriptPath = git(repositoryRoot, ["ls-files", "--error-unmatch", "--", scriptRelativePath]).trim();
  if (trackedScriptPath.replaceAll("\\", "/") !== scriptRelativePath) {
    throw new TypeError("script must be tracked by the expected source commit");
  }
  const scriptBytes = await readFile(physicalScript);
  const headScriptBytes = readHeadBlob(repositoryRoot, scriptRelativePath);
  if (scriptBytes.byteLength !== headScriptBytes.byteLength || !scriptBytes.equals(headScriptBytes)) {
    throw new TypeError("working script bytes do not match the HEAD blob");
  }

  const launchRevision = readGitRevision(repositoryRoot);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const processResult = await new Promise<{
    readonly processId: number | null;
    readonly status: RunStatus;
    readonly exitCode: number | null;
    readonly signal: string | null;
  }>((resolve) => {
    let spawnFailed = false;
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(process.execPath, [physicalScript, ...args], {
        cwd: repositoryRoot,
        env: safeEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ processId: null, status: "spawn_failed", exitCode: null, signal: null });
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; stdoutHash.update(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; stderrHash.update(chunk); });
    child.once("error", () => { spawnFailed = true; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, MAX_RUN_MS);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        processId: child.pid ?? null,
        status: spawnFailed ? "spawn_failed" : timedOut ? "timed_out" : "exited",
        exitCode: code,
        signal,
      });
    });
  });

  const value: OwnedNodeRun = Object.freeze({
    runId,
    processId: processResult.processId,
    status: processResult.status,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    expectedSourceCommit: options.expectedSourceCommit.toLowerCase(),
    sourceCommitAtLaunch: launchRevision.commit,
    scriptSha256: sha256(scriptBytes),
    command: Object.freeze({ kind: "node-script", nodeVersion: process.version,
      scriptSha256: sha256(scriptBytes), argumentCount: args.length }),
    sourceCleanAtLaunch: launchRevision.clean,
    startedAt,
    finishedAt: new Date().toISOString(),
    stdout: Object.freeze({ bytes: stdoutBytes, sha256: stdoutHash.digest("hex") }),
    stderr: Object.freeze({ bytes: stderrBytes, sha256: stderrHash.digest("hex") }),
  });
  ownedRuns.add(value as object);
  ownedRunRoots.set(value as object, repositoryRoot);
  return value;
}

/** Creates the fixed filesystem/Git/store read seam used by buildEvidenceReport. */
export async function createLocalEvidenceReader(options: LocalEvidenceReaderOptions): Promise<EvidenceReader> {
  assertExactKeys(options, ["repositoryRoot", "artifactRoot", "expectedReceiptSource", "eventStore"]);
  if (typeof options.expectedReceiptSource !== "string" || options.expectedReceiptSource.trim().length === 0) {
    throw new TypeError("expectedReceiptSource must be coordinator-fixed");
  }
  const repositoryRoot = await realpath(options.repositoryRoot);
  const artifactRoot = await realpath(options.artifactRoot);
  const repositoryStat = await lstat(repositoryRoot);
  const artifactStat = await lstat(artifactRoot);
  if (!repositoryStat.isDirectory() || repositoryStat.isSymbolicLink() ||
      !artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
    throw new TypeError("repositoryRoot and artifactRoot must be real directories");
  }
  if (isContained(repositoryRoot, artifactRoot) || isContained(artifactRoot, repositoryRoot)) {
    throw new TypeError("artifactRoot must be separate from repositoryRoot");
  }
  if (options.eventStore === null || typeof options.eventStore !== "object") {
    throw new TypeError("eventStore is required");
  }
  const readerValue = {
    inspectRevision: () => readGitRevision(repositoryRoot),
    inspectOwnedArtifact: (locator: string) => readOwnedArtifact(artifactRoot, locator),
    readOperationFacts: (operationId: string) => readOperationFacts(options.eventStore, operationId),
    readOperationObservations: (operationId: string) => readOperationObservations(options.eventStore, operationId),
    queryWriterReceipt: (source: string, eventId: string) => options.eventStore.queryReceipt({ source, eventId }),
  };
  const reader = Object.freeze(readerValue);
  localReaders.add(reader);
  localReaderRoots.set(reader, repositoryRoot);
  localReaderReceiptSources.set(reader, options.expectedReceiptSource);
  return reader;
}

/** Recomputes the one fixed integrity profile from actual runner, store, FS and Git facts. */
export async function buildEvidenceReport(input: BuildEvidenceInput, readerValue: EvidenceReader): Promise<EvidenceReport> {
  assertExactKeys(input, ["run", "scope", "attemptId", "operationId", "toolCallId", "artifactLocator"]);
  const scope = normalizeScope(input.scope);
  for (const [name, value] of Object.entries({
    attemptId: input.attemptId,
    operationId: input.operationId,
    toolCallId: input.toolCallId,
    artifactLocator: input.artifactLocator,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(name + " is required");
  }
  if (!localReaders.has(readerValue)) throw new TypeError("reader must be created by createLocalEvidenceReader");

  const reader = readerValue as {
    inspectRevision(): GitRevision;
    inspectOwnedArtifact(locator: string): Promise<Digest | null>;
    readOperationFacts(operationId: string): WriterOrderedEvent[];
    readOperationObservations(operationId: string): unknown[];
    queryWriterReceipt(source: string, eventId: string): ReturnType<EventStore["queryReceipt"]>;
  };
  const run = input.run !== null && typeof input.run === "object" && ownedRuns.has(input.run)
    ? input.run as OwnedNodeRun
    : undefined;
  const repositoryMatches = run !== undefined &&
    samePath(ownedRunRoots.get(run as object) ?? "", localReaderRoots.get(readerValue as object) ?? "");
  const reasons: string[] = [];
  const execution = run === undefined
    ? Object.freeze({
      status: "unverified" as const, processId: null, exitCode: null, signal: null,
      startedAt: null, finishedAt: null, stdout: null, stderr: null, command: null,
    })
    : Object.freeze({
      status: run.status === "exited" && run.exitCode === 0 ? "passed" as const : "failed" as const,
      processId: run.processId,
      exitCode: run.exitCode,
      signal: run.signal,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      stdout: run.stdout,
      stderr: run.stderr,
      command: run.command,
    });
  if (run === undefined) reasons.push("RUN_NOT_OWNED");
  else {
    if (run.status !== "exited" || run.exitCode !== 0) reasons.push("PROCESS_NOT_SUCCESSFUL");
    if (run.processId === null) reasons.push("PROCESS_ID_MISSING");
    if (scope.runId !== run.runId) reasons.push("SCOPE_RUN_MISMATCH");
    if (!repositoryMatches) reasons.push("REPOSITORY_MISMATCH");
    if (run.sourceCommitAtLaunch !== run.expectedSourceCommit) reasons.push("SOURCE_EXPECTATION_MISMATCH");
    if (!run.sourceCleanAtLaunch) reasons.push("SOURCE_DIRTY_AT_LAUNCH");
  }

  let artifactDigest: Digest | null = null;
  let artifactUnreadable = false;
  try {
    artifactDigest = await reader.inspectOwnedArtifact(input.artifactLocator);
  } catch {
    artifactUnreadable = true;
  }
  const artifact = Object.freeze({
    status: artifactUnreadable ? "unreadable" as const : artifactDigest === null ? "missing" as const : "verified" as const,
    locator: input.artifactLocator,
    bytes: artifactDigest?.bytes ?? null,
    sha256: artifactDigest?.sha256 ?? null,
  });
  if (artifactUnreadable) reasons.push("ARTIFACT_UNREADABLE");
  else if (artifactDigest === null) reasons.push("ARTIFACT_MISSING");

  let currentRevision: GitRevision | undefined;
  try {
    currentRevision = reader.inspectRevision();
  } catch {
    reasons.push("SOURCE_REVISION_UNAVAILABLE");
  }
  const sourceRevision = Object.freeze({
    status: currentRevision === undefined || run === undefined
      ? "unavailable" as const
      : currentRevision.commit === run.sourceCommitAtLaunch &&
        currentRevision.commit === run.expectedSourceCommit && currentRevision.clean && run.sourceCleanAtLaunch
        ? "verified" as const
        : "mismatch" as const,
    expectedCommit: run?.expectedSourceCommit ?? null,
    commitAtLaunch: run?.sourceCommitAtLaunch ?? null,
    currentCommit: currentRevision?.commit ?? null,
    cleanAtLaunch: run?.sourceCleanAtLaunch ?? null,
    cleanNow: currentRevision?.clean ?? null,
  });
  if (currentRevision !== undefined && sourceRevision.status === "mismatch") reasons.push("SOURCE_REVISION_MISMATCH");

  let toolReceipt: EvidenceReport["toolReceipt"] = Object.freeze({
    status: "missing", source: null, eventId: null, commitSequence: null, canonicalHash: null,
  });
  if (run !== undefined && scope.runId === run.runId) {
    try {
      const candidates = reader.readOperationFacts(input.operationId)
        .filter(({ event }) => event.kind === "operation_receipt" && event.operationId === input.operationId);
      if (candidates.length > 1) {
        toolReceipt = Object.freeze({ status: "invalid", source: null, eventId: null, commitSequence: null, canonicalHash: null });
      } else if (candidates.length === 1) {
        const entry = candidates[0]!;
        const event = normalizeRuntimeEvent(entry.event);
        const identity = { source: event.source, eventId: event.eventId };
        const storedReceipt = reader.queryWriterReceipt(identity.source, identity.eventId);
        const canonicalHash = sha256(Buffer.from(canonicalizeEventFacts(event), "utf8"));
        const conflict = reader.readOperationObservations(input.operationId).some((item) =>
          isRecord(item) && item.disposition === "identity_conflict" &&
          isRecord(item.event) && item.event.source === event.source && item.event.eventId === event.eventId);
        const receiptData = parseReceiptData(entry, event);
        const exactScope = scopeMatches(event.scope, scope);
        const exactAttempt = event.attemptId === input.attemptId;
        const writerCommitted = storedReceipt.status === "found" &&
          storedReceipt.firstReceipt?.source === event.source &&
          storedReceipt.firstReceipt.eventId === event.eventId &&
          storedReceipt.firstReceipt.commitSequence === entry.commitSequence &&
          storedReceipt.firstReceipt.canonicalHash === canonicalHash &&
          Number.isSafeInteger(entry.commitSequence) && entry.commitSequence > 0;
        const exactResult = receiptData !== null && receiptData.result.profile === OWNED_ARTIFACT_INTEGRITY_PROFILE &&
          receiptData.operationId === event.operationId &&
          receiptData.result.runId === run.runId &&
          receiptData.result.processId === run.processId &&
          receiptData.result.toolCallId === input.toolCallId &&
          receiptData.result.sourceCommitAtLaunch === run.sourceCommitAtLaunch &&
          (receiptData.result.command === undefined ||
            (receiptData.result.command.kind === run.command.kind &&
             receiptData.result.command.nodeVersion === run.command.nodeVersion &&
             receiptData.result.command.scriptSha256 === run.command.scriptSha256 &&
             receiptData.result.command.argumentCount === run.command.argumentCount)) &&
          artifactDigest !== null &&
          receiptData.result.artifact.locator === input.artifactLocator &&
          receiptData.result.artifact.bytes === artifactDigest.bytes &&
          receiptData.result.artifact.sha256 === artifactDigest.sha256;
        const valid = repositoryMatches && writerCommitted && !conflict && exactScope && exactAttempt &&
          event.kind === "operation_receipt" && event.operationId === input.operationId &&
          event.source === localReaderReceiptSources.get(readerValue as object) &&
          receiptData !== null && receiptData.status === "success" &&
          receiptData.operationId === input.operationId && exactResult;
        toolReceipt = Object.freeze({
          status: valid ? "verified" : "invalid",
          source: event.source,
          eventId: event.eventId,
          commitSequence: writerCommitted ? entry.commitSequence : null,
          canonicalHash: writerCommitted ? canonicalHash : null,
        });
      }
    } catch {
      toolReceipt = Object.freeze({ status: "invalid", source: null, eventId: null, commitSequence: null, canonicalHash: null });
    }
  }
  if (toolReceipt.status === "missing") reasons.push("TOOL_RECEIPT_MISSING");
  else if (toolReceipt.status !== "verified") reasons.push("TOOL_RECEIPT_INVALID");

  const failedReason = reasons.some((reason) => [
    "PROCESS_NOT_SUCCESSFUL", "SOURCE_DIRTY_AT_LAUNCH", "SOURCE_REVISION_MISMATCH", "SOURCE_EXPECTATION_MISMATCH",
    "TOOL_RECEIPT_INVALID",
  ].includes(reason));
  const blocked = reasons.some((reason) => [
    "RUN_NOT_OWNED", "PROCESS_ID_MISSING", "SCOPE_RUN_MISMATCH", "SOURCE_REVISION_UNAVAILABLE",
    "REPOSITORY_MISMATCH", "ARTIFACT_UNREADABLE", "ARTIFACT_MISSING", "TOOL_RECEIPT_MISSING",
  ].includes(reason));
  const profileResult = Object.freeze({
    status: reasons.length === 0 ? "passed" as const : failedReason ? "failed" as const : blocked ? "blocked" as const : "failed" as const,
    reasons: Object.freeze(reasons),
  });
  return Object.freeze({
    schemaVersion: 1,
    profile: OWNED_ARTIFACT_INTEGRITY_PROFILE,
    scope,
    attemptId: input.attemptId,
    operationId: input.operationId,
    toolCallId: input.toolCallId,
    execution,
    toolReceipt,
    artifact,
    sourceRevision,
    profileResult,
  });
}

function parseReceiptData(entry: WriterOrderedEvent, event: NormalizedEvent): ReceiptData | null {
  const payload = event.payload;
  if (!isRecord(payload)) return null;
  const payloadRecord = payload as Record<string, unknown>;
  if (!hasExactPlainKeys(payloadRecord, ["operationId", "status", "observedAt", "result"])) return null;
  if (typeof payloadRecord.operationId !== "string" ||
      (payloadRecord.status !== "success" && payloadRecord.status !== "failure" && payloadRecord.status !== "unknown") ||
      typeof payloadRecord.observedAt !== "string" || payloadRecord.observedAt.trim().length === 0 ||
      !isRecord(payloadRecord.result)) return null;
  const result = payloadRecord.result as Record<string, unknown>;
  if (!hasExactPlainKeys(result, ["profile", "runId", "processId", "toolCallId", "sourceCommitAtLaunch", "artifact",
        ...(Object.hasOwn(result, "command") ? ["command"] : [])]) ||
      (Object.hasOwn(result, "command") && !validNodeCommand(result.command)) ||
      !isRecord(result.artifact) ||
      !hasExactPlainKeys(result.artifact, ["locator", "bytes", "sha256"])) return null;
  const artifact = result.artifact as Record<string, unknown>;
  if (typeof result.profile !== "string" || typeof result.runId !== "string" ||
      typeof result.processId !== "number" || !Number.isSafeInteger(result.processId) ||
      typeof result.toolCallId !== "string" || typeof result.sourceCommitAtLaunch !== "string" ||
      typeof artifact.locator !== "string" || typeof artifact.bytes !== "number" ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return null;
  return {
    event,
    entry,
    result: result as unknown as ReceiptData["result"],
    status: payloadRecord.status,
    operationId: payloadRecord.operationId,
  };
}

function validNodeCommand(value: unknown): value is NodeCommandEvidence {
  if (!isRecord(value) || !hasExactPlainKeys(value, ["kind", "nodeVersion", "scriptSha256", "argumentCount"])) return false;
  return value.kind === "node-script" && typeof value.nodeVersion === "string" &&
    /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.nodeVersion) &&
    typeof value.scriptSha256 === "string" && /^[a-f0-9]{64}$/.test(value.scriptSha256) &&
    typeof value.argumentCount === "number" && Number.isSafeInteger(value.argumentCount) && value.argumentCount >= 0;
}

function readOperationFacts(store: EventStore, operationId: string): WriterOrderedEvent[] {
  const items: WriterOrderedEvent[] = [];
  let afterCommitSequence: number | undefined;
  let pages = 0;
  for (;;) {
    if (++pages > MAX_EVENT_PAGES) throw new Error("operation facts exceeded the evidence page limit");
    const page = store.read({
      operationId,
      limit: 256,
      ...(afterCommitSequence === undefined ? {} : { afterCommitSequence }),
    });
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (page.nextAfterCommitSequence === null || page.nextAfterCommitSequence <= (afterCommitSequence ?? 0)) {
      throw new Error("operation facts pagination did not advance");
    }
    afterCommitSequence = page.nextAfterCommitSequence;
  }
}

function readOperationObservations(store: EventStore, operationId: string): unknown[] {
  const items: unknown[] = [];
  let afterCommitSequence: number | undefined;
  let pages = 0;
  for (;;) {
    if (++pages > MAX_EVENT_PAGES) throw new Error("operation observations exceeded the evidence page limit");
    const page = store.readObservations({
      operationId,
      limit: 256,
      ...(afterCommitSequence === undefined ? {} : { afterCommitSequence }),
    });
    items.push(...page.items);
    if (!page.hasMore) return items;
    if (page.nextAfterCommitSequence === null || page.nextAfterCommitSequence <= (afterCommitSequence ?? 0)) {
      throw new Error("operation observations pagination did not advance");
    }
    afterCommitSequence = page.nextAfterCommitSequence;
  }
}

async function readOwnedArtifact(root: string, locator: string): Promise<Digest | null> {
  if (typeof locator !== "string" || locator.trim().length === 0 || locator.includes("\0") ||
      path.isAbsolute(locator) || locator.split(/[\\/]+/).some((part) => part === ".." || part === ".")) {
    throw new TypeError("artifact locator must be a relative owned path");
  }
  const target = path.resolve(root, locator);
  assertContained(root, target, false);
  const relative = path.relative(root, target);
  let cursor = root;
  let pathBefore: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    let segment: Awaited<ReturnType<typeof lstat>>;
    try {
      segment = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (segment.isSymbolicLink()) throw new TypeError("artifact path may not contain links");
    pathBefore = segment;
  }
  let physicalTarget: string;
  try {
    physicalTarget = await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  assertContained(root, physicalTarget, false);
  if (pathBefore === undefined || !pathBefore.isFile()) throw new TypeError("artifact must be a regular file");
  if (pathBefore.size > MAX_ARTIFACT_BYTES) throw new RangeError("artifact exceeds the fixed size limit");
  const handle = await open(physicalTarget, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(pathBefore, before)) throw new Error("artifact changed before it was read");
    if (before.size > MAX_ARTIFACT_BYTES) throw new RangeError("artifact exceeds the fixed size limit");
    const bounded = Buffer.alloc(before.size + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const chunk = await handle.read(bounded, bytesRead, bounded.byteLength - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const bytes = bounded.subarray(0, bytesRead);
    const after = await handle.stat();
    const pathAfter = await lstat(target);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() ||
        !sameFile(before, after) || !sameFile(before, pathAfter) ||
        bytes.byteLength !== before.size || bytes.byteLength !== after.size) {
      throw new Error("artifact changed while it was read");
    }
    return Object.freeze({ bytes: bytes.byteLength, sha256: sha256(bytes) });
  } finally {
    await handle.close();
  }
}

function readGitRevision(repositoryRoot: string): GitRevision {
  const top = git(repositoryRoot, ["rev-parse", "--show-toplevel"]).trim();
  if (!samePath(top, repositoryRoot)) throw new Error("repository root mismatch");
  const commit = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error("invalid Git revision");
  const status = git(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
  return Object.freeze({ commit, clean: status.length === 0 });
}

function git(repositoryRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0 || result.stdout === null) {
    throw new Error("Git inspection failed");
  }
  return result.stdout;
}

function readHeadBlob(repositoryRoot: string, relativePath: string): Buffer {
  const result = spawnSync("git", ["-C", repositoryRoot, "show", "HEAD:" + relativePath], {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_SCRIPT_BYTES + 1,
  });
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout) ||
      result.stdout.byteLength > MAX_SCRIPT_BYTES) {
    throw new Error("committed script blob could not be read");
  }
  return result.stdout;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function normalizeScope(value: BoundEventScope): BoundEventScope {
  assertExactKeys(value, ["sessionId", "turnId", "runId", "taskId"]);
  for (const key of ["sessionId", "turnId", "runId", "taskId"] as const) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) throw new TypeError("scope must be fully bound");
  }
  return Object.freeze({ ...value });
}

function scopeMatches(actual: NormalizedEvent["scope"], expected: BoundEventScope): boolean {
  return actual.sessionId === expected.sessionId && actual.turnId === expected.turnId &&
    actual.runId === expected.runId && actual.taskId === expected.taskId;
}

function assertExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (!isRecord(value)) throw new TypeError("input must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      keys.some((key) => !required.includes(String(key)) && !optional.includes(String(key)))) {
    throw new TypeError("input has unexpected or missing fields");
  }
}

function hasExactPlainKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertContained(parent: string, target: string, allowEqual: boolean): void {
  const relative = path.relative(parent, target);
  if ((!allowEqual && (relative === "" || relative === ".")) ||
      relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new TypeError("path is outside its owned root");
  }
}

function isContained(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || relative === "." ||
    (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
