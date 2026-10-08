import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";
import type {
  ProjectMemoryReader,
  ProjectMemorySnapshot,
} from "../adapters/zcode/src/project-memory.js";
import { ProjectMemoryError } from "../adapters/zcode/src/project-memory.js";
import {
  isTrustedProjectMapping,
  type ProjectMapping,
  type ProjectRegistry,
} from "../projects/registry.js";

const DEFAULT_PACKET_BYTES = 12_000;
const MAX_PACKET_BYTES = 12_000;
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 1024 * 1024;
const MAX_SELECTED_CONTENT_BYTES = 32 * 1024;
const MAX_ITEMS = 64;
const MAX_SOURCES_PER_ITEM = 8;
const MAX_APPLICABILITY_PATHS = 16;
const MAX_REVIEW_PATHS = 64;
const MAX_REVIEW_READ_BYTES = 1024 * 1024;
const MAX_REVIEW_READ_LINES = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_SOURCE_SCOPE = "workspace" as const;
const MEMORY_SOURCE_SCOPE = "project-memory" as const;
const ALLOWED_NATIVE_TOOLS = new Set(["Read"]);
const DENIED_NATIVE_TOOLS = [
  "Write", "Edit", "Bash", "Shell", "js", "NodeRepl", "Skill", "Agent", "Glob", "Grep", "Task",
] as const;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".git", ".runtime", ".codex", ".dsh", ".zcode", ".ssh", ".aws", ".azure", ".kube", ".gnupg",
  "life", "personal", "user-data", "secrets", "credentials",
]);
const FORBIDDEN_FILENAMES = new Set([".netrc", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]);
const NON_TEXT_EXTENSIONS = new Set([
  ".7z", ".a", ".bin", ".bz2", ".class", ".dll", ".dmg", ".dylib", ".exe", ".gif", ".gz", ".ico",
  ".jar", ".jpeg", ".jpg", ".mp3", ".mp4", ".mov", ".o", ".pdf", ".png", ".pyc", ".rar", ".so", ".tar",
  ".tgz", ".wasm", ".webp", ".zip",
]);
const packetBrands = new WeakSet<object>();
const packetSources = new WeakMap<object, ReadonlyMap<string, CapturedSource>>();
const renderedPackets = new WeakMap<object, string>();
const encoder = new TextEncoder();

export type HandoffItemKind = "constraint" | "fact" | "dependency" | "acceptance" | "local-note";
export type HandoffAuthority =
  | "project-rule"
  | "source-claim"
  | "unresolved-dependency"
  | "acceptance-criterion"
  | "experience-lead";

export interface HandoffSourceRange {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface HandoffCandidate {
  /** A host task-manifest category; free-form conversation is not an authorization source. */
  readonly kind: Exclude<HandoffItemKind, "local-note">;
  /** Caller-designated source ranges; the helper binds raw bytes but does not fact-check semantics. */
  readonly sources: readonly HandoffSourceRange[];
  /** Literal repository-relative files/directories governed by this item; may not exist yet. */
  readonly paths?: readonly string[];
}

export interface HandoffSourceFile {
  /** Workspace paths are repository-relative; project-memory paths are logical, never machine paths. */
  readonly path: string;
  readonly source_hash: string;
  readonly scope: typeof PROJECT_SOURCE_SCOPE | typeof MEMORY_SOURCE_SCOPE;
  readonly start_line: number;
  readonly end_line: number;
}

export interface HandoffItem {
  readonly kind: HandoffItemKind;
  readonly authority: HandoffAuthority;
  readonly selected_content: string;
  readonly project_id: string;
  readonly base_commit: string;
  /** SHA-256 of the sole raw source, or canonical sorted path/hash pairs for multiple sources. */
  readonly source_hash: string;
  readonly paths: readonly string[];
  readonly source_files: readonly HandoffSourceFile[];
  readonly sampled_at: string;
}

export interface HandoffPacket {
  readonly schema_version: 1;
  readonly scope: "project-only";
  readonly project_id: string;
  readonly base_commit: string;
  readonly sampled_at: string;
  readonly items: readonly HandoffItem[];
}

export type HandoffContextErrorCode =
  | "INVALID_INPUT"
  | "UNSAFE_PATH"
  | "PROJECT_MISMATCH"
  | "SOURCE_CHANGED"
  | "MEMORY_UNREADABLE"
  | "MEMORY_CORRUPT"
  | "LIMIT_EXCEEDED"
  | "REVIEW_PROFILE_INVALID"
  | "TOOL_NOT_ALLOWED"
  | "RESULT_AUTHORIZATION_REQUIRED"
  | "RESULT_CONFLICT"
  | "RESULT_WRITE_FAILED";

export class HandoffContextError extends Error {
  constructor(readonly code: HandoffContextErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HandoffContextError";
  }
}

export interface HandoffContextInput {
  readonly registry: ProjectRegistry;
  readonly projectId: string;
  readonly workspacePath: string;
  /** Explicit host-approved task-manifest entries, never derived as trusted scope from conversation text. */
  readonly items: readonly HandoffCandidate[];
  readonly localMemory?: {
    readonly reader: ProjectMemoryReader;
    readonly snapshot: ProjectMemorySnapshot;
  };
  /** The context budget cannot exceed the adopted 12,000-byte Native packet bound. */
  readonly maxBytes?: number;
}

interface CapturedSource {
  readonly path: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly sourceHash: string;
  readonly identity: string;
  readonly mtimeMs: number;
}

interface WorkspaceSnapshot {
  readonly root: string;
  readonly projectId: string;
  readonly revision: number;
  readonly commonIdentity: string;
  readonly privateIdentity: string;
  readonly memoryRoot: string;
  readonly baseCommit: string;
}

export function buildHandoffContext(input: HandoffContextInput): HandoffPacket {
  if (!input || typeof input !== "object" || !input.registry || !UUID.test(input.projectId) ||
      typeof input.workspacePath !== "string" || !path.isAbsolute(input.workspacePath) ||
      !Array.isArray(input.items) || input.items.length > MAX_ITEMS) {
    invalid("A trusted project mapping, absolute workspace and bounded explicit item list are required");
  }
  const maxBytes = input.maxBytes ?? DEFAULT_PACKET_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PACKET_BYTES) {
    invalid("maxBytes must be between 1 and 12,000 UTF-8 bytes");
  }
  if (input.items.length === 0 && input.localMemory === undefined) {
    invalid("At least one explicit knowledge item or U04 memory snapshot is required");
  }

  const initial = resolveWorkspace(input.registry, input.workspacePath, input.projectId);
  const workspaceSources = new Map<string, CapturedSource>();
  let totalSourceBytes = 0;
  const selected: Omit<HandoffItem, "project_id" | "base_commit" | "sampled_at">[] = [];

  for (const candidate of input.items) {
    validateCandidate(candidate);
    const rangeTexts: string[] = [];
    const sourceFiles: HandoffSourceFile[] = [];
    const sourcePathHashes = new Map<string, string>();
    for (const sourceRange of candidate.sources) {
      const relative = validateRelativePath(sourceRange.path);
      let captured = workspaceSources.get(relative);
      if (captured === undefined) {
        captured = readStableWorkspaceFile(initial.root, relative);
        totalSourceBytes += captured.bytes.byteLength;
        if (totalSourceBytes > MAX_TOTAL_SOURCE_BYTES) limit("Handoff source bytes exceed 1 MiB");
        workspaceSources.set(relative, captured);
      }
      const lines = captured.text.replaceAll("\r\n", "\n").split("\n");
      if (sourceRange.startLine > lines.length || sourceRange.endLine > lines.length) {
        invalid(`Line range exceeds source file ${relative}`);
      }
      const excerpt = lines.slice(sourceRange.startLine - 1, sourceRange.endLine).join("\n");
      if (excerpt.length === 0) invalid(`Selected source range is empty: ${relative}`);
      const markedExcerpt = `[${relative}#L${sourceRange.startLine}-L${sourceRange.endLine}]\n${excerpt}`;
      if (encoder.encode(markedExcerpt).byteLength > MAX_SELECTED_CONTENT_BYTES) {
        limit(`Selected content exceeds 32 KiB: ${relative}`);
      }
      rangeTexts.push(markedExcerpt);
      sourcePathHashes.set(relative, captured.sourceHash);
      sourceFiles.push(Object.freeze({
        path: relative,
        source_hash: captured.sourceHash,
        scope: PROJECT_SOURCE_SCOPE,
        start_line: sourceRange.startLine,
        end_line: sourceRange.endLine,
      }));
    }
    const selectedContent = rangeTexts.join("\n\n");
    if (encoder.encode(selectedContent).byteLength > MAX_SELECTED_CONTENT_BYTES) {
      limit("Selected content exceeds 32 KiB per handoff item");
    }
    const paths = candidate.paths === undefined
      ? [...new Set(sourceFiles.map((source) => source.path))]
      : [...new Set(candidate.paths.map(validateRelativePath))];
    paths.sort(compareText);
    sourceFiles.sort((left, right) => compareText(left.path, right.path) || left.start_line - right.start_line || left.end_line - right.end_line);
    selected.push({
      kind: candidate.kind,
      authority: authorityFor(candidate.kind),
      selected_content: selectedContent,
      source_hash: aggregateSourceHash(sourcePathHashes),
      paths: Object.freeze(paths),
      source_files: Object.freeze(sourceFiles),
    });
  }

  if (input.localMemory !== undefined) {
    const noteItems = captureLocalNotes(input.localMemory.reader, input.localMemory.snapshot, initial, initial.memoryRoot);
    selected.push(...noteItems);
  }
  if (selected.length > MAX_ITEMS) limit("Handoff packet contains too many items");

  verifyWorkspaceSnapshot(input.registry, input.workspacePath, initial, initial.baseCommit, workspaceSources);
  const sampledAt = new Date().toISOString();
  const items = selected.map((item) => Object.freeze({
    ...item,
    project_id: initial.projectId,
    base_commit: initial.baseCommit,
    sampled_at: sampledAt,
  } satisfies HandoffItem));
  const packet = freezeDeep({
    schema_version: 1 as const,
    scope: "project-only" as const,
    project_id: initial.projectId,
    base_commit: initial.baseCommit,
    sampled_at: sampledAt,
    items: Object.freeze(items),
  } satisfies HandoffPacket);
  const rendered = stableJson(packet as unknown as JsonValue);
  if (encoder.encode(rendered).byteLength > maxBytes) limit("Complete handoff packet exceeds its UTF-8 byte budget");
  packetBrands.add(packet);
  packetSources.set(packet, new Map(workspaceSources));
  renderedPackets.set(packet, rendered);
  return packet;
}

/** Serialize only a packet built in this process; this is data, never a system instruction. */
export function renderHandoffContext(packet: unknown): string {
  if (packet === null || typeof packet !== "object" || !packetBrands.has(packet)) {
    throw new HandoffContextError("INVALID_INPUT", "Packet must come from buildHandoffContext");
  }
  const rendered = renderedPackets.get(packet);
  if (rendered === undefined) throw new HandoffContextError("INVALID_INPUT", "Packet rendering provenance is unavailable");
  return rendered;
}

export interface HandoffDeliveryInput {
  readonly taskId: string;
  readonly packet: HandoffPacket;
  readonly target: "zcode" | "dsh-mock";
  /** Trusted host transport; the context remains serialized data. */
  readonly receive: (envelope: Readonly<{ task_id: string; context_json: string }>) => void | Promise<void>;
}

/** Deliver one immutable packet through an explicit host port, recording its exact bytes. */
export async function deliverHandoffContext(input: HandoffDeliveryInput): Promise<Readonly<{
  target: "zcode" | "dsh-mock"; task_id: string; project_id: string; base_commit: string; packet_sha256: string;
}>> {
  if (!input || typeof input.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.taskId) ||
      (input.target !== "zcode" && input.target !== "dsh-mock") || typeof input.receive !== "function") {
    invalid("Delivery requires a bounded task id and an explicit ZCode or DSH mock host port");
  }
  const context = renderHandoffContext(input.packet);
  const taskId = input.taskId;
  const target = input.target;
  const projectId = input.packet.project_id;
  const baseCommit = input.packet.base_commit;
  await input.receive(Object.freeze({ task_id: taskId, context_json: context }));
  return Object.freeze({ target, task_id: taskId, project_id: projectId, base_commit: baseCommit,
    packet_sha256: sha256(Buffer.from(context, "utf8")) });
}

export interface ReadOnlyReviewProfile {
  readonly tools: readonly ["Read"];
  readonly skills: readonly [];
  readonly mcpServers: readonly [];
  readonly disallowedTools: readonly string[];
  /** Deliberately absent: Native persistent memory is disabled for reviewers. */
  readonly memory?: undefined;
}

export function createReadOnlyReviewProfile(): ReadOnlyReviewProfile {
  return Object.freeze({
    tools: Object.freeze(["Read"] as const),
    skills: Object.freeze([]) as readonly [],
    mcpServers: Object.freeze([]) as readonly [],
    disallowedTools: Object.freeze([...DENIED_NATIVE_TOOLS, "mcp__*"]),
  });
}

export interface ReadOnlyReviewSnapshotFile {
  readonly path: string;
  readonly source_hash: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface ReadOnlyReviewSnapshotStat {
  readonly path: string;
  readonly kind: "file";
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly revision: Readonly<{ id: string; sizeBytes: number; hash: string }>;
}

export interface ReadOnlyReviewTextRead {
  readonly path: string;
  readonly content: string;
  readonly encoding: "utf8";
  readonly lineEndings: "LF" | "CRLF";
  readonly bytesRead: number;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly revision: Readonly<{ id: string; sizeBytes: number; hash: string }>;
}

/** Exact admitted file snapshot for a trusted Native FileSystemPort adapter. It has no OS-file API. */
export interface ReadOnlyReviewFileSnapshot {
  readonly root: string;
  readonly paths: readonly string[];
  getFile(absolutePath: string): ReadOnlyReviewSnapshotFile | undefined;
  stat(absolutePath: string): ReadOnlyReviewSnapshotStat;
  readText(absolutePath: string, input?: { readonly offset?: number; readonly limit?: number }): ReadOnlyReviewTextRead;
  assertFresh(): void;
}

export interface NativeReviewToolEntry {
  readonly metadata: {
    readonly name: string;
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly sideEffectScope: string;
    readonly mcpPresentation?: unknown;
  };
  readonly permission?: { readonly permission?: string; readonly sideEffectScope?: string };
  readonly handler: unknown;
}

export interface NativeReviewToolRegistry {
  list(): readonly string[];
  get(name: string): NativeReviewToolEntry | undefined;
}

export interface NativeReviewToolExecutor {
  execute(call: { readonly id: string; readonly name: string; readonly input: unknown }, options?: unknown): Promise<unknown>;
}

export interface NativeReviewRuntime {
  getTools(): readonly { readonly name: string }[];
  getToolRegistry(): NativeReviewToolRegistry;
  getToolExecutor(): NativeReviewToolExecutor;
}

export type NativeReviewRuntimeFactory = (
  profile: ReadOnlyReviewProfile,
  /** Must be the sole filesystem backing supplied to Native Read; do not bind the OS filesystem. */
  files: ReadOnlyReviewFileSnapshot,
) => NativeReviewRuntime;

export interface ReadOnlyReviewExecutorInput {
  readonly registry: ProjectRegistry;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly packet: HandoffPacket;
  /** Exact repository-relative source files from this packet; no directory or wildcard scope. */
  readonly readablePaths: readonly string[];
  /**
   * Trusted composition point: configure actual Native memory disabled, skills/MCP absent and only Read
   * registered; bind Read's FileSystemPort to `files`, never OS paths. If Native injects coordinator tools,
   * curate them out before returning the runtime. The guard checks the final provider projection and registry.
   */
  readonly createRuntime: NativeReviewRuntimeFactory;
}

export interface ReadOnlyReviewExecutor {
  tools(): readonly string[];
  invoke(name: string, input: unknown): Promise<unknown>;
}

export function createReadOnlyReviewExecutor(input: ReadOnlyReviewExecutorInput): ReadOnlyReviewExecutor {
  if (!input || typeof input !== "object" || !packetBrands.has(input.packet as object) ||
      !UUID.test(input.projectId) || !Array.isArray(input.readablePaths) || input.readablePaths.length === 0 ||
      input.readablePaths.length > MAX_REVIEW_PATHS || typeof input.createRuntime !== "function") {
    invalid("A built packet, trusted project binding, exact readable path list and Native runtime factory are required");
  }
  const packet = input.packet;
  if (packet.project_id !== input.projectId || packet.scope !== "project-only") {
    throw new HandoffContextError("PROJECT_MISMATCH", "Review packet belongs to a different project");
  }
  const created = packetSources.get(packet);
  if (created === undefined) throw new HandoffContextError("SOURCE_CHANGED", "Packet source snapshot is unavailable");
  const workspaceSnapshot = resolveWorkspace(input.registry, input.workspacePath, input.projectId);
  const workspaceHead = workspaceSnapshot.baseCommit;
  if (workspaceHead !== packet.base_commit) throw new HandoffContextError("SOURCE_CHANGED", "Workspace HEAD differs from the packet base commit");

  const allowedFiles = new Map<string, CapturedSource>();
  const packetSourcePaths = new Set<string>();
  for (const item of packet.items) {
    for (const source of item.source_files) {
      if (source.scope === PROJECT_SOURCE_SCOPE) packetSourcePaths.add(source.path);
    }
  }
  for (const value of input.readablePaths) {
    const relative = validateRelativePath(value);
    if (!packetSourcePaths.has(relative)) throw new HandoffContextError("TOOL_NOT_ALLOWED", `Read path is outside the packet source list: ${relative}`);
    const captured = created.get(relative);
    if (captured === undefined) throw new HandoffContextError("SOURCE_CHANGED", `Packet bytes are unavailable: ${relative}`);
    const current = readStableWorkspaceFile(workspaceSnapshot.root, relative);
    if (current.sourceHash !== captured.sourceHash || current.identity !== captured.identity) {
      throw new HandoffContextError("SOURCE_CHANGED", `Review source changed since handoff capture: ${relative}`);
    }
    allowedFiles.set(relative, captured);
  }
  const fileSnapshot = makeReadOnlyReviewFileSnapshot(input.registry, input.workspacePath, workspaceSnapshot,
    workspaceHead, created, allowedFiles);
  fileSnapshot.assertFresh();

  const profile = createReadOnlyReviewProfile();
  const runtime = input.createRuntime(profile, fileSnapshot);
  const initialNative = inspectNativeRuntime(runtime);
  const initialReadEntry = initialNative.registry.get("Read");
  if (initialReadEntry === undefined) reviewProfileInvalid("The final child registry has no Read entry");
  const initialReadHandler = initialReadEntry.handler;
  const initialExecutor = initialNative.executor;
  const initialExecute = initialExecutor.execute;

  const assertRuntimeStable = (beforeInvocation: boolean): void => {
    let current: ReturnType<typeof inspectNativeRuntime>;
    try { current = inspectNativeRuntime(runtime); }
    catch (cause) {
      throw new HandoffContextError("TOOL_NOT_ALLOWED", "Native review capabilities changed after construction", { cause });
    }
    const readEntry = current.registry.get("Read");
    if (current.registry !== initialNative.registry || current.executor !== initialExecutor ||
        current.executor.execute !== initialExecute ||
        readEntry !== initialReadEntry || readEntry?.handler !== initialReadHandler) {
      throw new HandoffContextError("TOOL_NOT_ALLOWED", "Native review executor or Read handler changed after construction");
    }
    if (beforeInvocation && current.registry.get("Read") === undefined) {
      throw new HandoffContextError("TOOL_NOT_ALLOWED", "Read is no longer registered");
    }
  };

  const tools = (): readonly string[] => {
    assertRuntimeStable(true);
    fileSnapshot.assertFresh();
    return Object.freeze(["Read"]);
  };

  const invoke = async (name: string, rawInput: unknown): Promise<unknown> => {
    if (name !== "Read") throw new HandoffContextError("TOOL_NOT_ALLOWED", `Review tool is not allowed: ${name}`);
    assertRuntimeStable(true);
    fileSnapshot.assertFresh();
    const readInput = validateNativeReadInput(rawInput, workspaceSnapshot.root, allowedFiles);
    const result = await initialExecutor.execute({ id: randomUUID(), name: "Read", input: readInput });
    assertRuntimeStable(false);
    fileSnapshot.assertFresh();
    return result;
  };

  return Object.freeze({ tools, invoke });
}

function inspectNativeRuntime(runtime: NativeReviewRuntime): {
  readonly registry: NativeReviewToolRegistry;
  readonly executor: NativeReviewToolExecutor;
} {
  if (!runtime || typeof runtime.getTools !== "function" || typeof runtime.getToolRegistry !== "function" ||
      typeof runtime.getToolExecutor !== "function") {
    reviewProfileInvalid("Trusted Native runtime does not expose the expected executor ABI");
  }
  const registry = runtime.getToolRegistry();
  const executor = runtime.getToolExecutor();
  if (!registry || typeof registry.list !== "function" || typeof registry.get !== "function" ||
      !executor || typeof executor.execute !== "function") {
    reviewProfileInvalid("Trusted Native runtime registry/executor ABI is incomplete");
  }
  const listed = registry.list();
  const projected = runtime.getTools();
  if (!Array.isArray(listed) || !Array.isArray(projected) ||
      listed.some((name) => typeof name !== "string") || projected.some((tool) => !tool || typeof tool.name !== "string")) {
    reviewProfileInvalid("Native tool registry or provider projection is malformed");
  }
  if (listed.length !== 1 || listed[0] !== "Read" || projected.length !== 1 || projected[0]?.name !== "Read" ||
      listed.some((name) => !ALLOWED_NATIVE_TOOLS.has(name) || name.startsWith("mcp__")) ||
      projected.some((tool) => !ALLOWED_NATIVE_TOOLS.has(tool.name) || tool.name.startsWith("mcp__"))) {
    reviewProfileInvalid("Final Native registry/projection exceeds the explicit Read-only profile");
  }
  for (const name of DENIED_NATIVE_TOOLS) {
    if (registry.get(name) !== undefined) reviewProfileInvalid(`Denied Native tool is registered: ${name}`);
  }
  const read = registry.get("Read");
  if (!read || read.metadata.name !== "Read" || read.metadata.readOnly !== true ||
      read.metadata.destructive !== false || read.metadata.sideEffectScope !== "none" ||
      read.permission?.permission !== "read" || read.permission.sideEffectScope !== "none" ||
      read.metadata.mcpPresentation !== undefined || typeof read.handler !== "function") {
    reviewProfileInvalid("Native Read entry does not match the known read-only capability shape");
  }
  return { registry, executor };
}

function validateNativeReadInput(
  value: unknown,
  workspaceRoot: string,
  allowedFiles: ReadonlyMap<string, CapturedSource>,
): { readonly file_path: string; readonly offset?: number; readonly limit?: number } {
  const keys = ["file_path"];
  if (value !== null && typeof value === "object") {
    for (const key of ["offset", "limit"]) {
      if (Object.hasOwn(value, key)) keys.push(key);
    }
  }
  const input = plainRecord(value, keys, "Native Read input");
  if (typeof input.file_path !== "string" || input.file_path.length === 0 || input.file_path.includes("\0")) {
    invalid("Read requires a file_path");
  }
  const absolutePath = path.isAbsolute(input.file_path)
    ? path.resolve(input.file_path)
    : path.resolve(workspaceRoot, input.file_path);
  const relative = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
  const safeRelative = validateRelativePath(relative);
  const captured = allowedFiles.get(safeRelative);
  if (captured === undefined || pathKey(captured.absolutePath) !== pathKey(absolutePath)) {
    throw new HandoffContextError("TOOL_NOT_ALLOWED", "Read is limited to exact admitted source files");
  }
  if (NON_TEXT_EXTENSIONS.has(path.extname(safeRelative).toLowerCase())) {
    throw new HandoffContextError("TOOL_NOT_ALLOWED", "Read is limited to admitted UTF-8 text files");
  }
  const offset = input.offset;
  const limitValue = input.limit;
  if (offset !== undefined && (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_REVIEW_READ_LINES)) {
    invalid("Read offset is out of bounds");
  }
  if (limitValue !== undefined && (!Number.isSafeInteger(limitValue) || (limitValue as number) < 1 || (limitValue as number) > MAX_REVIEW_READ_LINES)) {
    invalid("Read limit is out of bounds");
  }
  return {
    file_path: captured.absolutePath,
    ...(offset === undefined ? {} : { offset: offset as number }),
    ...(limitValue === undefined ? {} : { limit: limitValue as number }),
  };
}

function makeReadOnlyReviewFileSnapshot(
  registry: ProjectRegistry,
  workspacePath: string,
  snapshot: WorkspaceSnapshot,
  baseCommit: string,
  allSources: ReadonlyMap<string, CapturedSource>,
  allowedFiles: ReadonlyMap<string, CapturedSource>,
): ReadOnlyReviewFileSnapshot {
  const paths = Object.freeze([...allowedFiles.keys()].sort(compareText));
  const byAbsolutePath = new Map<string, CapturedSource>();
  for (const source of allowedFiles.values()) byAbsolutePath.set(pathKey(source.absolutePath), source);
  const requireFile = (absolutePath: string): CapturedSource => {
    if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath) || absolutePath.includes("\0")) {
      throw new HandoffContextError("TOOL_NOT_ALLOWED", "Snapshot reads require an absolute path");
    }
    const source = byAbsolutePath.get(pathKey(path.resolve(absolutePath)));
    if (source === undefined) throw new HandoffContextError("TOOL_NOT_ALLOWED", "Path is outside the admitted source snapshot");
    return source;
  };
  const assertFresh = (): void => {
    verifyWorkspaceSnapshot(registry, workspacePath, snapshot, baseCommit, allSources);
    for (const source of allowedFiles.values()) {
      const current = readStableWorkspaceFile(snapshot.root, source.path);
      if (current.sourceHash !== source.sourceHash || current.identity !== source.identity) {
        throw new HandoffContextError("SOURCE_CHANGED", `Admitted review file changed: ${source.path}`);
      }
    }
  };
  const stat = (absolutePath: string): ReadOnlyReviewSnapshotStat => {
    assertFresh();
    const source = requireFile(absolutePath);
    return Object.freeze({
      path: source.absolutePath,
      kind: "file" as const,
      sizeBytes: source.bytes.byteLength,
      mtimeMs: source.mtimeMs,
      revision: Object.freeze({ id: `sha256:${source.sourceHash}`, sizeBytes: source.bytes.byteLength, hash: source.sourceHash }),
    });
  };
  const getFile = (absolutePath: string): ReadOnlyReviewSnapshotFile | undefined => {
    assertFresh();
    let source: CapturedSource;
    try { source = requireFile(absolutePath); }
    catch (error) {
      if (error instanceof HandoffContextError && error.code === "TOOL_NOT_ALLOWED") return undefined;
      throw error;
    }
    return Object.freeze({
      path: source.absolutePath,
      source_hash: source.sourceHash,
      sizeBytes: source.bytes.byteLength,
      mtimeMs: source.mtimeMs,
      bytes: Uint8Array.from(source.bytes),
      text: source.text,
    });
  };
  const readText = (absolutePath: string, input: { readonly offset?: number; readonly limit?: number } = {}): ReadOnlyReviewTextRead => {
    assertFresh();
    const source = requireFile(absolutePath);
    const offset = input.offset ?? 0;
    const lineLimit = input.limit ?? MAX_REVIEW_READ_LINES;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(lineLimit) || lineLimit < 1 || lineLimit > MAX_REVIEW_READ_LINES) {
      invalid("Snapshot text range is out of bounds");
    }
    const lines = source.text.length === 0 ? [] : source.text.replaceAll("\r\n", "\n").split("\n");
    const selected = lines.slice(offset, offset + lineLimit);
    const content = selected.join("\n");
    if (encoder.encode(content).byteLength > MAX_REVIEW_READ_BYTES) limit("Snapshot text range exceeds 1 MiB");
    return Object.freeze({
      path: source.absolutePath,
      content,
      encoding: "utf8" as const,
      lineEndings: detectLineEndings(source.text),
      bytesRead: source.bytes.byteLength,
      sizeBytes: source.bytes.byteLength,
      truncated: false,
      revision: Object.freeze({ id: `sha256:${source.sourceHash}`, sizeBytes: source.bytes.byteLength, hash: source.sourceHash }),
    });
  };
  return Object.freeze({ root: snapshot.root, paths, getFile, stat, readText, assertFresh });
}

export interface ReviewResultAuthorization {
  readonly authorization_id: string;
  readonly project_id: string;
  readonly attempt_id: string;
  /** One basename within the host-owned directory supplied to the sink. */
  readonly filename: string;
}

export interface ReviewResultAudit {
  readonly authorization_id: string | null;
  readonly project_id: string | null;
  readonly attempt_id: string | null;
  readonly filename: string | null;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly occurred_at: string;
  readonly result: "written" | "denied" | "failed";
  readonly error_code?: HandoffContextErrorCode;
}

export interface ReviewResultWriteResult {
  readonly filename: string;
  readonly project_id: string;
  readonly attempt_id: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ReviewResultSinkInput {
  readonly ownedDirectory: string;
  /** Host-only authorization callback; model tool input never contains a path or filename. */
  readonly authorize: () => ReviewResultAuthorization | undefined;
  readonly audit: (event: ReviewResultAudit) => void;
}

export interface ReviewResultSink {
  write(contents: string | Uint8Array): ReviewResultWriteResult;
}

export function createReviewResultSink(input: ReviewResultSinkInput): ReviewResultSink {
  if (!input || typeof input !== "object" || typeof input.authorize !== "function" || typeof input.audit !== "function") {
    invalid("A host-owned output directory, explicit authorizer and audit callback are required");
  }
  const ownedDirectory = physicalDirectory(input.ownedDirectory);
  const directoryIdentity = physicalDirectoryIdentity(ownedDirectory);
  const audit = (event: ReviewResultAudit): void => {
    const result: unknown = input.audit(Object.freeze(event));
    if (result !== undefined) throw new HandoffContextError("RESULT_WRITE_FAILED", "Result audit callback must be synchronous and return no value");
  };
  const write = (contents: string | Uint8Array): ReviewResultWriteResult => {
    let authorization: ReviewResultAuthorization | undefined;
    try { authorization = input.authorize(); }
    catch (cause) {
      try { audit(auditEvent(null, null, null, null, 0, null, "denied", "RESULT_AUTHORIZATION_REQUIRED")); } catch { /* retain denial */ }
      throw new HandoffContextError("RESULT_AUTHORIZATION_REQUIRED", "Host result authorization failed", { cause });
    }
    if (authorization === undefined) {
      audit(auditEvent(null, null, null, null, 0, null, "denied", "RESULT_AUTHORIZATION_REQUIRED"));
      throw new HandoffContextError("RESULT_AUTHORIZATION_REQUIRED", "Host authorization is required for a review result");
    }
    try { validateAuthorization(authorization); }
    catch (cause) {
      try { audit(auditEvent(null, null, null, null, 0, null, "denied", "RESULT_AUTHORIZATION_REQUIRED")); } catch { /* retain denial */ }
      throw new HandoffContextError("RESULT_AUTHORIZATION_REQUIRED", "Host result authorization is invalid", { cause });
    }
    authorization = Object.freeze({ authorization_id: authorization.authorization_id, project_id: authorization.project_id,
      attempt_id: authorization.attempt_id, filename: authorization.filename });
    if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
      throw new HandoffContextError("INVALID_INPUT", "Review result must be a string or Uint8Array");
    }
    const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
    if (bytes.byteLength > MAX_REVIEW_READ_BYTES) {
      try { audit(auditEvent(authorization.authorization_id, authorization.project_id, authorization.attempt_id,
        authorization.filename, bytes.byteLength, sha256(bytes), "failed", "LIMIT_EXCEEDED")); } catch { /* retain limit failure */ }
      limit("Review result exceeds 1 MiB");
    }
    const digest = sha256(bytes);
    const target = path.join(ownedDirectory, authorization.filename);
    if (pathKey(physicalDirectory(ownedDirectory)) !== pathKey(ownedDirectory) ||
        physicalDirectoryIdentity(ownedDirectory) !== directoryIdentity) {
      throw new HandoffContextError("UNSAFE_PATH", "Host-owned result directory changed");
    }
    let fd: number | undefined;
    let createdTarget = false;
    let successAuditAttempted = false;
    try {
      fd = fs.openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      createdTarget = true;
      const created = fs.fstatSync(fd, { bigint: true });
      if (!created.isFile() || created.nlink !== 1n) throw new HandoffContextError("UNSAFE_PATH", "Result file is not a new physical file");
      let written = 0;
      while (written < bytes.byteLength) {
        const count = fs.writeSync(fd, bytes, written, bytes.byteLength - written, written);
        if (count <= 0) throw new HandoffContextError("RESULT_WRITE_FAILED", "Result write made no progress");
        written += count;
      }
      fs.fsyncSync(fd);
      const completed = fs.fstatSync(fd, { bigint: true });
      if (!completed.isFile() || completed.nlink !== 1n || !sameFileIdentity(created, completed)) {
        throw new HandoffContextError("UNSAFE_PATH", "Result file identity changed while writing");
      }
      fs.closeSync(fd);
      fd = undefined;
      assertPhysicalFile(target, completed);
      if (pathKey(physicalDirectory(ownedDirectory)) !== pathKey(ownedDirectory) ||
          physicalDirectoryIdentity(ownedDirectory) !== directoryIdentity) {
        throw new HandoffContextError("UNSAFE_PATH", "Host-owned result directory changed during write");
      }
      successAuditAttempted = true;
      audit(auditEvent(authorization.authorization_id, authorization.project_id, authorization.attempt_id,
        authorization.filename, bytes.byteLength, digest, "written"));
      return Object.freeze({ filename: authorization.filename, project_id: authorization.project_id,
        attempt_id: authorization.attempt_id, bytes: bytes.byteLength, sha256: digest });
    } catch (cause) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* preserve the original write error */ }
      }
      if (cause instanceof HandoffContextError && cause.code === "RESULT_CONFLICT") {
        audit(auditEvent(authorization.authorization_id, authorization.project_id, authorization.attempt_id,
          authorization.filename, bytes.byteLength, digest, "failed", "RESULT_CONFLICT"));
        throw cause;
      }
      if (isAlreadyExists(cause)) {
        audit(auditEvent(authorization.authorization_id, authorization.project_id, authorization.attempt_id,
          authorization.filename, bytes.byteLength, digest, "failed", "RESULT_CONFLICT"));
        throw new HandoffContextError("RESULT_CONFLICT", "Review result already exists; no file was overwritten", { cause });
      }
      if (successAuditAttempted) {
        throw new HandoffContextError("RESULT_WRITE_FAILED",
          "Result file was created, but its success audit failed; the target is retained and the outcome is unknown. Do not retry automatically.", { cause });
      }
      try {
        const failureCode = cause instanceof HandoffContextError ? cause.code : "RESULT_WRITE_FAILED";
        audit(auditEvent(authorization.authorization_id, authorization.project_id, authorization.attempt_id,
          authorization.filename, bytes.byteLength, digest, "failed", failureCode));
      } catch { /* report the failed file write */ }
      if (createdTarget) {
        throw new HandoffContextError("RESULT_WRITE_FAILED",
          "Result creation started but did not complete; the target may contain partial data and is retained. Do not retry automatically.", { cause });
      }
      if (cause instanceof HandoffContextError) throw cause;
      throw new HandoffContextError("RESULT_WRITE_FAILED", "Review result could not be written", { cause });
    }
  };
  return Object.freeze({ write });
}

function resolveWorkspace(registry: ProjectRegistry, workspacePath: string, projectId: string): WorkspaceSnapshot {
  let mapping: ProjectMapping;
  try { mapping = registry.resolveWorkspace(workspacePath); }
  catch (cause) { throw new HandoffContextError("PROJECT_MISMATCH", "Workspace has no trusted current project mapping", { cause }); }
  if (!isTrustedProjectMapping(mapping) || mapping.projectId !== projectId) {
    throw new HandoffContextError("PROJECT_MISMATCH", "Workspace mapping does not authorize this project id");
  }
  const resolvedRoot = physicalDirectory(workspacePath);
  const binding = mapping.workspaces.find((workspace) => pathKey(workspace.workspacePath) === pathKey(resolvedRoot));
  if (binding === undefined) {
    throw new HandoffContextError("PROJECT_MISMATCH", "Trusted mapping does not contain this exact workspace binding");
  }
  if (pathKey(binding.workspacePath) !== pathKey(resolvedRoot)) {
    throw new HandoffContextError("PROJECT_MISMATCH", "Workspace path differs from its trusted physical binding");
  }
  return Object.freeze({ root: resolvedRoot, projectId: mapping.projectId, revision: mapping.revision,
    commonIdentity: binding.commonIdentity, privateIdentity: binding.privateIdentity,
    memoryRoot: mapping.native.memoryRoot, baseCommit: observeHead(resolvedRoot) });
}

function verifyWorkspaceSnapshot(
  registry: ProjectRegistry,
  workspacePath: string,
  previous: WorkspaceSnapshot,
  baseCommit: string,
  sources: ReadonlyMap<string, CapturedSource>,
): void {
  const current = resolveWorkspace(registry, workspacePath, previous.projectId);
  if (current.revision !== previous.revision || current.commonIdentity !== previous.commonIdentity ||
      current.privateIdentity !== previous.privateIdentity || pathKey(current.root) !== pathKey(previous.root) ||
      current.baseCommit !== baseCommit) {
    throw new HandoffContextError("SOURCE_CHANGED", "Project mapping, worktree identity or Git HEAD changed during handoff capture");
  }
  for (const source of sources.values()) {
    const reread = readStableWorkspaceFile(current.root, source.path);
    if (reread.sourceHash !== source.sourceHash || reread.identity !== source.identity) {
      throw new HandoffContextError("SOURCE_CHANGED", `Project source changed during handoff capture: ${source.path}`);
    }
  }
}

function observeHead(root: string): string {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
  try {
    const value = execFileSync("git", ["-c", "core.fsmonitor=false", "-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8", env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error("Git returned an invalid commit id");
    return value;
  } catch (cause) {
    throw new HandoffContextError("PROJECT_MISMATCH", "Cannot observe the trusted workspace Git HEAD", { cause });
  }
}

function readStableWorkspaceFile(root: string, relative: string): CapturedSource {
  const safeRelative = validateRelativePath(relative);
  const absolutePath = path.resolve(root, ...safeRelative.split("/"));
  if (!isWithin(root, absolutePath)) unsafe(`Source path escaped workspace: ${safeRelative}`);
  let fd: number | undefined;
  try {
    physicalDirectory(root);
    const segments = safeRelative.split("/");
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      physicalDirectory(parent);
    }
    const beforePath = fs.lstatSync(absolutePath, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) {
      unsafe(`Source must be an unlinked regular file: ${safeRelative}`);
    }
    assertExactSourceCase(root, safeRelative, absolutePath);
    if (beforePath.size > BigInt(MAX_SOURCE_FILE_BYTES)) limit(`Source file exceeds 1 MiB: ${safeRelative}`);
    fd = fs.openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameStableStat(beforePath, before)) {
      unsafe(`Source file identity changed while opening: ${safeRelative}`);
    }
    const size = Number(before.size);
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const count = fs.readSync(fd, bytes, read, size - read, read);
      if (count <= 0) throw new HandoffContextError("SOURCE_CHANGED", `Source file was truncated while reading: ${safeRelative}`);
      read += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(absolutePath, { bigint: true });
    if (!sameStableStat(before, after) || !sameStableStat(before, afterPath)) {
      throw new HandoffContextError("SOURCE_CHANGED", `Source file changed while reading: ${safeRelative}`);
    }
    assertExactSourceCase(root, safeRelative, absolutePath);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (cause) { throw new HandoffContextError("INVALID_INPUT", `Source file is not valid UTF-8: ${safeRelative}`, { cause }); }
    if (text.includes("\0")) throw new HandoffContextError("INVALID_INPUT", `Source file contains NUL text: ${safeRelative}`);
    return Object.freeze({ path: safeRelative, absolutePath, bytes, text, sourceHash: sha256(bytes),
      identity: stableFileIdentity(before), mtimeMs: Number(before.mtimeNs) / 1_000_000 });
  } catch (error) {
    if (error instanceof HandoffContextError) throw error;
    if (isMissing(error)) throw new HandoffContextError("SOURCE_CHANGED", `Source file is missing: ${safeRelative}`, { cause: error });
    throw new HandoffContextError("UNSAFE_PATH", `Cannot safely read source file: ${safeRelative}`, { cause: error });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateCandidate(value: unknown): asserts value is HandoffCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("handoff item must be a plain object");
  const hasPaths = Object.prototype.hasOwnProperty.call(value, "paths");
  const candidate = plainRecord(value, hasPaths ? ["kind", "sources", "paths"] : ["kind", "sources"], "handoff item");
  if (candidate.kind !== "constraint" && candidate.kind !== "fact" && candidate.kind !== "dependency" && candidate.kind !== "acceptance") {
    invalid("Only declared constraint, fact, dependency and acceptance items are allowed");
  }
  if (!Array.isArray(candidate.sources) || candidate.sources.length < 1 || candidate.sources.length > MAX_SOURCES_PER_ITEM) {
    invalid("Each handoff item requires 1 to 8 explicit source ranges");
  }
  if (hasPaths && (!Array.isArray(candidate.paths) || candidate.paths.length < 1 || candidate.paths.length > MAX_APPLICABILITY_PATHS)) {
    invalid("Applicability paths must contain 1 to 16 literal repository-relative files or directories");
  }
  if (hasPaths) {
    for (const candidatePath of candidate.paths as unknown[]) validateRelativePath(candidatePath);
  }
  for (const value of candidate.sources) {
    const range = plainRecord(value, ["path", "startLine", "endLine"], "source range");
    validateRelativePath(range.path);
    if (!Number.isSafeInteger(range.startLine) || (range.startLine as number) < 1 ||
        !Number.isSafeInteger(range.endLine) || (range.endLine as number) < (range.startLine as number) ||
        (range.endLine as number) - (range.startLine as number) > 1000) {
      invalid("Source ranges require bounded one-based startLine/endLine values");
    }
  }
}

function captureLocalNotes(
  reader: ProjectMemoryReader,
  snapshot: ProjectMemorySnapshot,
  workspace: WorkspaceSnapshot,
  memoryRoot: string,
): Omit<HandoffItem, "project_id" | "base_commit" | "sampled_at">[] {
  if (!reader || typeof reader.read !== "function" || !snapshot || snapshot.project_id !== workspace.projectId) {
    throw new HandoffContextError("PROJECT_MISMATCH", "U04 memory snapshot does not belong to this project");
  }
  if (snapshot.kind === "absent") return [];
  if (snapshot.kind === "unreadable") {
    throw new HandoffContextError("MEMORY_UNREADABLE", `U04 project memory is unreadable (${snapshot.code})`);
  }
  if (snapshot.kind === "corrupt") {
    throw new HandoffContextError("MEMORY_CORRUPT", `U04 project memory is corrupt (${snapshot.code})`);
  }
  const notes: Omit<HandoffItem, "project_id" | "base_commit" | "sampled_at">[] = [];
  for (const topic of snapshot.topics) {
    if (topic.kind === "absent") continue;
    if (topic.kind === "unreadable") {
      throw new HandoffContextError("MEMORY_UNREADABLE", `U04 topic ${topic.path} is unreadable (${topic.code})`);
    }
    if (topic.kind === "corrupt") {
      throw new HandoffContextError("MEMORY_CORRUPT", `U04 topic ${topic.path} is corrupt (${topic.code})`);
    }
    if (topic.source_hash === null || topic.text === undefined) {
      throw new HandoffContextError("MEMORY_CORRUPT", `U04 topic ${topic.path} is missing its text/hash (${topic.code})`);
    }
    const topicPath = validateRelativePath(topic.path);
    let current: ReturnType<ProjectMemoryReader["read"]>;
    try { current = reader.read(snapshot, path.join(memoryRoot, ...topicPath.split("/"))); }
    catch (cause) {
      if (!(cause instanceof ProjectMemoryError)) throw cause;
      const code: HandoffContextErrorCode = cause.code === "SOURCE_CHANGED" ? "SOURCE_CHANGED"
        : cause.code === "PERMISSION_DENIED" ? "MEMORY_UNREADABLE" : "MEMORY_CORRUPT";
      throw new HandoffContextError(code, `U04 topic ${topicPath} could not be revalidated (${cause.code})`, { cause });
    }
    if (current.source_hash !== topic.source_hash) {
      throw new HandoffContextError("SOURCE_CHANGED", `U04 memory topic changed after snapshot: ${topicPath}`);
    }
    const selected = current.text;
    if (encoder.encode(selected).byteLength > MAX_SELECTED_CONTENT_BYTES) limit("Selected local note exceeds 32 KiB");
    const sourcePath = `.native-project-memory/${topicPath}`;
    const sourceFile = Object.freeze({ path: sourcePath, source_hash: current.source_hash,
      scope: MEMORY_SOURCE_SCOPE, start_line: 1, end_line: selected.split(/\r\n|\n|\r/).length });
    notes.push({ kind: "local-note", authority: "experience-lead", selected_content: selected,
      source_hash: current.source_hash, paths: Object.freeze([sourcePath]), source_files: Object.freeze([sourceFile]) });
  }
  return notes;
}

function validateRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || Buffer.byteLength(value, "utf8") > 388 ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/.test(value) ||
      value.includes("\\") || value.startsWith("/") || value.includes(":") || /[<>"|?*]/.test(value)) {
    unsafe("Source paths must be bounded canonical repository-relative paths");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." ||
      segment.endsWith(".") || segment.endsWith(" ") || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(segment))) {
    unsafe("Source path contains an invalid or aliased component");
  }
  if (segments.length - 1 > 16) limit("Source path exceeds 16 directory levels");
  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment.toLowerCase())) ||
      segments.at(-1)!.toLowerCase().startsWith(".env") || FORBIDDEN_FILENAMES.has(segments.at(-1)!.toLowerCase()) ||
      /\.(?:pem|p12|pfx|key|secret|credentials?)$/i.test(segments.at(-1)!)) {
    unsafe("Source path enters a personal, runtime, or secret-bearing scope");
  }
  return segments.join("/");
}

function validateAuthorization(value: unknown): asserts value is ReviewResultAuthorization {
  const authorization = plainRecord(value, ["authorization_id", "project_id", "attempt_id", "filename"], "review result authorization");
  if (typeof authorization.authorization_id !== "string" || authorization.authorization_id.length < 8 ||
      authorization.authorization_id.length > 128 || authorization.authorization_id.includes("\0") ||
      typeof authorization.project_id !== "string" || !UUID.test(authorization.project_id) ||
      typeof authorization.attempt_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(authorization.attempt_id) ||
      typeof authorization.filename !== "string" || authorization.filename.length > 128 ||
      authorization.filename === "." || authorization.filename === ".." || /[\\/:<>"|?*\0]/.test(authorization.filename) ||
      authorization.filename.normalize("NFC") !== authorization.filename || /[\u0000-\u001f\u007f]/.test(authorization.filename) ||
      authorization.filename.endsWith(".") || authorization.filename.endsWith(" ") ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(authorization.filename)) {
    throw new HandoffContextError("RESULT_AUTHORIZATION_REQUIRED", "Host authorization does not name one safe output file");
  }
}

function authorityFor(kind: Exclude<HandoffItemKind, "local-note">): HandoffAuthority {
  switch (kind) {
    case "constraint": return "project-rule";
    case "fact": return "source-claim";
    case "dependency": return "unresolved-dependency";
    case "acceptance": return "acceptance-criterion";
  }
}

function aggregateSourceHash(hashes: ReadonlyMap<string, string>): string {
  const sorted = [...hashes].sort(([left], [right]) => compareText(left, right));
  if (sorted.length === 1) return sorted[0]![1];
  return sha256(Buffer.from(`p03-u07-source-set/v1\n${sorted.map(([file, hash]) => `${file}\0${hash}`).join("\n")}\n`, "utf8"));
}

function plainRecord(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    invalid(`${label} has unexpected fields`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid(`${label} cannot contain accessors`);
  }
  return value as Record<string, unknown>;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(object[key]!)}`).join(",")}}`;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function physicalDirectory(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) unsafe("Expected an absolute physical directory");
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(fs.realpathSync.native(current)) !== pathKey(current)) {
      unsafe("Workspace and result directory components cannot be junctions or symbolic links");
    }
  }
  const canonical = fs.realpathSync.native(resolved);
  if (pathKey(canonical) !== pathKey(resolved)) unsafe("Directory resolves through a link");
  return canonical;
}

function physicalDirectoryIdentity(directory: string): string {
  const stat = fs.statSync(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

interface StableBigintStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function assertPhysicalFile(filename: string, expected: StableBigintStats): void {
  const after = fs.lstatSync(filename, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || !sameStableStat(expected, after) ||
      pathKey(fs.realpathSync.native(filename)) !== pathKey(filename)) {
    throw new HandoffContextError("UNSAFE_PATH", "Result file identity changed during write");
  }
}

function sameFileIdentity(left: StableBigintStats, right: StableBigintStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.birthtimeNs === right.birthtimeNs;
}

function assertExactSourceCase(root: string, relative: string, absolutePath: string): void {
  const canonical = fs.realpathSync.native(absolutePath);
  const actualRelative = path.relative(root, canonical).split(path.sep).join("/");
  if (!isWithin(root, canonical) || actualRelative !== relative) unsafe(`Source path is aliased, linked or not exact-case: ${relative}`);
}

function sameStableStat(
  left: StableBigintStats,
  right: StableBigintStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
}

function stableFileIdentity(stat: Pick<StableBigintStats, "dev" | "ino" | "birthtimeNs">): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function detectLineEndings(value: string): "LF" | "CRLF" {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") continue;
    if (index > 0 && value[index - 1] === "\r") crlfCount += 1;
    else lfCount += 1;
  }
  return crlfCount > lfCount ? "CRLF" : "LF";
}
function isMissing(error: unknown): boolean { return isNodeError(error, "ENOENT"); }
function isAlreadyExists(error: unknown): boolean { return isNodeError(error, "EEXIST"); }
function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function auditEvent(
  authorizationId: string | null,
  projectId: string | null,
  attemptId: string | null,
  filename: string | null,
  bytes: number,
  digest: string | null,
  result: ReviewResultAudit["result"],
  errorCode?: HandoffContextErrorCode,
): ReviewResultAudit {
  return Object.freeze({ authorization_id: authorizationId, project_id: projectId, attempt_id: attemptId,
    filename, bytes, sha256: digest, occurred_at: new Date().toISOString(), result,
    ...(errorCode === undefined ? {} : { error_code: errorCode }) });
}

function reviewProfileInvalid(message: string): never {
  throw new HandoffContextError("REVIEW_PROFILE_INVALID", message);
}
function invalid(message: string): never { throw new HandoffContextError("INVALID_INPUT", message); }
function unsafe(message: string): never { throw new HandoffContextError("UNSAFE_PATH", message); }
function limit(message: string): never { throw new HandoffContextError("LIMIT_EXCEEDED", message); }
