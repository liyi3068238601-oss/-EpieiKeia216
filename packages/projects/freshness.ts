import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { isTrustedProjectMapping, type ProjectMapping, type ProjectRegistry } from "./registry.js";

const MAX_EVIDENCE_FILES = 64;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const observations = new WeakMap<object, ObservationBinding>();
const validReceipts = new WeakSet<object>();
const receiptBindings = new WeakMap<object, ReceiptBinding>();
const consumedReceipts = new WeakSet<object>();

export type FreshnessUnknownReason =
  | "MAPPING_UNAVAILABLE"
  | "GIT_HEAD_UNAVAILABLE"
  | "INVALID_EVIDENCE_PATH"
  | "MISSING_EVIDENCE"
  | "UNREADABLE_EVIDENCE"
  | "UNSAFE_EVIDENCE_PATH"
  | "INCOMPLETE_OBSERVATION"
  | "UNTRUSTED_OBSERVATION"
  | "PRIOR_SNAPSHOT_INCOMPLETE"
  | "PROJECT_MISMATCH"
  | "REF_SET_MISMATCH";

export interface FreshnessEvidenceRef {
  readonly path: string;
  readonly sourceSha256: string;
}

export interface FreshnessSnapshot {
  readonly projectId: string;
  readonly gitHead: string;
  readonly refs: readonly FreshnessEvidenceRef[];
  readonly sampledAt: string;
}

export interface FreshnessUnknownRef {
  readonly path: string;
  readonly reason: FreshnessUnknownReason;
}

export type FreshnessObservation =
  | { readonly state: "observed"; readonly snapshot: FreshnessSnapshot }
  | {
      readonly state: "unknown";
      readonly reason: FreshnessUnknownReason;
      readonly unknownRefs: readonly FreshnessUnknownRef[];
    };

export type FreshnessChange =
  | { readonly kind: "git_head_changed"; readonly previous: string; readonly current: string }
  | { readonly kind: "evidence_hash_changed"; readonly path: string; readonly previous: string; readonly current: string };

export type FreshnessAssessment =
  | { readonly state: "current"; readonly changes: readonly []; readonly unknownRefs: readonly [] }
  | { readonly state: "needs_recheck"; readonly changes: readonly FreshnessChange[]; readonly unknownRefs: readonly [] }
  | {
      readonly state: "unknown";
      readonly reasons: readonly FreshnessUnknownReason[];
      readonly unknownRefs: readonly FreshnessUnknownRef[];
    };

export interface CaptureFreshnessInput {
  readonly registry: ProjectRegistry;
  readonly workspacePath: string;
  readonly evidencePaths: readonly string[];
}

interface ObservationBinding {
  readonly registry?: ProjectRegistry;
  readonly workspacePath?: string;
  readonly evidencePaths: readonly string[];
  readonly snapshot: FreshnessSnapshot | null;
  readonly identity?: string;
}

class ObservationFailure extends Error {
  constructor(readonly reason: FreshnessUnknownReason, options?: ErrorOptions) {
    super(reason, options);
  }
}

export class FreshnessError extends Error {
  constructor(readonly code: FreshnessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FreshnessError";
  }
}

export type FreshnessErrorCode =
  | "INVALID_PROPOSAL"
  | "INVALID_OBSERVATION"
  | "HOST_REJECTED"
  | "INVALID_HOST_ACCEPTANCE"
  | "STALE_OBSERVATION"
  | "INVALID_RECEIPT"
  | "HISTORY_MISMATCH"
  | "DUPLICATE_ACCEPTANCE";

function errno(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function unknownReason(error: unknown): FreshnessUnknownReason {
  if (error instanceof ObservationFailure) return error.reason;
  const code = errno(error);
  if (code === "ENOENT" || code === "ENOTDIR") return "MISSING_EVIDENCE";
  if (code === "EACCES" || code === "EPERM") return "UNREADABLE_EVIDENCE";
  return "INCOMPLETE_OBSERVATION";
}

function validSampleTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validateEvidencePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0") ||
      value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value) || value.normalize("NFC") !== value) {
    throw new ObservationFailure("INVALID_EVIDENCE_PATH");
  }
  const parts = value.split("/");
  const privateSegments = new Set([".git", ".runtime", ".codex", ".dsh", ".zcode", ".ssh", ".aws", ".config",
    ".npmrc", "private", "life", "personal", "user-data", "secrets", "credentials"]);
  if (parts.some(part => part.length === 0 || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) ||
      /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
      privateSegments.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))) {
    throw new ObservationFailure("INVALID_EVIDENCE_PATH");
  }
  return parts.join("/");
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  return env;
}

function gitHead(workspacePath: string): string {
  try {
    const noHooks = path.join(path.resolve(process.env.TEMP ?? process.env.TMP ?? process.cwd()),
      `xiadie-u08-no-hooks-${randomUUID()}`);
    const value = execFileSync("git", [
      "-c", "core.fsmonitor=false",
      "-c", `core.hooksPath=${noHooks}`,
      "-C", workspacePath,
      "rev-parse", "--verify", "HEAD^{commit}",
    ], {
      encoding: "utf8",
      env: safeGitEnvironment(),
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().toLowerCase();
    if (!GIT_HEAD.test(value)) throw new Error("Git returned an invalid commit id");
    return value;
  } catch (cause) {
    throw new ObservationFailure("GIT_HEAD_UNAVAILABLE", { cause });
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function sameFileStamp(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}

function readLiteralEvidence(root: string, relative: string): Buffer {
  const literalRoot = lstatSync(root, { bigint: true });
  const rootReal = realpathSync.native(root);
  const rootStat = lstatSync(rootReal, { bigint: true });
  if (literalRoot.isSymbolicLink() || !literalRoot.isDirectory() || rootStat.isSymbolicLink() || !rootStat.isDirectory() ||
      !samePath(root, rootReal)) throw new ObservationFailure("UNSAFE_EVIDENCE_PATH");

  let cursor = rootReal;
  const segments = relative.split("/");
  const directories: { path: string; stat: BigIntStats }[] = [{ path: rootReal, stat: rootStat }];
  let beforePath: BigIntStats | undefined;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const names = readdirSync(cursor);
    if (!names.includes(segment)) {
      if (names.some(name => name.normalize("NFC").toLowerCase() === segment.toLowerCase())) {
        throw new ObservationFailure("UNSAFE_EVIDENCE_PATH");
      }
      throw new ObservationFailure("MISSING_EVIDENCE");
    }
    cursor = path.join(cursor, segment);
    const item = lstatSync(cursor, { bigint: true });
    if (item.isSymbolicLink() || (index < segments.length - 1 && !item.isDirectory())) {
      throw new ObservationFailure("UNSAFE_EVIDENCE_PATH");
    }
    if (index === segments.length - 1) {
      if (!item.isFile() || item.nlink !== 1n) throw new ObservationFailure("UNSAFE_EVIDENCE_PATH");
      beforePath = item;
    } else directories.push({ path: cursor, stat: item });
  }

  const physicalFile = realpathSync.native(cursor);
  if (!inside(rootReal, physicalFile)) throw new ObservationFailure("UNSAFE_EVIDENCE_PATH");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(cursor, fsConstants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !beforePath || !sameFileStamp(beforePath, before)) {
      throw new ObservationFailure("UNSAFE_EVIDENCE_PATH");
    }
    if (before.size > BigInt(MAX_EVIDENCE_BYTES)) throw new ObservationFailure("INCOMPLETE_OBSERVATION");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new ObservationFailure("INCOMPLETE_OBSERVATION");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(cursor, { bigint: true });
    const finalPhysical = realpathSync.native(cursor);
    if (!sameFileStamp(before, after) || !sameFileStamp(after, afterPath) || afterPath.isSymbolicLink() || afterPath.nlink !== 1n ||
        physicalFile !== finalPhysical || !inside(rootReal, finalPhysical)) {
      throw new ObservationFailure("INCOMPLETE_OBSERVATION");
    }
    for (const directory of directories) {
      const current = lstatSync(directory.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.stat.dev ||
          current.ino !== directory.stat.ino || current.birthtimeNs !== directory.stat.birthtimeNs ||
          !samePath(realpathSync.native(directory.path), directory.path)) {
        throw new ObservationFailure("INCOMPLETE_OBSERVATION");
      }
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function canonicalEvidenceRefs(refs: readonly FreshnessEvidenceRef[]): readonly FreshnessEvidenceRef[] {
  return Object.freeze([...refs]
    .map(ref => Object.freeze({ path: ref.path, sourceSha256: ref.sourceSha256.toLowerCase() }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function makeObservation(
  result: FreshnessObservation,
  binding: ObservationBinding,
): FreshnessObservation {
  const frozen = Object.freeze(result);
  observations.set(frozen, binding);
  return frozen;
}

function workspaceIdentity(mapping: ProjectMapping, workspacePath: string): string {
  if (!isTrustedProjectMapping(mapping)) throw new ObservationFailure("MAPPING_UNAVAILABLE");
  const workspace = mapping.workspaces.find(item => samePath(item.workspacePath, workspacePath));
  if (!workspace) throw new ObservationFailure("MAPPING_UNAVAILABLE");
  return JSON.stringify({ projectId: mapping.projectId, revision: mapping.revision,
    commonIdentity: mapping.commonIdentity, native: mapping.native, workspace });
}

function capture(input: CaptureFreshnessInput, evidencePaths: readonly string[]): FreshnessObservation {
  const sampledAt = new Date().toISOString();

  let mapping: ProjectMapping;
  let resolvedWorkspace: string;
  let identity: string;
  try {
    mapping = input.registry.resolveWorkspace(input.workspacePath);
    if (!isTrustedProjectMapping(mapping)) throw new Error("Untrusted project mapping");
    const requested = path.resolve(input.workspacePath);
    const workspace = mapping.workspaces.find(candidate => samePath(candidate.workspacePath, requested));
    if (workspace === undefined) throw new Error("Resolved mapping does not contain this workspace");
    resolvedWorkspace = workspace.workspacePath;
    identity = workspaceIdentity(mapping, resolvedWorkspace);
  } catch {
    return makeObservation({ state: "unknown", reason: "MAPPING_UNAVAILABLE", unknownRefs: [] }, {
      registry: input.registry, workspacePath: input.workspacePath, evidencePaths, snapshot: null,
    });
  }

  let head: string;
  try {
    head = gitHead(resolvedWorkspace);
  } catch {
    return makeObservation({ state: "unknown", reason: "GIT_HEAD_UNAVAILABLE", unknownRefs: [] }, {
      registry: input.registry, workspacePath: resolvedWorkspace, evidencePaths, snapshot: null,
    });
  }

  const failures: FreshnessUnknownRef[] = [];
  const refs: FreshnessEvidenceRef[] = [];
  for (const evidencePath of evidencePaths) {
    try {
      const bytes = readLiteralEvidence(resolvedWorkspace, evidencePath);
      refs.push({ path: evidencePath, sourceSha256: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) {
      failures.push({ path: evidencePath, reason: unknownReason(error) });
    }
  }
  if (failures.length > 0 || refs.length !== evidencePaths.length || refs.length === 0) {
    const unknownRefs = Object.freeze(failures.map(ref => Object.freeze(ref)));
    return makeObservation({
      state: "unknown",
      reason: failures[0]?.reason ?? "INCOMPLETE_OBSERVATION",
      unknownRefs,
    }, { registry: input.registry, workspacePath: resolvedWorkspace, evidencePaths, snapshot: null });
  }

  // Recheck the whole observation, including earlier files, before branding it.
  // A stable per-file read alone does not make a multi-file snapshot consistent.
  try {
    const currentMapping = input.registry.resolveWorkspace(resolvedWorkspace);
    const previousWorkspace = mapping.workspaces.find(item => samePath(item.workspacePath, resolvedWorkspace))!;
    const currentWorkspace = currentMapping.workspaces.find(item => samePath(item.workspacePath, resolvedWorkspace));
    if (!isTrustedProjectMapping(currentMapping) || currentMapping.projectId !== mapping.projectId ||
        currentMapping.revision !== mapping.revision || currentMapping.commonIdentity !== mapping.commonIdentity ||
        !currentWorkspace || currentWorkspace.commonIdentity !== previousWorkspace.commonIdentity ||
        currentWorkspace.privateIdentity !== previousWorkspace.privateIdentity ||
        !samePath(currentWorkspace.gitCommonDir, previousWorkspace.gitCommonDir) ||
        !samePath(currentWorkspace.gitPrivateDir, previousWorkspace.gitPrivateDir) || gitHead(resolvedWorkspace) !== head) {
      throw new ObservationFailure("INCOMPLETE_OBSERVATION");
    }
    for (const ref of refs) {
      const hash = createHash("sha256").update(readLiteralEvidence(resolvedWorkspace, ref.path)).digest("hex");
      if (hash !== ref.sourceSha256) failures.push({ path: ref.path, reason: "INCOMPLETE_OBSERVATION" });
    }
    if (gitHead(resolvedWorkspace) !== head ||
        workspaceIdentity(input.registry.resolveWorkspace(resolvedWorkspace), resolvedWorkspace) !== identity) {
      throw new ObservationFailure("INCOMPLETE_OBSERVATION");
    }
  } catch (error) {
    const reason = unknownReason(error);
    failures.push(...evidencePaths.map(evidencePath => ({ path: evidencePath, reason })));
  }
  if (failures.length > 0) {
    return makeObservation({ state: "unknown", reason: failures[0]!.reason,
      unknownRefs: Object.freeze(failures.map(ref => Object.freeze(ref))) },
    { registry: input.registry, workspacePath: resolvedWorkspace, evidencePaths, snapshot: null });
  }

  const snapshot: FreshnessSnapshot = Object.freeze({
    projectId: mapping.projectId,
    gitHead: head,
    refs: canonicalEvidenceRefs(refs),
    sampledAt,
  });
  const observation = makeObservation({ state: "observed", snapshot }, {
    registry: input.registry,
    workspacePath: resolvedWorkspace,
    evidencePaths,
    snapshot,
    identity,
  });
  return observation;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function captureFreshnessSnapshot(input: CaptureFreshnessInput): FreshnessObservation {
  if (!input || typeof input !== "object" || !input.registry || typeof input.registry.resolveWorkspace !== "function" ||
      typeof input.workspacePath !== "string" || !path.isAbsolute(input.workspacePath) ||
      !Array.isArray(input.evidencePaths)) {
    const invalid = Object.freeze({ state: "unknown" as const, reason: "INCOMPLETE_OBSERVATION" as const,
      unknownRefs: Object.freeze([] as FreshnessUnknownRef[]) });
    observations.set(invalid, { evidencePaths: [], snapshot: null });
    return invalid;
  }

  const paths: string[] = [];
  const failures: FreshnessUnknownRef[] = [];
  const seen = new Set<string>();
  for (const value of input.evidencePaths) {
    try {
      const evidencePath = validateEvidencePath(value);
      if (seen.has(evidencePath)) throw new ObservationFailure("INVALID_EVIDENCE_PATH");
      seen.add(evidencePath);
      paths.push(evidencePath);
    } catch (error) {
      failures.push({ path: typeof value === "string" ? value : "<invalid>", reason: unknownReason(error) });
    }
  }
  if (input.evidencePaths.length === 0 || input.evidencePaths.length > MAX_EVIDENCE_FILES) {
    failures.push({ path: "<evidencePaths>", reason: "INCOMPLETE_OBSERVATION" });
  }
  if (failures.length > 0 || paths.length !== input.evidencePaths.length) {
    const observation = Object.freeze({ state: "unknown" as const,
      reason: failures[0]?.reason ?? "INCOMPLETE_OBSERVATION" as const,
      unknownRefs: Object.freeze(failures.map(ref => Object.freeze(ref))) });
    observations.set(observation, { registry: input.registry, workspacePath: input.workspacePath,
      evidencePaths: Object.freeze(paths), snapshot: null });
    return observation;
  }
  return capture({ ...input, evidencePaths: paths }, Object.freeze(paths));
}

function normalizeSnapshot(value: unknown): FreshnessSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<FreshnessSnapshot>;
  if (typeof item.projectId !== "string" || item.projectId.length === 0 || item.projectId.length > 128 ||
      typeof item.gitHead !== "string" || !GIT_HEAD.test(item.gitHead) || !Array.isArray(item.refs) ||
      item.refs.length === 0 || item.refs.length > MAX_EVIDENCE_FILES || !validSampleTime(item.sampledAt)) return null;
  const refs: FreshnessEvidenceRef[] = [];
  const seen = new Set<string>();
  for (const ref of item.refs) {
    if (typeof ref !== "object" || ref === null) return null;
    let safePath: string;
    try { safePath = validateEvidencePath(ref.path); }
    catch { return null; }
    if (seen.has(safePath) || typeof ref.sourceSha256 !== "string" || !SHA256.test(ref.sourceSha256)) return null;
    seen.add(safePath);
    refs.push({ path: safePath, sourceSha256: ref.sourceSha256.toLowerCase() });
  }
  return Object.freeze({ projectId: item.projectId, gitHead: item.gitHead.toLowerCase(),
    refs: canonicalEvidenceRefs(refs), sampledAt: item.sampledAt });
}

function sameRefs(left: readonly FreshnessEvidenceRef[], right: readonly FreshnessEvidenceRef[], includeHashes: boolean): boolean {
  return left.length === right.length && left.every((ref, index) => {
    const other = right[index];
    return other !== undefined && ref.path === other.path && (!includeHashes || ref.sourceSha256 === other.sourceSha256);
  });
}

function sameEvidence(left: FreshnessSnapshot, right: FreshnessSnapshot): boolean {
  return left.projectId === right.projectId && left.gitHead === right.gitHead && sameRefs(left.refs, right.refs, true);
}

function recapture(binding: ObservationBinding): FreshnessObservation {
  if (!binding.registry || !binding.workspacePath || binding.evidencePaths.length === 0) {
    return { state: "unknown", reason: "UNTRUSTED_OBSERVATION", unknownRefs: [] };
  }
  const current = capture({ registry: binding.registry, workspacePath: binding.workspacePath,
    evidencePaths: binding.evidencePaths }, binding.evidencePaths);
  if (current.state === "observed" && observations.get(current)?.identity !== binding.identity) {
    return { state: "unknown", reason: "INCOMPLETE_OBSERVATION", unknownRefs: [] };
  }
  return current;
}

export function assessFreshness(previous: FreshnessSnapshot | null, current: FreshnessObservation): FreshnessAssessment {
  const binding = typeof current === "object" && current !== null ? observations.get(current) : undefined;
  if (binding === undefined) {
    return { state: "unknown", reasons: ["UNTRUSTED_OBSERVATION"], unknownRefs: [] };
  }
  if (current.state === "unknown") {
    return { state: "unknown", reasons: [current.reason], unknownRefs: current.unknownRefs };
  }
  if (binding.snapshot === null || !sameEvidence(binding.snapshot, current.snapshot)) {
    return { state: "unknown", reasons: ["UNTRUSTED_OBSERVATION"], unknownRefs: [] };
  }

  const before = normalizeSnapshot(previous);
  const after = normalizeSnapshot(current.snapshot);
  if (before === null || after === null) {
    const unknownRefs = after === null ? [] : after.refs.map(ref => ({ path: ref.path, reason: "PRIOR_SNAPSHOT_INCOMPLETE" as const }));
    return { state: "unknown", reasons: ["PRIOR_SNAPSHOT_INCOMPLETE"], unknownRefs };
  }
  if (before.projectId !== after.projectId) {
    return { state: "unknown", reasons: ["PROJECT_MISMATCH"], unknownRefs: [] };
  }
  if (!sameRefs(before.refs, after.refs, false)) {
    const oldPaths = new Set(before.refs.map(ref => ref.path));
    const newPaths = new Set(after.refs.map(ref => ref.path));
    const changedPaths = [...new Set([...oldPaths, ...newPaths])].filter(refPath => !oldPaths.has(refPath) || !newPaths.has(refPath));
    return { state: "unknown", reasons: ["REF_SET_MISMATCH"],
      unknownRefs: changedPaths.sort().map(refPath => ({ path: refPath, reason: "REF_SET_MISMATCH" as const })) };
  }

  const changes: FreshnessChange[] = [];
  if (before.gitHead !== after.gitHead) changes.push({ kind: "git_head_changed", previous: before.gitHead, current: after.gitHead });
  for (let index = 0; index < before.refs.length; index += 1) {
    const oldRef = before.refs[index]!;
    const newRef = after.refs[index]!;
    if (oldRef.sourceSha256 !== newRef.sourceSha256) {
      changes.push({ kind: "evidence_hash_changed", path: oldRef.path,
        previous: oldRef.sourceSha256, current: newRef.sourceSha256 });
    }
  }
  if (changes.length === 0) return { state: "current", changes: [], unknownRefs: [] };
  return { state: "needs_recheck", changes, unknownRefs: [] };
}

export interface RevisionProposal {
  readonly noteId: string;
  readonly baseRevisionId: string;
  readonly baseNoteSha256: string;
  readonly baseHistorySha256: string;
  readonly content: string;
  readonly observation: FreshnessObservation;
  readonly replacementRevisionId?: string;
}

export interface HostAcceptance {
  readonly acceptanceId: string;
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly verifiedOutputSha256: string;
  readonly proposalSha256: string;
  readonly baseRevisionId: string;
  readonly baseNoteSha256: string;
  readonly baseHistorySha256: string;
  readonly projectId: string;
  readonly gitHead: string;
  readonly evidenceRefs: readonly FreshnessEvidenceRef[];
  readonly replacementRevisionId?: string;
}

export type TrustedHostVerifier = (
  proposal: Readonly<RevisionProposal>,
  proposalSha256: string,
) => HostAcceptance | null | Promise<HostAcceptance | null>;

const receiptBrand: unique symbol = Symbol("VerifiedRevisionReceipt");
export interface VerifiedRevisionReceipt {
  readonly [receiptBrand]: true;
}

interface ReceiptBinding {
  readonly proposalSha256: string;
  readonly proposal: Readonly<RevisionProposal>;
  readonly snapshot: FreshnessSnapshot;
  readonly observation: ObservationBinding;
  readonly acceptance: HostAcceptance;
  readonly contentSha256: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function proposalDigest(proposal: Readonly<RevisionProposal>, snapshot: FreshnessSnapshot): string {
  const canonical = {
    noteId: proposal.noteId,
    baseRevisionId: proposal.baseRevisionId,
    baseNoteSha256: proposal.baseNoteSha256.toLowerCase(),
    baseHistorySha256: proposal.baseHistorySha256.toLowerCase(),
    content: proposal.content,
    observation: {
      projectId: snapshot.projectId,
      gitHead: snapshot.gitHead,
      refs: snapshot.refs,
      sampledAt: snapshot.sampledAt,
    },
    replacementRevisionId: proposal.replacementRevisionId ?? null,
  };
  return hashText(JSON.stringify(canonical));
}

function freezeProposal(input: RevisionProposal, snapshot: FreshnessSnapshot): Readonly<RevisionProposal> {
  return Object.freeze({
    noteId: input.noteId,
    baseRevisionId: input.baseRevisionId,
    baseNoteSha256: input.baseNoteSha256.toLowerCase(),
    baseHistorySha256: input.baseHistorySha256.toLowerCase(),
    content: input.content,
    observation: input.observation,
    ...(input.replacementRevisionId === undefined ? {} : { replacementRevisionId: input.replacementRevisionId }),
  });
}

function validAcceptance(value: HostAcceptance, proposal: Readonly<RevisionProposal>, snapshot: FreshnessSnapshot,
  digest: string): boolean {
  if (!value || typeof value !== "object" || typeof value.acceptanceId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.acceptanceId) || !Array.isArray(value.command) ||
      value.command.length === 0 || value.command.some(part => typeof part !== "string" || part.trim().length === 0) ||
      value.exitCode !== 0 || typeof value.verifiedOutputSha256 !== "string" || !SHA256.test(value.verifiedOutputSha256) ||
      value.proposalSha256 !== digest || value.baseRevisionId !== proposal.baseRevisionId ||
      typeof value.baseNoteSha256 !== "string" || value.baseNoteSha256.toLowerCase() !== proposal.baseNoteSha256 ||
      value.projectId !== snapshot.projectId || typeof value.baseHistorySha256 !== "string" ||
      value.baseHistorySha256.toLowerCase() !== proposal.baseHistorySha256 ||
      typeof value.gitHead !== "string" || value.gitHead.toLowerCase() !== snapshot.gitHead || !Array.isArray(value.evidenceRefs) ||
      value.replacementRevisionId !== proposal.replacementRevisionId) return false;
  const returnedRefs = value.evidenceRefs.map(ref => {
    if (!ref || typeof ref.path !== "string" || typeof ref.sourceSha256 !== "string" || !SHA256.test(ref.sourceSha256)) return null;
    return { path: ref.path, sourceSha256: ref.sourceSha256.toLowerCase() };
  });
  if (returnedRefs.some(ref => ref === null)) return false;
  return sameRefs(canonicalEvidenceRefs(returnedRefs as FreshnessEvidenceRef[]), snapshot.refs, true);
}

/** The Host must actually verify the proposal. This module checks its attestation,
 * not command execution or the semantic truth of the cited project evidence. */
export async function authorizeRevisionProposal(
  input: RevisionProposal,
  trustedHostVerifier: TrustedHostVerifier,
): Promise<VerifiedRevisionReceipt> {
  if (!input || typeof input !== "object" || typeof input.noteId !== "string" || input.noteId.length === 0 ||
      typeof input.baseRevisionId !== "string" || input.baseRevisionId.length === 0 ||
      typeof input.baseNoteSha256 !== "string" || !SHA256.test(input.baseNoteSha256) ||
      typeof input.baseHistorySha256 !== "string" || !SHA256.test(input.baseHistorySha256) ||
      typeof input.content !== "string" || Buffer.byteLength(input.content, "utf8") > MAX_EVIDENCE_BYTES ||
      typeof trustedHostVerifier !== "function") {
    throw new FreshnessError("INVALID_PROPOSAL", "Revision proposal is incomplete");
  }
  const observation = input.observation;
  const observedBinding = typeof observation === "object" && observation !== null ? observations.get(observation) : undefined;
  if (!observedBinding || observation.state !== "observed" || observedBinding.snapshot === null ||
      !sameEvidence(observedBinding.snapshot, observation.snapshot)) {
    throw new FreshnessError("INVALID_OBSERVATION", "Revision proposal must use a live observation from this module");
  }
  if (input.replacementRevisionId !== undefined &&
      (typeof input.replacementRevisionId !== "string" || input.replacementRevisionId.length === 0)) {
    throw new FreshnessError("INVALID_PROPOSAL", "Replacement target is invalid");
  }

  const proposal = freezeProposal(input, observedBinding.snapshot);
  const digest = proposalDigest(proposal, observedBinding.snapshot);
  const beforeHost = recapture(observedBinding);
  if (beforeHost.state !== "observed" || !sameEvidence(beforeHost.snapshot, observedBinding.snapshot)) {
    throw new FreshnessError("STALE_OBSERVATION", "Project evidence changed before Host verification started");
  }
  let acceptance: HostAcceptance | null;
  try { acceptance = await trustedHostVerifier(proposal, digest); }
  catch (cause) { throw new FreshnessError("HOST_REJECTED", "Trusted Host did not accept the revision", { cause }); }
  if (acceptance === null) throw new FreshnessError("HOST_REJECTED", "Trusted Host rejected the revision");
  if (!validAcceptance(acceptance, proposal, observedBinding.snapshot, digest)) {
    throw new FreshnessError("INVALID_HOST_ACCEPTANCE", "Host acceptance does not bind the exact proposal and evidence");
  }

  const current = recapture(observedBinding);
  if (current.state !== "observed" || !sameEvidence(current.snapshot, observedBinding.snapshot)) {
    throw new FreshnessError("STALE_OBSERVATION", "Project evidence changed while Host verification was running");
  }

  const frozenAcceptance: HostAcceptance = Object.freeze({
    acceptanceId: acceptance.acceptanceId,
    command: Object.freeze([...acceptance.command]),
    exitCode: acceptance.exitCode,
    verifiedOutputSha256: acceptance.verifiedOutputSha256.toLowerCase(),
    proposalSha256: acceptance.proposalSha256,
    baseRevisionId: acceptance.baseRevisionId,
    baseNoteSha256: acceptance.baseNoteSha256.toLowerCase(),
    baseHistorySha256: acceptance.baseHistorySha256.toLowerCase(),
    projectId: acceptance.projectId,
    gitHead: acceptance.gitHead.toLowerCase(),
    evidenceRefs: canonicalEvidenceRefs(acceptance.evidenceRefs),
    ...(acceptance.replacementRevisionId === undefined ? {} : { replacementRevisionId: acceptance.replacementRevisionId }),
  });
  const receipt = Object.freeze({ [receiptBrand]: true }) as VerifiedRevisionReceipt;
  validReceipts.add(receipt);
  receiptBindings.set(receipt, {
    proposalSha256: digest,
    proposal,
    snapshot: observedBinding.snapshot,
    observation: observedBinding,
    acceptance: frozenAcceptance,
    contentSha256: hashText(proposal.content),
  });
  return receipt;
}

export interface RevisionAcceptanceRecord {
  readonly acceptanceId: string;
  readonly command: readonly string[];
  readonly exitCode: 0;
  readonly verifiedOutputSha256: string;
  readonly proposalSha256: string;
}

export interface NoteRevision {
  readonly revisionId: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly authority: "experience-lead";
  readonly evidence?: FreshnessSnapshot;
  readonly acceptance?: RevisionAcceptanceRecord;
  readonly supersedesRevisionId?: string;
}

export interface RevisionHistory {
  readonly noteId: string;
  readonly revisions: readonly NoteRevision[];
}

function acceptanceIds(history: RevisionHistory): Set<string> {
  const ids = new Set<string>();
  for (const revision of history.revisions) {
    const id = revision && typeof revision === "object" ? revision.acceptance?.acceptanceId : undefined;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

// Persisted history is untrusted JSON. Copy every field, including optional
// metadata, without rewriting it or sharing mutable references with the caller.
function cloneHistoryJson(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new FreshnessError("HISTORY_MISMATCH", "History JSON exceeds its depth bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new FreshnessError("HISTORY_MISMATCH", "History must contain plain JSON values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new FreshnessError("HISTORY_MISMATCH", "History must contain plain JSON records");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) {
      throw new FreshnessError("HISTORY_MISMATCH", "History arrays must be complete JSON arrays");
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = descriptors[String(index)];
      if (!item || !item.enumerable || !("value" in item)) {
        throw new FreshnessError("HISTORY_MISMATCH", "History cannot contain accessor values");
      }
      result.push(cloneHistoryJson(item.value, depth + 1));
    }
    return Object.freeze(result);
  }
  const result = Object.create(prototype) as Record<string, unknown>;
  for (const key of Object.keys(descriptors).sort()) {
    const item = descriptors[key]!;
    if (!item.enumerable || !("value" in item)) {
      throw new FreshnessError("HISTORY_MISMATCH", "History cannot contain accessor values");
    }
    Object.defineProperty(result, key, { enumerable: true, value: cloneHistoryJson(item.value, depth + 1) });
  }
  return Object.freeze(result);
}

function validatedHistory(history: RevisionHistory): RevisionHistory {
  const copied = cloneHistoryJson(history) as RevisionHistory;
  if (!copied || typeof copied.noteId !== "string" || copied.noteId.length === 0 || copied.noteId.length > 128 ||
      !Array.isArray(copied.revisions) || copied.revisions.length === 0 ||
      Buffer.byteLength(JSON.stringify(copied), "utf8") > MAX_EVIDENCE_BYTES) {
    throw new FreshnessError("HISTORY_MISMATCH", "History is incomplete or exceeds its 5 MiB bound");
  }
  const ids = new Set<string>();
  const accepted = new Set<string>();
  for (const item of copied.revisions) {
    if (!item || typeof item !== "object" || typeof item.revisionId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.revisionId) || ids.has(item.revisionId) ||
        typeof item.content !== "string" || typeof item.contentSha256 !== "string" || !SHA256.test(item.contentSha256) ||
        hashText(item.content) !== item.contentSha256.toLowerCase() || item.authority !== "experience-lead" ||
        (item.evidence !== undefined && normalizeSnapshot(item.evidence) === null) ||
        (item.supersedesRevisionId !== undefined && !ids.has(item.supersedesRevisionId))) {
      throw new FreshnessError("HISTORY_MISMATCH", "A prior note revision is invalid");
    }
    if (item.acceptance !== undefined) {
      const acceptance = item.acceptance;
      if (!acceptance || acceptance.acceptanceId !== item.revisionId || accepted.has(acceptance.acceptanceId) ||
          !Array.isArray(acceptance.command) || acceptance.command.length === 0 ||
          acceptance.command.some((part: unknown) => typeof part !== "string" || part.trim().length === 0) ||
          acceptance.exitCode !== 0 || typeof acceptance.proposalSha256 !== "string" || !SHA256.test(acceptance.proposalSha256) ||
          typeof acceptance.verifiedOutputSha256 !== "string" || !SHA256.test(acceptance.verifiedOutputSha256)) {
        throw new FreshnessError("HISTORY_MISMATCH", "A prior verification record is invalid");
      }
      accepted.add(acceptance.acceptanceId);
    }
    ids.add(item.revisionId);
  }
  return copied;
}

/** Exact JSON-prefix binding, including metadata. Persistence needs Host atomic CAS. */
export function revisionHistoryDigest(history: RevisionHistory): string {
  return hashText(JSON.stringify(validatedHistory(history)));
}

export function appendVerifiedRevision(
  history: RevisionHistory,
  proposal: RevisionProposal,
  receipt: VerifiedRevisionReceipt,
): RevisionHistory {
  if (typeof receipt !== "object" || receipt === null || !validReceipts.has(receipt) ||
      consumedReceipts.has(receipt) || !receiptBindings.has(receipt)) {
    throw new FreshnessError("INVALID_RECEIPT", "A fresh module-issued receipt is required");
  }
  const binding = receiptBindings.get(receipt)!;
  const currentObservation = recapture(binding.observation);
  if (currentObservation.state !== "observed" || !sameEvidence(currentObservation.snapshot, binding.snapshot)) {
    throw new FreshnessError("STALE_OBSERVATION", "Project evidence changed after Host verification");
  }
  const proposalBinding = typeof proposal === "object" && proposal !== null && proposal.observation
    ? observations.get(proposal.observation)
    : undefined;
  let suppliedDigest: string | undefined;
  try {
    if (proposalBinding?.snapshot) suppliedDigest = proposalDigest(freezeProposal(proposal, proposalBinding.snapshot), proposalBinding.snapshot);
  } catch {
    throw new FreshnessError("INVALID_RECEIPT", "The supplied proposal is incomplete");
  }
  if (proposalBinding?.snapshot === null || proposalBinding?.snapshot === undefined ||
      proposalBinding !== binding.observation || suppliedDigest !== binding.proposalSha256) {
    throw new FreshnessError("INVALID_RECEIPT", "Receipt is bound to a different proposal or observation");
  }
  if (!history || typeof history.noteId !== "string" || !Array.isArray(history.revisions) || history.revisions.length === 0 ||
      history.noteId !== binding.proposal.noteId || proposal.noteId !== binding.proposal.noteId) {
    throw new FreshnessError("HISTORY_MISMATCH", "History does not match the receipt-bound proposal");
  }

  const copiedHistory = validatedHistory(history);
  if (hashText(JSON.stringify(copiedHistory)) !== binding.proposal.baseHistorySha256) {
    throw new FreshnessError("HISTORY_MISMATCH", "The complete history prefix differs from the accepted proposal");
  }
  const latest = copiedHistory.revisions[copiedHistory.revisions.length - 1]!;
  if (!latest || typeof latest.revisionId !== "string" || typeof latest.content !== "string" ||
      typeof latest.contentSha256 !== "string" || !SHA256.test(latest.contentSha256) ||
      hashText(latest.content) !== latest.contentSha256.toLowerCase() ||
      latest.revisionId !== binding.proposal.baseRevisionId || latest.revisionId !== proposal.baseRevisionId ||
      latest.contentSha256.toLowerCase() !== binding.proposal.baseNoteSha256 ||
      latest.contentSha256.toLowerCase() !== proposal.baseNoteSha256.toLowerCase()) {
    throw new FreshnessError("HISTORY_MISMATCH", "The latest note revision changed during Host verification");
  }
  if (acceptanceIds(history).has(binding.acceptance.acceptanceId)) {
    throw new FreshnessError("DUPLICATE_ACCEPTANCE", "Acceptance ID already appears in this history");
  }
  const replacement = binding.proposal.replacementRevisionId;
  if (replacement !== undefined && (replacement !== latest.revisionId || replacement !== binding.acceptance.replacementRevisionId)) {
    throw new FreshnessError("HISTORY_MISMATCH", "Accepted replacement must target the latest exact revision");
  }
  if (replacement === undefined && binding.acceptance.replacementRevisionId !== undefined) {
    throw new FreshnessError("INVALID_RECEIPT", "Receipt includes an unproposed replacement");
  }

  const newRevision: NoteRevision = Object.freeze({
    revisionId: binding.acceptance.acceptanceId,
    content: binding.proposal.content,
    contentSha256: binding.contentSha256,
    authority: "experience-lead",
    evidence: binding.snapshot,
    acceptance: Object.freeze({
      acceptanceId: binding.acceptance.acceptanceId,
      command: binding.acceptance.command,
      exitCode: 0,
      verifiedOutputSha256: binding.acceptance.verifiedOutputSha256,
      proposalSha256: binding.acceptance.proposalSha256,
    }),
    ...(replacement === undefined ? {} : { supersedesRevisionId: replacement }),
  });
  const revised = Object.freeze({ ...copiedHistory,
    revisions: Object.freeze([...copiedHistory.revisions, newRevision]) });
  validatedHistory(revised); // Fail before consuming the receipt if the result is invalid.
  consumedReceipts.add(receipt);
  return revised;
}
