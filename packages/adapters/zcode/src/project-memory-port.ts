import { realpathSync } from "node:fs";
import path from "node:path";
import { isTrustedProjectMapping, type ProjectMapping } from "../../../projects/registry.js";
import type { ProjectMemoryReader } from "./project-memory.js";
import type { ProjectMemoryReadCorrelation } from "./host.js";

interface ReadRequest {
  readonly path: string;
  readonly offsetLine?: number;
  readonly limitLines?: number;
  readonly maxBytes?: number;
  readonly encoding?: string;
  readonly trace?: { readonly sessionId?: string; readonly turnId?: string; readonly spanId?: string };
}

export interface ProjectMemoryReadPortOptions<T extends object> {
  readonly delegate: T;
  readonly project: ProjectMapping;
  readonly workspacePath: string;
  readonly read: (filename: string, correlation: ProjectMemoryReadCorrelation) => ReturnType<ProjectMemoryReader["read"]>;
  readonly createError: (input: { code: "permission_denied" | "io_error" | "too_large"; path: string; message: string; cause?: unknown }) => Error;
}

/** Native stat/range seam. Other FS operations retain their existing contracts. */
export function createProjectMemoryReadPort<T extends object>(input: ProjectMemoryReadPortOptions<T>): T {
  if (!isTrustedProjectMapping(input.project)) throw new Error("A trusted registered project mapping is required");
  const workspace = realpathSync(input.workspacePath);
  if (!input.project.workspaces.some(binding => key(binding.workspacePath) === key(workspace))) {
    throw new Error("Read workspace must belong to the registered project");
  }
  const memoryFamily = path.join(input.project.native.storageRoot, "memories");
  const deny = (filename: string): never => {
    throw input.createError({ code: "permission_denied", path: filename, message: "Project Read is restricted to its workspace and currently selected memory topics" });
  };
  const classify = (request: ReadRequest): "memory" | "workspace" => {
    if (!request || typeof request.path !== "string" || !path.isAbsolute(request.path)) return deny(String(request?.path ?? ""));
    const requested = path.resolve(request.path);
    let canonical = requested;
    try { canonical = realpathSync(requested); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (within(memoryFamily, requested) || within(memoryFamily, canonical)) return "memory";
    if (!within(workspace, requested) || !within(workspace, canonical)) return deny(requested);
    return "workspace";
  };
  const read = (request: ReadRequest, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    const trace = request.trace;
    if (!trace?.sessionId || !trace.turnId || !trace.spanId) return deny(request.path);
    try {
      const source = input.read(request.path, { sessionId: trace.sessionId, turnId: trace.turnId });
      // Native's pinned Read cache prefers mtime over hashes. Omit optional mtime and
      // bind revision to this Read span, so each request reaches the range seam.
      const revision = { id: `sha256:${source.source_hash}/turn:${trace.turnId}/read:${trace.spanId}`,
        sizeBytes: source.sizeBytes, hash: source.source_hash };
      return { source, revision };
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "UNKNOWN";
      throw input.createError({ code: code === "READ_NOT_ADMITTED" || code === "UNTRUSTED_MAPPING" ? "permission_denied" : "io_error",
        path: request.path, message: `Project memory Read rejected: ${code}`, cause });
    }
  };
  return new Proxy(input.delegate, {
    get(target, property) {
      if (property === "stat") return async (request: ReadRequest, options?: { signal?: AbortSignal }) => {
        if (classify(request) === "workspace") return call(target, property, request, options);
        const { source, revision } = read(request, options);
        return { path: request.path, kind: "file", sizeBytes: source.sizeBytes, revision };
      };
      if (property === "readTextFileRange") return async (request: ReadRequest, options?: { signal?: AbortSignal }) => {
        if (classify(request) === "workspace") return call(target, property, request, options);
        if ((request.offsetLine !== undefined && (!Number.isSafeInteger(request.offsetLine) || request.offsetLine < 0)) ||
            (request.limitLines !== undefined && (!Number.isSafeInteger(request.limitLines) || request.limitLines < 1)) ||
            (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1)) ||
            (request.encoding !== undefined && request.encoding !== "utf8" && request.encoding !== "utf-8")) return deny(request.path);
        const { source, revision } = read(request, options);
        if (request.maxBytes !== undefined && source.sizeBytes > request.maxBytes) {
          throw input.createError({ code: "too_large", path: request.path, message: "Selected memory topic exceeds Native Read maxBytes" });
        }
        const normalized = source.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = normalized.length === 0 ? [] : normalized.split("\n");
        const offset = request.offsetLine ?? 0;
        const selected = lines.slice(offset, request.limitLines === undefined ? undefined : offset + request.limitLines);
        const crlf = source.text.match(/\r\n/g)?.length ?? 0;
        const lf = source.text.match(/(?<!\r)\n/g)?.length ?? 0;
        return { path: request.path, content: selected.join("\n"), encoding: "utf8", lineEndings: crlf > lf ? "CRLF" : "LF",
          bytesRead: source.sizeBytes, sizeBytes: source.sizeBytes, truncated: false, startLine: offset + 1,
          lineCount: selected.length, totalLines: lines.length, revision };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function call(target: object, method: string | symbol, ...args: unknown[]): unknown {
  const value: unknown = Reflect.get(target, method, target);
  if (typeof value !== "function") throw new Error(`Native FS port is missing ${String(method)}`);
  return value.apply(target, args);
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function key(value: string): string { return process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
