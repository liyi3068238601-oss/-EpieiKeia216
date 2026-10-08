import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { Lexer, walkTokens, type Token } from "marked";
import { isAlias, parseDocument, visit } from "yaml";
import type { ContextDataRecord } from "../../../contracts/src/context.js";
import { isTrustedProjectMapping, type ProjectMapping, type ProjectRegistry } from "../../../projects/registry.js";

const MAX_INDEX_BYTES = 32_768;
const MAX_INDEX_LINES = 200;
const MAX_TOPIC_BYTES = 32_768;
const MAX_FRONTMATTER_BYTES = 8_192;
const MAX_SELECTED_TOPICS = 8;
const MAX_YAML_DEPTH = 32;
const MAX_SOURCE_REF_BYTES = 512;
const FILE_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

export type MemorySourceKind = "present" | "absent" | "unreadable" | "corrupt";

export interface ProjectMemoryData {
  readonly state: readonly ContextDataRecord[];
  readonly evidence: readonly ContextDataRecord[];
  readonly content: readonly ContextDataRecord[];
}

export interface MemorySource {
  readonly kind: MemorySourceKind;
  readonly path: string;
  readonly source_hash: string | null;
  readonly code: string;
  readonly text?: string;
  readonly sizeBytes?: number;
  readonly mtimeMs?: number;
  readonly frontmatter?: string;
}

export interface ProjectMemorySnapshot {
  readonly kind: MemorySourceKind;
  readonly code: string;
  readonly project_id: string;
  readonly index: MemorySource;
  readonly topics: readonly MemorySource[];
  readonly sampled_at: string;
  readonly data: ProjectMemoryData;
}

export interface ProjectMemoryReader {
  capture(): ProjectMemorySnapshot;
  read(snapshot: ProjectMemorySnapshot, absoluteFilename: string): MemorySource & {
    readonly kind: "present";
    readonly text: string;
    readonly sizeBytes: number;
    readonly mtimeMs: number;
    readonly source_hash: string;
  };
}

export class ProjectMemoryError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectMemoryError";
  }
}

interface FileObservation {
  readonly text: string;
  readonly hash: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly stat: Stats;
}

interface SnapshotAuthority {
  readonly projectId: string;
  readonly revision: number;
  readonly root: string;
  readonly indexHash: string;
  readonly topics: ReadonlyMap<string, string>;
}

interface TopicSelection {
  readonly paths: readonly string[];
  readonly error?: string;
}

class ReaderFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: MemorySourceKind,
    options?: ErrorOptions,
    readonly sourceHash?: string,
  ) {
    super(message, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errno(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function sameFileIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink;
}

function freezeDeep<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) freezeDeep(child, visited);
  return Object.freeze(value);
}

function displayPath(value: string): string {
  return value.length <= 240 ? value : value.slice(0, 220) + "…";
}

function validateRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 ||
      Buffer.byteLength(value, "utf8") > 388 ||
      value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
      value.includes(":") || value.includes("?") || value.includes("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new ReaderFailure("UNSAFE_PATH", "Topic path is not a safe relative Markdown path", "corrupt");
  }
  const parts = value.split("/");
  if (parts.some(part => part.length === 0 || Buffer.byteLength(part, "utf8") > 240 || part === "." || part === ".." ||
      part.endsWith(".") || part.endsWith(" ") || /[\u0000-\u001f\u007f]/.test(part) ||
      DEVICE_NAME.test(part))) {
    throw new ReaderFailure("UNSAFE_PATH", "Topic path contains an unsafe or aliased component", "corrupt");
  }
  if (!value.endsWith(".md")) {
    throw new ReaderFailure("UNSAFE_PATH", "Only .md topic paths are allowed", "corrupt");
  }
  return value;
}

function markdownTarget(href: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch (cause) {
    throw new ReaderFailure("MALFORMED_LINK", "Index link has malformed URL escaping", "corrupt", { cause });
  }
  const fragment = decoded.indexOf("#");
  const destination = fragment < 0 ? decoded : decoded.slice(0, fragment);
  if (destination.length === 0 || destination.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(destination)) {
    throw new ReaderFailure("UNSAFE_PATH", "Index link must be a project-relative Markdown path", "corrupt");
  }
  return validateRelativePath(destination);
}

function parseIndexLinks(markdownText: string, completeIndexText: string): ReadonlySet<string> {
  const lineBreaks = completeIndexText.match(/\r\n|\r|\n/g)?.length ?? 0;
  const lineCount = completeIndexText.length === 0
    ? 0
    : lineBreaks + (/(\r\n|\r|\n)$/.test(completeIndexText) ? 0 : 1);
  if (lineCount > MAX_INDEX_LINES) {
    throw new ReaderFailure("INDEX_LINE_LIMIT", "Memory index exceeds its line limit", "corrupt");
  }
  const links = new Set<string>();
  try {
    const tokens = Lexer.lex(markdownText, { gfm: false });
    walkTokens(tokens, (token: Token) => {
      if (token.type === "link") links.add(markdownTarget(token.href));
    });
  } catch (cause) {
    if (cause instanceof ReaderFailure) throw cause;
    throw new ReaderFailure("INDEX_PARSE_ERROR", "Memory index could not be tokenized", "corrupt", { cause });
  }
  return links;
}

function rootPath(mapping: ProjectMapping): string {
  const expected = path.resolve(mapping.native.storageRoot, "memories", "projects", mapping.native.key, "memory");
  if (!samePath(expected, mapping.native.memoryRoot)) {
    throw new ReaderFailure("UNSAFE_ROOT", "Trusted mapping has an unexpected Native memory root", "corrupt");
  }
  return expected;
}

function classifyIO(error: unknown, message: string): ReaderFailure {
  const code = errno(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ReaderFailure("NOT_FOUND", message, "corrupt", { cause: error });
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ReaderFailure("PERMISSION_DENIED", message, "unreadable", { cause: error });
  }
  return new ReaderFailure("IO_ERROR", message, "unreadable", { cause: error });
}

function locateMemoryRoot(mapping: ProjectMapping): string | undefined {
  const storageRoot = path.resolve(mapping.native.storageRoot);
  let current = storageRoot;
  let storageStat: Stats;
  try {
    storageStat = lstatSync(current);
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw classifyIO(error, "Native storage root cannot be inspected");
  }
  if (!storageStat.isDirectory() || storageStat.isSymbolicLink()) {
    throw new ReaderFailure("UNSAFE_ROOT", "Native storage root is not a physical directory", "corrupt");
  }
  const storageReal = realpathSync(current);
  if (!samePath(storageRoot, storageReal)) {
    throw new ReaderFailure("UNSAFE_ROOT", "Native storage root resolves through an alias", "corrupt");
  }
  const relative = path.relative(storageRoot, rootPath(mapping));
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new ReaderFailure("UNSAFE_ROOT", "Native memory root is outside its storage root", "corrupt");
  }
  for (const component of relative.split(path.sep)) {
    if (!component || component === "." || component === "..") {
      throw new ReaderFailure("UNSAFE_ROOT", "Native memory root has an invalid component", "corrupt");
    }
    let names: string[];
    try {
      names = readdirSync(current);
    } catch (error) {
      throw classifyIO(error, "Native storage directory cannot be enumerated");
    }
    if (!names.includes(component)) {
      if (names.some(name => name.toLowerCase() === component.toLowerCase())) {
        throw new ReaderFailure("CASE_MISMATCH", "Native memory path component has different on-disk case", "corrupt");
      }
      return undefined;
    }
    current = path.join(current, component);
    let item: Stats;
    try {
      item = lstatSync(current);
    } catch (error) {
      throw classifyIO(error, "Native memory root changed while being inspected");
    }
    if (!item.isDirectory() || item.isSymbolicLink()) {
      throw new ReaderFailure("UNSAFE_ROOT", "Native memory root contains a link or non-directory", "corrupt");
    }
    const real = realpathSync(current);
    if (!isWithin(storageReal, real)) {
      throw new ReaderFailure("UNSAFE_ROOT", "Native memory root escapes the storage root", "corrupt");
    }
  }
  return realpathSync(current);
}

function locateFile(root: string, relative: string): {
  readonly filename: string;
  readonly realpath: string;
  readonly rootReal: string;
  readonly stat: Stats;
} {
  const parts = relative.split("/");
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    throw classifyIO(error, "Memory root changed while resolving a source");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ReaderFailure("UNSAFE_ROOT", "Memory root is no longer a physical directory", "corrupt");
  }
  const rootReal = realpathSync(root);
  if (!samePath(root, rootReal)) {
    throw new ReaderFailure("UNSAFE_ROOT", "Memory root resolves through an alias", "corrupt");
  }
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const component = parts[index]!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch (error) {
      throw classifyIO(error, "Memory directory cannot be enumerated");
    }
    if (!names.includes(component)) {
      throw new ReaderFailure("NOT_FOUND", "Memory source does not exist with the exact indexed case", "corrupt");
    }
    current = path.join(current, component);
    let item: Stats;
    try {
      item = lstatSync(current);
    } catch (error) {
      throw classifyIO(error, "Memory source changed while being inspected");
    }
    if (item.isSymbolicLink()) {
      throw new ReaderFailure("UNSAFE_PATH", "Memory source contains a symlink or junction", "corrupt");
    }
    const final = index === parts.length - 1;
    if (final) {
      if (!item.isFile() || item.nlink !== 1) {
        throw new ReaderFailure("UNSAFE_FILE", "Memory source must be a singly-linked regular file", "corrupt");
      }
    } else if (!item.isDirectory()) {
      throw new ReaderFailure("UNSAFE_PATH", "Memory topic parent is not a physical directory", "corrupt");
    }
    const real = realpathSync(current);
    if (!isWithin(rootReal, real)) {
      throw new ReaderFailure("UNSAFE_PATH", "Memory source escapes its project root", "corrupt");
    }
    if (final) return { filename: current, realpath: real, rootReal, stat: item };
  }
  throw new ReaderFailure("UNSAFE_PATH", "Memory source path is empty", "corrupt");
}

function readStableFile(root: string, relative: string, maximum: number): FileObservation {
  const located = locateFile(root, relative);
  let descriptor: number;
  try {
    descriptor = openSync(located.filename, FILE_FLAGS);
  } catch (error) {
    throw classifyIO(error, "Memory source could not be opened");
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !sameFileIdentity(located.stat, before)) {
      throw new ReaderFailure("SOURCE_CHANGED", "Memory source changed before it was opened", "corrupt");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(8192, maximum + 1));
    for (;;) {
      const remaining = maximum + 1 - total;
      if (remaining <= 0) throw new ReaderFailure("SOURCE_LIMIT", "Memory source exceeds its byte limit", "corrupt");
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, remaining), null);
      if (count === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, count)));
      total += count;
      if (total > maximum) throw new ReaderFailure("SOURCE_LIMIT", "Memory source exceeds its byte limit", "corrupt");
    }
    const bytes = Buffer.concat(chunks, total);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const after = fstatSync(descriptor);
    let pathAfter: Stats;
    try {
      pathAfter = lstatSync(located.filename);
    } catch (error) {
      throw classifyIO(error, "Memory source disappeared during its read");
    }
    const pathAgain = locateFile(root, relative);
    let realpathAfter: string;
    try {
      realpathAfter = realpathSync(located.filename);
    } catch (error) {
      throw classifyIO(error, "Memory source physical path changed during its read");
    }
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter) ||
        pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.nlink !== 1 ||
        !samePath(pathAgain.realpath, located.realpath) ||
        !samePath(realpathAfter, located.realpath) ||
        !isWithin(pathAgain.rootReal, realpathAfter)) {
      throw new ReaderFailure("SOURCE_CHANGED", "Memory source changed while it was read", "corrupt");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (cause) {
      throw new ReaderFailure("INVALID_UTF8", "Memory source is not valid UTF-8", "corrupt", { cause }, hash);
    }
    if (text.includes("\0")) {
      throw new ReaderFailure("NUL_BYTE", "Memory source contains a NUL byte", "corrupt", undefined, hash);
    }
    return { text, hash, sizeBytes: bytes.byteLength, mtimeMs: after.mtimeMs, stat: after };
  } catch (error) {
    if (error instanceof ReaderFailure) throw error;
    throw classifyIO(error, "Memory source could not be read");
  } finally {
    closeSync(descriptor);
  }
}

function sourceFromFailure(relative: string, failure: ReaderFailure, hash: string | null = failure.sourceHash ?? null): MemorySource {
  return freezeDeep({ kind: failure.kind, path: displayPath(relative), source_hash: hash, code: failure.code });
}

function sourceFromObservation(relative: string, observation: FileObservation, frontmatter?: string): MemorySource {
  return freezeDeep({
    kind: "present" as const,
    path: relative,
    source_hash: observation.hash,
    code: "OK",
    text: observation.text,
    sizeBytes: observation.sizeBytes,
    mtimeMs: observation.mtimeMs,
    ...(frontmatter === undefined ? {} : { frontmatter }),
  });
}

function parseFrontmatter(text: string): string | undefined {
  const firstLineEnd = text.indexOf("\n");
  const firstLineRaw = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd);
  const firstLine = firstLineRaw.endsWith("\r") ? firstLineRaw.slice(0, -1) : firstLineRaw;
  const opener = firstLine.startsWith("\uFEFF") ? firstLine.slice(1) : firstLine;
  if (opener !== "---") return undefined;
  if (firstLineEnd < 0) {
    throw new ReaderFailure("FRONTMATTER_UNTERMINATED", "Topic frontmatter has no closing delimiter", "corrupt");
  }
  const bodyStart = firstLineEnd + 1;
  let lineStart = bodyStart;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const rawLine = text.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") {
      const closeEnd = newline < 0 ? lineEnd : newline + 1;
      const raw = text.slice(0, closeEnd);
      if (Buffer.byteLength(raw, "utf8") > MAX_FRONTMATTER_BYTES) {
        throw new ReaderFailure("FRONTMATTER_LIMIT", "Topic frontmatter exceeds its byte limit", "corrupt");
      }
      const yamlText = text.slice(bodyStart, lineStart);
      try {
        const document = parseDocument(yamlText, {
          uniqueKeys: true,
          strict: true,
          version: "1.2",
        });
        if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("YAML parser reported an issue");
        visit(document, (_key, node, stack) => {
          if (stack.length > MAX_YAML_DEPTH) throw new Error("YAML nesting exceeds its limit");
          if (isAlias(node)) throw new Error("YAML aliases are forbidden");
        });
        document.toJS({ maxAliasCount: 0 });
      } catch (cause) {
        const code = cause instanceof Error && cause.message === "YAML nesting exceeds its limit"
          ? "FRONTMATTER_DEPTH" : "FRONTMATTER_INVALID";
        throw new ReaderFailure(code, "Topic frontmatter is invalid or exceeds parser limits", "corrupt", { cause });
      }
      return raw;
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  throw new ReaderFailure("FRONTMATTER_UNTERMINATED", "Topic frontmatter has no closing delimiter", "corrupt");
}

function aggregateKind(index: MemorySource, topics: readonly MemorySource[]): MemorySourceKind {
  const sources = [index, ...topics];
  if (sources.some(source => source.kind === "corrupt")) return "corrupt";
  if (sources.some(source => source.kind === "unreadable")) return "unreadable";
  return index.kind;
}

function makeData(
  projectId: string,
  sampledAt: string,
  index: MemorySource,
  topics: readonly MemorySource[],
  kind: MemorySourceKind,
): ProjectMemoryData {
  const indexRef = "project-memory:" + projectId + "/MEMORY.md@sha256:" + (index.source_hash ?? "unavailable");
  if (Buffer.byteLength(indexRef, "utf8") > MAX_SOURCE_REF_BYTES) {
    throw new ProjectMemoryError("SOURCE_REF_TOO_LONG", "Project memory index reference exceeds its limit");
  }
  const state: ContextDataRecord[] = [{
    source_refs: [indexRef],
    value: {
      kind: "project-memory-index",
      project_id: projectId,
      sampled_at: sampledAt,
      state: index.kind,
      code: index.code,
      source_hash: index.source_hash,
    },
  }];
  const content: ContextDataRecord[] = [];
  if (kind === "present") {
    for (const topic of topics) {
      if (topic.kind !== "present" || topic.text === undefined || topic.source_hash === null) continue;
      const reference = "project-memory:" + projectId + "/" + topic.path + "@sha256:" + topic.source_hash;
      if (Buffer.byteLength(reference, "utf8") > MAX_SOURCE_REF_BYTES) {
        throw new ProjectMemoryError("SOURCE_REF_TOO_LONG", "Project memory topic reference exceeds its limit");
      }
      content.push({
        source_refs: [reference],
        value: {
          kind: "project-memory-topic",
          project_id: projectId,
          sampled_at: sampledAt,
          authority: "experience-lead",
          path: topic.path,
          source_hash: topic.source_hash,
          text: topic.text,
          frontmatter: topic.frontmatter ?? null,
        },
      });
    }
  }
  return freezeDeep({ state, evidence: [], content });
}

function mappingFor(registry: ProjectRegistry, workspacePath: string): ProjectMapping {
  try {
    const mapping = registry.resolveWorkspace(workspacePath);
    if (!isTrustedProjectMapping(mapping)) {
      throw new ProjectMemoryError("UNTRUSTED_MAPPING", "Workspace did not resolve to a trusted project mapping");
    }
    return mapping;
  } catch (cause) {
    if (cause instanceof ProjectMemoryError) throw cause;
    throw new ProjectMemoryError(errno(cause) ?? "MAPPING_UNAVAILABLE",
      "Workspace project mapping could not be revalidated", { cause });
  }
}

function selectedPathList(getSelected: () => readonly string[]): TopicSelection {
  let selected: readonly string[];
  try {
    selected = getSelected();
  } catch {
    return { paths: [], error: "SELECTION_UNAVAILABLE" };
  }
  if (!Array.isArray(selected)) return { paths: [], error: "INVALID_SELECTION" };
  if (selected.length > MAX_SELECTED_TOPICS) return { paths: [], error: "SELECTED_TOPIC_LIMIT" };
  const paths: string[] = [];
  const seen = new Set<string>();
  try {
    for (const entry of selected) {
      if (typeof entry !== "string") throw new ReaderFailure("INVALID_SELECTION", "Selected path is not text", "corrupt");
      const safe = validateRelativePath(entry);
      if (seen.has(safe)) throw new ReaderFailure("DUPLICATE_SELECTION", "Selected paths must be unique", "corrupt");
      seen.add(safe);
      paths.push(safe);
    }
  } catch (error) {
    const failure = error instanceof ReaderFailure ? error : new ReaderFailure("INVALID_SELECTION", "Selected paths are invalid", "corrupt");
    return { paths, error: failure.code };
  }
  if (paths.length > MAX_SELECTED_TOPICS) return { paths, error: "SELECTED_TOPIC_LIMIT" };
  return { paths };
}

function bytesHash(root: string, relative: string, maximum: number): string | null {
  try {
    return readStableFile(root, relative, maximum).hash;
  } catch (error) {
    if (error instanceof ReaderFailure && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

export function createProjectMemoryReader(input: {
  readonly registry: ProjectRegistry;
  readonly workspacePath: string;
  readonly selectedTopics: () => readonly string[];
}): ProjectMemoryReader {
  if (!input || !input.registry || typeof input.workspacePath !== "string" ||
      !path.isAbsolute(input.workspacePath) || typeof input.selectedTopics !== "function") {
    throw new ProjectMemoryError("INVALID_INPUT", "A registry, absolute workspace path and topic selector are required");
  }
  const snapshots = new WeakMap<object, SnapshotAuthority>();

  const capture = (): ProjectMemorySnapshot => {
    const initial = mappingFor(input.registry, input.workspacePath);
    const root = rootPath(initial);
    const selection = selectedPathList(input.selectedTopics);
    let memoryRoot: string | undefined;
    let index: MemorySource;
    let topics: MemorySource[] = [];
    let indexText: string | undefined;

    try {
      memoryRoot = locateMemoryRoot(initial);
      if (memoryRoot === undefined) {
        index = freezeDeep({ kind: "absent", path: "MEMORY.md", source_hash: null, code: "NOT_FOUND" as const });
      } else {
        const observation = readStableFile(memoryRoot, "MEMORY.md", MAX_INDEX_BYTES);
        indexText = observation.text;
        try {
          const frontmatter = parseFrontmatter(observation.text);
          const markdownBody = frontmatter === undefined
            ? observation.text
            : observation.text.slice(frontmatter.length);
          const links = parseIndexLinks(markdownBody, observation.text);
          index = sourceFromObservation("MEMORY.md", observation);
          if (selection.error !== undefined) {
            index = sourceFromFailure("MEMORY.md",
              new ReaderFailure(selection.error, "Selected topic set is invalid or exceeds its bound", "corrupt"),
              observation.hash);
          } else {
            for (const relative of selection.paths) {
              if (!links.has(relative)) {
                topics.push(sourceFromFailure(relative,
                  new ReaderFailure("NOT_INDEXED", "Selected topic is not linked by MEMORY.md", "corrupt")));
                continue;
              }
              let topicObservation: FileObservation | undefined;
              try {
                topicObservation = readStableFile(memoryRoot, relative, MAX_TOPIC_BYTES);
                const frontmatter = parseFrontmatter(topicObservation.text);
                topics.push(sourceFromObservation(relative, topicObservation, frontmatter));
              } catch (error) {
                const failure = error instanceof ReaderFailure
                  ? error
                  : classifyIO(error, "Selected memory topic could not be read");
                const selectedFailure = failure.code === "NOT_FOUND"
                  ? new ReaderFailure("BROKEN_POINTER", "MEMORY.md links to a missing topic", "corrupt", { cause: failure })
                  : failure;
                const hash = topicObservation?.hash ?? selectedFailure.sourceHash ?? null;
                topics.push(sourceFromFailure(relative, selectedFailure, hash));
              }
            }
          }
        } catch (error) {
          const failure = error instanceof ReaderFailure
            ? error
            : new ReaderFailure("INDEX_PARSE_ERROR", "Memory index could not be parsed", "corrupt", { cause: error });
          index = sourceFromFailure("MEMORY.md", failure, observation.hash);
        }
      }
    } catch (error) {
      const failure = error instanceof ReaderFailure
        ? error
        : classifyIO(error, "Memory index could not be read");
      index = failure.code === "NOT_FOUND"
        ? freezeDeep({ kind: "absent", path: "MEMORY.md", source_hash: null, code: "NOT_FOUND" as const })
        : sourceFromFailure("MEMORY.md", failure);
    }

    if (selection.error !== undefined && index.kind === "absent") {
      index = sourceFromFailure("MEMORY.md",
        new ReaderFailure(selection.error, "Selected topic set is invalid or exceeds its bound", "corrupt"));
    }
    if (index.kind === "absent") topics = [];
    else if (index.kind !== "present" && topics.length === 0 && selection.paths.length > 0) {
      const topicKind = index.kind === "unreadable" ? "unreadable" : "corrupt";
      topics = selection.paths.map(relative => sourceFromFailure(relative,
        new ReaderFailure(index.code, "Selected topic cannot be read without a valid index", topicKind)));
    }
    if (selection.error !== undefined && topics.length === 0 && index.kind !== "absent") {
      topics = selection.paths.map(relative => sourceFromFailure(relative,
        new ReaderFailure(selection.error!, "Selected topic set is invalid or exceeds its bound", "corrupt")));
    }

    let changed = false;
    try {
      const current = mappingFor(input.registry, input.workspacePath);
      if (current.projectId !== initial.projectId || current.revision !== initial.revision ||
          !samePath(current.native.memoryRoot, initial.native.memoryRoot) ||
          !samePath(current.native.storageRoot, initial.native.storageRoot)) {
        changed = true;
      } else {
        const currentRoot = locateMemoryRoot(current);
        if (memoryRoot === undefined) changed = currentRoot !== undefined;
        else if (currentRoot === undefined) changed = true;
        else if (index.kind === "present" && index.source_hash !== null) {
          changed = bytesHash(currentRoot, "MEMORY.md", MAX_INDEX_BYTES) !== index.source_hash;
          for (const topic of topics) {
            if (topic.kind === "present" && topic.source_hash !== null &&
                bytesHash(currentRoot, topic.path, MAX_TOPIC_BYTES) !== topic.source_hash) changed = true;
          }
        } else if (index.kind === "absent") {
          changed = bytesHash(currentRoot, "MEMORY.md", MAX_INDEX_BYTES) !== null;
        }
      }
    } catch {
      changed = true;
    }
    if (changed) {
      index = sourceFromFailure("MEMORY.md",
        new ReaderFailure("SOURCE_CHANGED", "Project memory changed during capture", "corrupt"));
      topics = selection.paths.map(relative => sourceFromFailure(relative,
        new ReaderFailure("SOURCE_CHANGED", "Project memory changed during capture", "corrupt")));
    }

    const kind = aggregateKind(index, topics);
    const sampledAt = new Date().toISOString();
    const data = makeData(initial.projectId, sampledAt, index, topics, kind);
    const snapshot = freezeDeep({
      kind,
      code: kind === "present" || kind === "absent"
        ? "OK"
        : (topics.find(topic => topic.kind === kind)?.code ?? index.code),
      project_id: initial.projectId,
      index,
      topics,
      sampled_at: sampledAt,
      data,
    });
    const expectedTopics = new Map<string, string>();
    for (const topic of topics) {
      if (topic.kind === "present" && topic.source_hash !== null) expectedTopics.set(topic.path, topic.source_hash);
    }
    if (kind === "present" && index.kind === "present" && index.source_hash !== null) {
      snapshots.set(snapshot, {
        projectId: initial.projectId,
        revision: initial.revision,
        root,
        indexHash: index.source_hash,
        topics: expectedTopics,
      });
    }
    return snapshot;
  };

  const read: ProjectMemoryReader["read"] = (snapshot, absoluteFilename) => {
    const authority = isRecord(snapshot) ? snapshots.get(snapshot) : undefined;
    if (authority === undefined) throw new ProjectMemoryError("READ_NOT_ADMITTED", "Snapshot was not captured by this reader");
    if (snapshot.kind !== "present" || typeof absoluteFilename !== "string" || !path.isAbsolute(absoluteFilename)) {
      throw new ProjectMemoryError("READ_NOT_ADMITTED", "Read requires a present snapshot and absolute selected path");
    }
    const requested = path.resolve(absoluteFilename);
    const relative = path.relative(authority.root, requested).split(path.sep).join("/");
    if (!authority.topics.has(relative)) {
      throw new ProjectMemoryError("READ_NOT_ADMITTED", "Read path is not one of the snapshot's selected topics");
    }
    const current = mappingFor(input.registry, input.workspacePath);
    if (current.projectId !== authority.projectId || current.revision !== authority.revision ||
        !samePath(current.native.memoryRoot, authority.root)) {
      throw new ProjectMemoryError("SOURCE_CHANGED", "Project mapping changed after memory capture");
    }
    const memoryRoot = locateMemoryRoot(current);
    if (memoryRoot === undefined) throw new ProjectMemoryError("SOURCE_CHANGED", "Project memory root disappeared after capture");
    try {
      if (readStableFile(memoryRoot, "MEMORY.md", MAX_INDEX_BYTES).hash !== authority.indexHash) {
        throw new ProjectMemoryError("SOURCE_CHANGED", "Memory index changed after capture");
      }
      for (const [topicPath, expectedHash] of authority.topics) {
        if (readStableFile(memoryRoot, topicPath, MAX_TOPIC_BYTES).hash !== expectedHash) {
          throw new ProjectMemoryError("SOURCE_CHANGED", "Selected memory topic changed after capture");
        }
      }
      const source = readStableFile(memoryRoot, relative, MAX_TOPIC_BYTES);
      const captured = snapshot.topics.find(topic => topic.path === relative);
      if (captured === undefined || captured.kind !== "present" || source.hash !== captured.source_hash) {
        throw new ProjectMemoryError("SOURCE_CHANGED", "Selected topic no longer matches its snapshot");
      }
      return sourceFromObservation(relative, source, parseFrontmatter(source.text)) as MemorySource & {
        readonly kind: "present";
        readonly text: string;
        readonly sizeBytes: number;
        readonly mtimeMs: number;
        readonly source_hash: string;
      };
    } catch (cause) {
      if (cause instanceof ProjectMemoryError) throw cause;
      const code = cause instanceof ReaderFailure ? cause.code : errno(cause) ?? "IO_ERROR";
      throw new ProjectMemoryError(code === "NOT_FOUND" ? "SOURCE_CHANGED" : code,
        "Selected memory Read failed closed", { cause });
    }
  };

  return Object.freeze({ capture, read });
}
