import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type BigIntStats,
  type Dir,
} from "node:fs";
import path from "node:path";
import {
  isTrustedProjectMapping,
  ProjectRegistryError,
  type ProjectMapping,
  type ProjectRegistry,
  type ProjectRegistryErrorCode,
} from "./registry.js";

export const PROJECT_MEMORY_EXPORT_SCHEMA = "xiadie-project-memory-export/v1" as const;
export const PROJECT_MAPPING_SNAPSHOT_SCHEMA = "xiadie-project-mapping-snapshot/v1" as const;
export const MAX_PROJECT_MEMORY_FILES = 1024;
export const MAX_PROJECT_MEMORY_DIRECTORIES = 4096;
export const MAX_PROJECT_MEMORY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PROJECT_MEMORY_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_MEMORY_DEPTH = 16;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NATIVE_KEY = /^[a-z0-9._-]{1,48}-[a-f0-9]{16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const injectedFaultErrors = new WeakSet<object>();

export interface ProjectMemoryFileRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ProjectMemoryManifest {
  readonly schema: typeof PROJECT_MEMORY_EXPORT_SCHEMA;
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly memoryState: "present" | "absent";
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly mappingSha256: string;
  readonly directories: readonly string[];
  readonly files: readonly ProjectMemoryFileRecord[];
}

export interface ProjectMemoryConflict {
  readonly path: string;
  readonly reason: string;
  readonly expectedSha256?: string;
  readonly currentSha256?: string;
}

export interface ProjectMemoryFaults {
  /** Runs after each real file copy has been written and verified through its open descriptor. */
  readonly afterFileCopy?: (event: { readonly copiedFiles: number; readonly relativePath: string }) => unknown;
  /** Runs after bytes and mapping have been copied, before source revalidation. */
  readonly afterCopy?: () => unknown;
  /** Runs after source and target trees have been revalidated, before metadata changes. */
  readonly afterVerify?: () => unknown;
  /** Runs in the registry's second verifyTarget call, after its metadata UPDATE. */
  readonly afterMetadataWrite?: () => unknown;
}

export interface ExportMemoryAuthorization {
  readonly projectId: string;
  readonly action: "export";
  readonly confirmed: true;
}

export interface ExportProjectMemoryInput {
  readonly registry: ProjectRegistry;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly destination: string;
  readonly authorization: ExportMemoryAuthorization;
  readonly faults?: ProjectMemoryFaults;
}

export type ExportProjectMemoryResult =
  | {
      readonly status: "exported";
      readonly bundleRoot: string;
      readonly projectId: string;
      readonly sourceRevision: number;
      readonly mappingSha256: string;
      readonly manifestSha256: string;
      readonly manifest: ProjectMemoryManifest;
    }
  | {
      readonly status: "conflict";
      readonly bundleRoot: string;
      readonly conflicts: readonly ProjectMemoryConflict[];
    };

export interface ReadProjectMemoryExportResult {
  readonly status: "valid";
  readonly bundleRoot: string;
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly manifestSha256: string;
  /** Source paths and physical identities in this snapshot are provenance only. */
  readonly mappingSnapshot: ProjectMapping;
  readonly manifest: ProjectMemoryManifest;
}

export interface CapturedMemoryFile extends ProjectMemoryFileRecord {
  readonly bytes: Buffer;
}

export interface CapturedMemoryTree {
  readonly state: "present" | "absent";
  readonly files: readonly CapturedMemoryFile[];
  /** Relative directory paths, excluding the memory root itself. */
  readonly directories: readonly string[];
  readonly totalBytes: number;
  readonly rootIdentity: string | null;
  readonly directoryIdentities: Readonly<Record<string, string>>;
}

/** Registry operations added for the U06, schema-2 metadata migration. */
export function exportProjectMemory(input: ExportProjectMemoryInput): ExportProjectMemoryResult {
  assertAuthorization(input.authorization, input.projectId, "export");
  const mapping = requireCurrentMapping(input.registry, input.projectId, input.expectedRevision);
  const snapshot = mappingSnapshot(mapping);
  const mappingBytes = jsonBytes({ schema: PROJECT_MAPPING_SNAPSHOT_SCHEMA, mapping: snapshot });
  if (mappingBytes.byteLength > MAX_METADATA_BYTES) fail("UNSAFE_PATH", "Mapping snapshot exceeds the metadata byte limit");
  const mappingSha256 = sha256(mappingBytes);
  const source = captureNativeMemoryTree(mapping);
  const manifest = makeManifest(mapping, source, mappingSha256);
  const manifestBytes = jsonBytes(manifest);
  if (manifestBytes.byteLength > MAX_METADATA_BYTES) fail("UNSAFE_PATH", "Export manifest exceeds the metadata byte limit");
  const bundleRoot = absolutePath(input.destination, "Export destination");
  const parent = path.dirname(bundleRoot);
  assertPhysicalDirectoryChain(parent);

  if (entryExists(bundleRoot)) {
    return conflictResult(bundleRoot, compareExistingBundle(bundleRoot, manifestBytes, mappingBytes, source));
  }

  const bundleParentIdentity = directoryIdentity(parent);
  try {
    mkdirSync(bundleRoot);
  } catch (error) {
    if (isExists(error)) {
      return conflictResult(bundleRoot, compareExistingBundle(bundleRoot, manifestBytes, mappingBytes, source));
    }
    throw error;
  }
  const bundleIdentity = requireDirectoryIdentity(bundleRoot, parent, bundleParentIdentity);

  writeExclusive(path.join(bundleRoot, "mapping.json"), mappingBytes, bundleRoot, bundleIdentity);
  if (source.state === "present") {
    copyCapturedTree(source, path.join(bundleRoot, "memory"), bundleRoot, bundleIdentity,
      event => runSynchronousCopyFault(input.faults?.afterFileCopy, event));
  }
  runSynchronousFault(input.faults?.afterCopy);

  assertFreshMapping(input.registry, mapping, input.expectedRevision);
  const afterSource = captureNativeMemoryTree(mapping);
  assertSameCapturedTree(source, afterSource, "Project memory changed while it was exported");
  if (source.state === "present") {
    const copied = captureMemoryTree(path.join(bundleRoot, "memory"));
    assertSameTreeContents(source, copied, "Export copy differs from the captured source tree");
  } else if (entryExists(path.join(bundleRoot, "memory"))) {
    fail("MEMORY_CONFLICT", "An absent source must not create an exported memory root");
  }
  runSynchronousFault(input.faults?.afterVerify);

  // The manifest is the completion marker. A failed export leaves an inactive,
  // reviewable directory without a manifest and is never recursively removed.
  writeExclusive(path.join(bundleRoot, "manifest.json"), manifestBytes, bundleRoot, bundleIdentity);
  assertFreshMapping(input.registry, mapping, input.expectedRevision);
  const validated = readProjectMemoryExport(bundleRoot);
  assertSameCapturedTree(source, captureNativeMemoryTree(mapping), "Project memory changed before export completed");
  return Object.freeze({
    status: "exported",
    bundleRoot,
    projectId: mapping.projectId,
    sourceRevision: mapping.revision,
    mappingSha256,
    manifestSha256: validated.manifestSha256,
    manifest: validated.manifest,
  });
}

export function readProjectMemoryExport(bundleRootInput: string): ReadProjectMemoryExportResult {
  const bundleRoot = absolutePath(bundleRootInput, "Export bundle root");
  assertPhysicalDirectoryChain(bundleRoot);
  const rootStat = lstatSync(bundleRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("UNSAFE_PATH", "Export bundle root must be a physical directory");
  const rootIdentity = fileIdentity(rootStat);

  const topNames = readDirectoryNames(bundleRoot);
  for (const name of topNames) {
    if (name !== "manifest.json" && name !== "mapping.json" && name !== "memory") {
      fail("MEMORY_CONFLICT", `Unexpected export bundle entry: ${name}`);
    }
  }
  if (!topNames.includes("manifest.json") || !topNames.includes("mapping.json")) {
    fail("MEMORY_CONFLICT", "Export bundle is missing its manifest or mapping snapshot");
  }

  const manifestBytes = readStableFile(bundleRoot, "manifest.json", MAX_METADATA_BYTES).bytes;
  const mappingBytes = readStableFile(bundleRoot, "mapping.json", MAX_METADATA_BYTES).bytes;
  const manifestValue = parseCanonicalJson(manifestBytes, "manifest");
  const mappingValue = parseCanonicalJson(mappingBytes, "mapping snapshot");
  const manifest = validateManifest(manifestValue);
  const snapshot = validateMappingSnapshot(mappingValue);
  if (manifest.projectId !== snapshot.projectId || manifest.sourceRevision !== snapshot.revision ||
      manifest.mappingSha256 !== sha256(mappingBytes)) {
    fail("MEMORY_CONFLICT", "Manifest does not match its mapping snapshot");
  }

  const memoryPath = path.join(bundleRoot, "memory");
  let actualMemoryTree: CapturedMemoryTree | undefined;
  if (manifest.memoryState === "present") {
    if (!topNames.includes("memory")) fail("MEMORY_CONFLICT", "Present memory tree is missing from the export bundle");
    actualMemoryTree = captureMemoryTree(memoryPath);
    const expected = capturedTreeFromManifest(manifest, actualMemoryTree);
    assertSameTreeContents(expected, actualMemoryTree, "Export memory inventory or raw bytes do not match the manifest");
  } else {
    if (topNames.includes("memory")) fail("MEMORY_CONFLICT", "Absent memory must not have an exported memory directory");
    if (manifest.files.length !== 0 || manifest.directories.length !== 0 || manifest.totalBytes !== 0) {
      fail("MEMORY_CONFLICT", "Absent memory manifest must contain an empty inventory");
    }
  }

  if (actualMemoryTree !== undefined) {
    const afterMemoryTree = captureMemoryTree(memoryPath);
    assertSameCapturedTree(actualMemoryTree, afterMemoryTree, "Export memory changed while it was validated");
  }
  const afterNames = readDirectoryNames(bundleRoot);
  const afterRootStat = lstatSync(bundleRoot, { bigint: true });
  if (fileIdentity(afterRootStat) !== rootIdentity || !sameStringArray(topNames, afterNames)) {
    fail("IDENTITY_CONFLICT", "Export bundle changed while it was validated");
  }
  if (!readStableFile(bundleRoot, "manifest.json", MAX_METADATA_BYTES).bytes.equals(manifestBytes) ||
      !readStableFile(bundleRoot, "mapping.json", MAX_METADATA_BYTES).bytes.equals(mappingBytes)) {
    fail("IDENTITY_CONFLICT", "Export metadata changed while it was validated");
  }
  const manifestSha256 = sha256(manifestBytes);
  return Object.freeze({
    status: "valid",
    bundleRoot,
    projectId: manifest.projectId,
    sourceRevision: manifest.sourceRevision,
    manifestSha256,
    mappingSnapshot: snapshot,
    manifest,
  });
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function requireCurrentMapping(registry: ProjectRegistry, projectId: string, expectedRevision: number): ProjectMapping {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail("INVALID_INPUT", "Expected a positive registry revision");
  const mapping = registry.get(projectId);
  if (mapping === undefined) fail("NOT_REGISTERED", "Project mapping does not exist");
  if (!isTrustedProjectMapping(mapping)) fail("INVALID_INPUT", "Project registry returned an untrusted mapping");
  if (mapping.projectId !== projectId) fail("IDENTITY_CONFLICT", "Project registry returned another project's mapping");
  if (mapping.revision !== expectedRevision) fail("STALE_REVISION", "Project mapping changed; obtain fresh ownership confirmation");
  return mapping;
}

export function assertFreshMapping(registry: ProjectRegistry, original: ProjectMapping, expectedRevision: number): void {
  const current = requireCurrentMapping(registry, original.projectId, expectedRevision);
  if (sha256(jsonBytes(mappingSnapshot(current))) !== sha256(jsonBytes(mappingSnapshot(original)))) {
    fail("STALE_REVISION", "Project mapping changed during the memory operation");
  }
}

export function mappingSnapshot(mapping: ProjectMapping): ProjectMapping {
  return deepFreeze(canonicalValue(mapping)) as ProjectMapping;
}

export function captureNativeMemoryTree(mapping: ProjectMapping): CapturedMemoryTree {
  const expectedRoot = nativeMemoryPath(mapping.native.storageRoot, mapping.native.key);
  if (!samePath(expectedRoot, mapping.native.memoryRoot)) fail("UNSAFE_PATH", "Mapping Native memory root is not canonical");
  return captureMemoryTree(mapping.native.memoryRoot, mapping.native.storageRoot);
}

export function captureMemoryTree(rootInput: string, boundaryRoot?: string): CapturedMemoryTree {
  const root = absolutePath(rootInput, "Memory root");
  let absent = false;
  let boundaryIdentity: string | null = null;
  if (boundaryRoot === undefined) {
    assertPhysicalDirectoryChain(path.dirname(root));
  } else {
    const boundary = absolutePath(boundaryRoot, "Memory boundary");
    assertPhysicalDirectoryChain(boundary);
    boundaryIdentity = directoryIdentity(boundary);
    if (!isWithinPath(boundary, root)) fail("UNSAFE_PATH", "Memory root escapes its trusted storage boundary");
    let current = boundary;
    const relative = path.relative(boundary, root);
    for (const component of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let stat;
      try { stat = lstatSync(current, { bigint: true }); }
      catch (error) {
        if (isMissing(error)) { absent = true; break; }
        throw asRegistryError(error, "UNSAFE_PATH", "Memory path cannot be inspected");
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== root)) {
        fail("UNSAFE_PATH", "Memory path contains a link or non-directory parent");
      }
      if (stat.isDirectory()) assertPhysicalDirectory(current, boundary);
      else if (current === root) absent = false;
    }
  }

  if (absent || !entryExists(root)) {
    if (entryExists(root)) fail("IDENTITY_CONFLICT", "Memory root appeared while absence was being checked");
    if (boundaryRoot !== undefined && directoryIdentity(absolutePath(boundaryRoot, "Memory boundary")) !== boundaryIdentity) {
      fail("IDENTITY_CONFLICT", "Memory storage boundary changed while absence was checked");
    }
    return emptyCapturedTree("absent");
  }
  assertPhysicalDirectory(root, boundaryRoot);
  const rootStat = lstatSync(root, { bigint: true });
  const files: CapturedMemoryFile[] = [];
  const directories: string[] = [];
  const directoryIdentities = Object.create(null) as Record<string, string>;
  directoryIdentities[""] = fileIdentity(rootStat);
  let totalBytes = 0;

  const visit = (directory: string, relativeDirectory: string, directoryDepth: number): void => {
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || fileIdentity(before) !== directoryIdentities[relativeDirectory]) {
      fail("IDENTITY_CONFLICT", "Memory directory changed while it was enumerated");
    }
    const names = readDirectoryNames(directory);
    for (const name of names) {
      validatePathComponent(name);
      const relative = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      const absolute = path.join(directory, name);
      const child = lstatSync(absolute, { bigint: true });
      if (child.isSymbolicLink()) fail("UNSAFE_PATH", `Memory tree contains a symlink or junction: ${relative}`);
      if (child.isDirectory()) {
        const childDepth = directoryDepth + 1;
        if (childDepth > MAX_PROJECT_MEMORY_DEPTH) fail("UNSAFE_PATH", `Memory tree exceeds depth ${MAX_PROJECT_MEMORY_DEPTH}`);
        assertPhysicalDirectory(absolute, root);
        const identity = fileIdentity(child);
        if (directories.length >= MAX_PROJECT_MEMORY_DIRECTORIES) {
          fail("UNSAFE_PATH", `Memory tree exceeds ${MAX_PROJECT_MEMORY_DIRECTORIES} directories`);
        }
        directories.push(relative);
        directoryIdentities[relative] = identity;
        visit(absolute, relative, childDepth);
        const after = lstatSync(absolute, { bigint: true });
        if (!after.isDirectory() || after.isSymbolicLink() || fileIdentity(after) !== identity) {
          fail("IDENTITY_CONFLICT", `Memory directory changed while it was read: ${relative}`);
        }
      } else if (child.isFile()) {
        if (directoryDepth > MAX_PROJECT_MEMORY_DEPTH) fail("UNSAFE_PATH", `Memory file exceeds depth ${MAX_PROJECT_MEMORY_DEPTH}: ${relative}`);
        if (child.nlink !== 1n) fail("UNSAFE_PATH", `Memory file must have exactly one link: ${relative}`);
        if (files.length >= MAX_PROJECT_MEMORY_FILES) fail("UNSAFE_PATH", `Memory tree exceeds ${MAX_PROJECT_MEMORY_FILES} files`);
        const observed = readStableFile(root, relative, MAX_PROJECT_MEMORY_FILE_BYTES);
        totalBytes += observed.bytes.byteLength;
        if (totalBytes > MAX_PROJECT_MEMORY_TOTAL_BYTES) fail("UNSAFE_PATH", `Memory tree exceeds ${MAX_PROJECT_MEMORY_TOTAL_BYTES} bytes`);
        files.push(Object.freeze({ path: relative, size: observed.bytes.byteLength,
          sha256: sha256(observed.bytes), bytes: observed.bytes }));
      } else {
        fail("UNSAFE_PATH", `Memory tree contains an unsupported filesystem entry: ${relative}`);
      }
    }
    const after = lstatSync(directory, { bigint: true });
    const afterNames = readDirectoryNames(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || fileIdentity(after) !== fileIdentity(before) ||
        !sameStringArray(names, afterNames)) {
      fail("IDENTITY_CONFLICT", `Memory directory changed while it was enumerated: ${relativeDirectory || "."}`);
    }
  };

  visit(root, "", 0);
  if (boundaryRoot !== undefined && directoryIdentity(absolutePath(boundaryRoot, "Memory boundary")) !== boundaryIdentity) {
    fail("IDENTITY_CONFLICT", "Memory storage boundary changed while it was captured");
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  directories.sort(compareUtf8);
  return Object.freeze({ state: "present", files: Object.freeze(files), directories: Object.freeze(directories),
    totalBytes, rootIdentity: fileIdentity(rootStat), directoryIdentities: Object.freeze(directoryIdentities) });
}

export function copyCapturedTree(source: CapturedMemoryTree, destinationRoot: string, boundaryRoot: string,
  boundaryIdentity?: string, onFileCopied?: (event: { readonly copiedFiles: number; readonly relativePath: string }) => unknown): void {
  source = validateCapturedTree(source);
  const destination = absolutePath(destinationRoot, "Memory copy destination");
  const boundary = absolutePath(boundaryRoot, "Memory copy boundary");
  assertPhysicalDirectoryChain(boundary);
  if (!isWithinPath(boundary, destination)) fail("UNSAFE_PATH", "Memory copy destination escapes its trusted boundary");
  if (boundaryIdentity !== undefined && directoryIdentity(boundary) !== boundaryIdentity) {
    fail("IDENTITY_CONFLICT", "Memory copy boundary changed before it was written");
  }
  if (entryExists(destination)) fail("MEMORY_CONFLICT", "Memory copy target already exists");
  if (source.state === "absent") return;

  const relativeRoot = path.relative(boundary, destination);
  const components = relativeRoot.split(path.sep).filter(Boolean);
  let current = boundary;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    ensurePhysicalChildDirectory(current, boundary);
  }
  try { mkdirSync(destination); }
  catch (error) {
    if (isExists(error)) fail("MEMORY_CONFLICT", "Memory copy target was created concurrently");
    throw error;
  }
  assertPhysicalDirectory(destination, boundary);
  const targetRootIdentity = directoryIdentity(destination);
  for (const relativeInput of source.directories) {
    const relative = validateRelativePath(relativeInput);
    if (relative.split("/").length > MAX_PROJECT_MEMORY_DEPTH) {
      fail("UNSAFE_PATH", "Memory copy directory exceeds its depth limit");
    }
    const directory = path.join(destination, ...relative.split("/"));
    try { mkdirSync(directory); }
    catch (error) {
      if (isExists(error)) fail("MEMORY_CONFLICT", `Memory copy directory was created concurrently: ${relative}`);
      throw error;
    }
    assertPhysicalDirectory(directory, destination);
  }
  let copiedFiles = 0;
  let copiedBytes = 0;
  for (const file of source.files) {
    const relative = validateRelativePath(file.path);
    if (relative.split("/").length > MAX_PROJECT_MEMORY_DEPTH + 1 ||
        file.size > MAX_PROJECT_MEMORY_FILE_BYTES || file.bytes.byteLength !== file.size || sha256(file.bytes) !== file.sha256) {
      fail("UNSAFE_PATH", "Memory copy file failed its pre-write inventory checks");
    }
    copiedBytes += file.size;
    if (copiedBytes > MAX_PROJECT_MEMORY_TOTAL_BYTES || copiedFiles >= MAX_PROJECT_MEMORY_FILES) {
      fail("UNSAFE_PATH", "Memory copy exceeds its file or byte limit");
    }
    const target = path.join(destination, ...relative.split("/"));
    writeExclusive(target, file.bytes, destination, targetRootIdentity);
    copiedFiles++;
    assertSynchronousResult(onFileCopied?.(Object.freeze({ copiedFiles, relativePath: relative })));
  }
  if ((boundaryIdentity !== undefined && directoryIdentity(boundary) !== boundaryIdentity) ||
      directoryIdentity(destination) !== targetRootIdentity) {
    fail("IDENTITY_CONFLICT", "Memory copy target or boundary changed while it was written");
  }
}

export function writeExclusive(filename: string, bytes: Buffer, boundaryRoot: string, boundaryIdentity?: string): void {
  const target = absolutePath(filename, "File destination");
  const boundary = absolutePath(boundaryRoot, "File boundary");
  if (!isWithinPath(boundary, target)) fail("UNSAFE_PATH", "File destination escapes its owned boundary");
  const parent = path.dirname(target);
  assertPhysicalDirectory(parent, boundary);
  if (boundaryIdentity !== undefined && directoryIdentity(boundary) !== boundaryIdentity) {
    fail("IDENTITY_CONFLICT", "File destination boundary changed before write");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  } catch (error) {
    if (isExists(error)) fail("MEMORY_CONFLICT", `File destination already exists: ${path.relative(boundary, target)}`);
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) fail("UNSAFE_PATH", "New destination is not a singly-linked regular file");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (written <= 0) fail("IDENTITY_CONFLICT", "File write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(target, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || after.size !== BigInt(bytes.byteLength) ||
        fileIdentity(opened) !== fileIdentity(after) || fileIdentity(after) !== fileIdentity(pathAfter) ||
        pathAfter.isSymbolicLink()) fail("IDENTITY_CONFLICT", "File destination changed while it was written");
  } finally {
    closeSync(descriptor);
  }
  if (boundaryIdentity !== undefined && directoryIdentity(boundary) !== boundaryIdentity) {
    fail("IDENTITY_CONFLICT", "File destination boundary changed during write");
  }
  assertPhysicalDirectory(parent, boundary);
}

export function assertPhysicalDirectoryChain(directoryInput: string): string {
  const directory = absolutePath(directoryInput, "Physical directory");
  const parsed = path.parse(directory);
  let current = parsed.root;
  assertPhysicalDirectory(current);
  const components = path.relative(parsed.root, directory).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    assertPhysicalDirectory(current);
  }
  return directory;
}

export function assertPhysicalDirectory(directoryInput: string, boundaryRoot?: string): string {
  const directory = absolutePath(directoryInput, "Physical directory");
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Path must be a physical directory");
  const real = realpathSync.native(directory);
  if (!samePath(directory, real) || (boundaryRoot !== undefined && !isWithinPath(boundaryRoot, real))) {
    fail("UNSAFE_PATH", "Directory path is aliased or outside its physical boundary");
  }
  return real;
}

export function directoryIdentity(directory: string): string {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Expected an existing physical directory");
  return fileIdentity(stat);
}

export function runSynchronousFault(callback: (() => unknown) | undefined): void {
  if (callback === undefined) return;
  try { assertSynchronousResult(callback()); }
  catch (error) {
    markInjectedFault(error);
    throw error;
  }
}

export function runSynchronousCopyFault(callback: ProjectMemoryFaults["afterFileCopy"],
  event: { readonly copiedFiles: number; readonly relativePath: string }): void {
  if (callback === undefined) return;
  try { assertSynchronousResult(callback(event)); }
  catch (error) {
    markInjectedFault(error);
    throw error;
  }
}

export function isInjectedFault(error: unknown): boolean {
  return typeof error === "object" && error !== null && injectedFaultErrors.has(error);
}

export function ensurePhysicalChildDirectory(directory: string, boundaryRoot: string): void {
  const target = absolutePath(directory, "Directory destination");
  const boundary = absolutePath(boundaryRoot, "Directory boundary");
  if (!isWithinPath(boundary, target) || samePath(boundary, target)) fail("UNSAFE_PATH", "Directory destination escapes its boundary");
  assertPhysicalDirectoryChain(path.dirname(target));
  if (entryExists(target)) {
    assertPhysicalDirectory(target, boundary);
    return;
  }
  try { mkdirSync(target); }
  catch (error) {
    if (!isExists(error)) throw error;
  }
  assertPhysicalDirectory(target, boundary);
}

function requireDirectoryIdentity(directory: string, boundaryRoot: string, boundaryIdentity: string): string {
  const boundary = absolutePath(boundaryRoot, "Directory boundary");
  assertPhysicalDirectoryChain(boundary);
  const target = absolutePath(directory, "Directory target");
  assertPhysicalDirectory(target, boundary);
  const identity = directoryIdentity(target);
  if (directoryIdentity(boundary) !== boundaryIdentity) {
    fail("IDENTITY_CONFLICT", "Directory boundary changed while its child was created");
  }
  return identity;
}

export function nativeMemoryPath(storageRoot: string, nativeKey: string): string {
  if (!NATIVE_KEY.test(nativeKey)) fail("UNSAFE_PATH", "Native memory key is malformed");
  return path.join(absolutePath(storageRoot, "Native storage root"), "memories", "projects", nativeKey, "memory");
}

function provenanceNativeMemoryPath(storageRoot: string, nativeKey: string): string {
  const pathApi = path.win32.isAbsolute(storageRoot) ? path.win32 : path.posix;
  return pathApi.join(storageRoot, "memories", "projects", nativeKey, "memory");
}

function isAbsoluteProvenancePath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") &&
    (path.win32.isAbsolute(value) || path.posix.isAbsolute(value));
}

function sameProvenancePath(left: string, right: string): boolean {
  const windowsPath = path.win32.isAbsolute(left) || path.win32.isAbsolute(right);
  if (windowsPath) return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  return path.posix.normalize(left) === path.posix.normalize(right);
}

export function assertAuthorization(value: unknown, projectId: string, action: string,
  manifestSha256?: string): void {
  if (typeof value !== "object" || value === null) fail("AUTHORIZATION_REQUIRED", "Explicit project ownership confirmation is required");
  const authorization = value as Record<string, unknown>;
  if (authorization.projectId !== projectId || authorization.action !== action || authorization.confirmed !== true ||
      (manifestSha256 !== undefined && authorization.manifestSha256 !== manifestSha256)) {
    fail("AUTHORIZATION_REQUIRED", "Confirmation must name this project and the exact operation and export manifest");
  }
}

export function assertSameCapturedTree(expected: CapturedMemoryTree, actual: CapturedMemoryTree, message: string): void {
  assertSameTreeContents(expected, actual, message);
  if (expected.rootIdentity !== actual.rootIdentity || !sameRecord(expected.directoryIdentities, actual.directoryIdentities)) {
    fail("IDENTITY_CONFLICT", message);
  }
}

export function assertSameTreeContents(expected: CapturedMemoryTree, actual: CapturedMemoryTree, message: string): void {
  if (expected.state !== actual.state || expected.totalBytes !== actual.totalBytes ||
      !sameStringArray(expected.directories, actual.directories) || expected.files.length !== actual.files.length) {
    fail("IDENTITY_CONFLICT", message);
  }
  for (let index = 0; index < expected.files.length; index++) {
    const left = expected.files[index]!;
    const right = actual.files[index]!;
    if (left.path !== right.path || left.size !== right.size || left.sha256 !== right.sha256 ||
        !left.bytes.equals(right.bytes)) fail("IDENTITY_CONFLICT", message);
  }
}

export function validateManifest(value: unknown): ProjectMemoryManifest {
  if (!isRecord(value) || !exactKeys(value, ["schema", "projectId", "sourceRevision", "memoryState", "fileCount", "totalBytes", "mappingSha256", "directories", "files"]) ||
      value.schema !== PROJECT_MEMORY_EXPORT_SCHEMA || !isUuid(value.projectId) ||
      !Number.isSafeInteger(value.sourceRevision) || (value.sourceRevision as number) < 1 ||
      (value.memoryState !== "present" && value.memoryState !== "absent") ||
      !Number.isSafeInteger(value.fileCount) || (value.fileCount as number) < 0 ||
      !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 0 ||
      !isSha256(value.mappingSha256) || !Array.isArray(value.directories) || !Array.isArray(value.files)) {
    fail("MEMORY_CONFLICT", "Export manifest has an unsupported or malformed schema");
  }
  if (value.files.length > MAX_PROJECT_MEMORY_FILES || value.fileCount !== value.files.length ||
      value.totalBytes > MAX_PROJECT_MEMORY_TOTAL_BYTES) fail("MEMORY_CONFLICT", "Export manifest exceeds supported limits");
  const seen = new Set<string>();
  const files: ProjectMemoryFileRecord[] = [];
  let totalBytes = 0;
  for (const raw of value.files) {
    if (!isRecord(raw) || !exactKeys(raw, ["path", "size", "sha256"]) || typeof raw.path !== "string" || !Number.isSafeInteger(raw.size) ||
        (raw.size as number) < 0 || (raw.size as number) > MAX_PROJECT_MEMORY_FILE_BYTES || !isSha256(raw.sha256)) {
      fail("MEMORY_CONFLICT", "Export manifest contains an invalid file record");
    }
    const filePath = validateRelativePath(raw.path);
    if (seen.has(aliasKey(filePath))) fail("UNSAFE_PATH", "Export manifest contains aliased file paths");
    seen.add(aliasKey(filePath));
    totalBytes += raw.size as number;
    files.push(Object.freeze({ path: filePath, size: raw.size as number, sha256: raw.sha256 }));
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const directories: string[] = [];
  const directoryKeys = new Set<string>();
  if (value.directories.length > MAX_PROJECT_MEMORY_DIRECTORIES) fail("MEMORY_CONFLICT", "Export manifest has too many directories");
  for (const raw of value.directories) {
    if (typeof raw !== "string") fail("MEMORY_CONFLICT", "Export manifest contains an invalid directory record");
    const directory = validateRelativePath(raw);
    if (directory.split("/").length > MAX_PROJECT_MEMORY_DEPTH || directoryKeys.has(aliasKey(directory))) {
      fail("UNSAFE_PATH", "Export manifest contains aliased or over-depth directories");
    }
    directoryKeys.add(aliasKey(directory));
    directories.push(directory);
  }
  directories.sort(compareUtf8);
  if (!sameStringArray(value.directories, directories)) fail("MEMORY_CONFLICT", "Export directories are not in canonical path order");
  if (totalBytes !== value.totalBytes || (value.memoryState === "absent" &&
      (files.length !== 0 || directories.length !== 0 || totalBytes !== 0))) {
    fail("MEMORY_CONFLICT", "Manifest totals or absent-memory inventory are inconsistent");
  }
  const fileKeys = new Set(files.map(file => aliasKey(file.path)));
  for (const file of files) {
    const components = file.path.split("/");
    if (components.length > MAX_PROJECT_MEMORY_DEPTH + 1) fail("UNSAFE_PATH", "Export manifest contains an over-depth file");
    for (let index = 1; index < components.length; index++) {
      const parentKey = aliasKey(components.slice(0, index).join("/"));
      if (fileKeys.has(parentKey)) fail("UNSAFE_PATH", "Export manifest uses a file as a parent directory");
      if (!directoryKeys.has(parentKey)) fail("MEMORY_CONFLICT", "Export manifest omits a file parent directory");
    }
  }
  for (const directory of directories) {
    const components = directory.split("/");
    for (let index = 1; index < components.length; index++) {
      if (!directoryKeys.has(aliasKey(components.slice(0, index).join("/")))) {
        fail("MEMORY_CONFLICT", "Export manifest omits a parent directory");
      }
    }
    if (fileKeys.has(aliasKey(directory))) fail("UNSAFE_PATH", "Export manifest uses one path as both file and directory");
  }
  return Object.freeze({
    schema: PROJECT_MEMORY_EXPORT_SCHEMA,
    projectId: value.projectId,
    sourceRevision: value.sourceRevision as number,
    memoryState: value.memoryState,
    fileCount: value.fileCount as number,
    totalBytes: value.totalBytes as number,
    mappingSha256: value.mappingSha256,
    directories: Object.freeze(directories),
    files: Object.freeze(files),
  });
}

export function validateMappingSnapshot(value: unknown): ProjectMapping {
  if (!isRecord(value) || !exactKeys(value, ["schema", "mapping"]) || value.schema !== PROJECT_MAPPING_SNAPSHOT_SCHEMA ||
      !isRecord(value.mapping) || !exactKeys(value.mapping, ["projectId", "revision", "gitCommonDir", "commonIdentity", "native", "workspaces"])) {
    fail("MEMORY_CONFLICT", "Mapping snapshot has an unsupported or malformed schema");
  }
  const raw = value.mapping;
  if (!isUuid(raw.projectId) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 ||
      !isAbsoluteProvenancePath(raw.gitCommonDir) ||
      typeof raw.commonIdentity !== "string" || raw.commonIdentity.length === 0 || !isRecord(raw.native) ||
      !exactKeys(raw.native, ["storageRoot", "key", "memoryRoot", "mode"]) ||
      typeof raw.native.storageRoot !== "string" || !isAbsoluteProvenancePath(raw.native.storageRoot) ||
      typeof raw.native.memoryRoot !== "string" || !isAbsoluteProvenancePath(raw.native.memoryRoot) ||
      typeof raw.native.key !== "string" || !NATIVE_KEY.test(raw.native.key) ||
      (raw.native.mode !== "uuid" && raw.native.mode !== "adopted-legacy") || !Array.isArray(raw.workspaces) ||
      raw.workspaces.length > 10_000) fail("MEMORY_CONFLICT", "Mapping snapshot fields are invalid");
  if (!sameProvenancePath(raw.native.memoryRoot, provenanceNativeMemoryPath(raw.native.storageRoot, raw.native.key))) {
    fail("MEMORY_CONFLICT", "Mapping snapshot Native key and root disagree");
  }
  const workspaces = raw.workspaces.map((binding: unknown) => {
    if (!isRecord(binding) || !exactKeys(binding, ["workspacePath", "gitCommonDir", "gitPrivateDir", "commonIdentity", "privateIdentity", "kind", "worktreeParent", "nativeRuntimeKey", "nativePathMemoryKey"]) ||
        !isAbsoluteProvenancePath(binding.workspacePath) || !isAbsoluteProvenancePath(binding.gitCommonDir) ||
        !isAbsoluteProvenancePath(binding.gitPrivateDir) || typeof binding.commonIdentity !== "string" ||
        typeof binding.privateIdentity !== "string" || (binding.kind !== "main" && binding.kind !== "linked") ||
        (binding.worktreeParent !== null && typeof binding.worktreeParent !== "string") ||
        typeof binding.nativeRuntimeKey !== "string" || typeof binding.nativePathMemoryKey !== "string") {
      fail("MEMORY_CONFLICT", "Mapping snapshot contains an invalid workspace provenance record");
    }
    return Object.freeze({
      workspacePath: binding.workspacePath,
      gitCommonDir: binding.gitCommonDir,
      gitPrivateDir: binding.gitPrivateDir,
      commonIdentity: binding.commonIdentity,
      privateIdentity: binding.privateIdentity,
      kind: binding.kind,
      worktreeParent: binding.worktreeParent,
      nativeRuntimeKey: binding.nativeRuntimeKey,
      nativePathMemoryKey: binding.nativePathMemoryKey,
    });
  });
  return deepFreeze({
    projectId: raw.projectId,
    revision: raw.revision,
    gitCommonDir: raw.gitCommonDir,
    commonIdentity: raw.commonIdentity,
    native: { storageRoot: raw.native.storageRoot, key: raw.native.key, memoryRoot: raw.native.memoryRoot, mode: raw.native.mode },
    workspaces,
  }) as ProjectMapping;
}

export function createManifest(mapping: ProjectMapping, tree: CapturedMemoryTree, mappingSha256: string): ProjectMemoryManifest {
  return makeManifest(mapping, tree, mappingSha256);
}

export function captureExportMemory(bundle: ReadProjectMemoryExportResult): CapturedMemoryTree {
  if (bundle.manifest.memoryState === "absent") return emptyCapturedTree("absent");
  const actual = captureMemoryTree(path.join(bundle.bundleRoot, "memory"));
  const expected = capturedTreeFromManifest(bundle.manifest, actual);
  assertSameTreeContents(expected, actual, "Export memory changed after its manifest was validated");
  return actual;
}

export function diffExistingMemoryTarget(targetRootInput: string, boundaryRootInput: string,
  expected: CapturedMemoryTree): ProjectMemoryConflict[] {
  const targetRoot = absolutePath(targetRootInput, "Memory target");
  const boundaryRoot = absolutePath(boundaryRootInput, "Memory target boundary");
  let exists = false;
  try { exists = entryExists(targetRoot); }
  catch (error) {
    return [{ path: ".", reason: `destination-uninspectable:${errorCode(error)}` }];
  }
  try {
    const actual = captureMemoryTree(targetRoot, boundaryRoot);
    if (!exists && actual.state === "absent") return [];
    const conflicts: ProjectMemoryConflict[] = [{ path: ".", reason: "destination-exists" }];
    compareTrees("memory", expected, actual, conflicts);
    return dedupeConflicts(conflicts);
  } catch (error) {
    return [{ path: ".", reason: `destination-uninspectable:${errorCode(error)}` }];
  }
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

export function absolutePath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value) || value.includes("\0")) {
    fail("INVALID_INPUT", `${label} must be an absolute path`);
  }
  return path.resolve(value);
}

export function isWithinPath(rootInput: string, targetInput: string): boolean {
  const root = path.resolve(rootInput);
  const target = path.resolve(targetInput);
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function entryExists(filename: string): boolean {
  try { lstatSync(filename); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

export function readDirectoryNames(directory: string): string[] {
  const names: Buffer[] = [];
  let handle: Dir | undefined;
  try {
    // Node supports Buffer names for Dir at runtime; the current @types/node OpenDirOptions omits this encoding.
    handle = opendirSync(directory, { encoding: "buffer" as BufferEncoding });
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      const rawName = entry.name;
      names.push(Buffer.isBuffer(rawName) ? rawName : Buffer.from(rawName));
      if (names.length > MAX_PROJECT_MEMORY_FILES + MAX_PROJECT_MEMORY_DIRECTORIES + 2) {
        fail("UNSAFE_PATH", "Directory exceeds the bounded memory tree entry limit");
      }
    }
  } catch (error) {
    throw asRegistryError(error, "UNSAFE_PATH", "Directory cannot be safely enumerated");
  } finally {
    handle?.closeSync();
  }
  const decoded: Array<{ name: string; bytes: Buffer }> = [];
  const exact = new Set<string>();
  const aliases = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const bytes of names) {
    let name: string;
    try { name = decoder.decode(bytes); }
    catch { fail("UNSAFE_PATH", "Directory contains a name that is not valid UTF-8"); }
    if (!Buffer.from(name, "utf8").equals(bytes)) fail("UNSAFE_PATH", "Directory name does not round-trip as UTF-8");
    validatePathComponent(name);
    if (exact.has(name) || aliases.has(aliasKey(name))) fail("UNSAFE_PATH", "Directory contains aliased path names");
    exact.add(name);
    aliases.add(aliasKey(name));
    decoded.push({ name, bytes });
  }
  decoded.sort((left, right) => Buffer.compare(left.bytes, right.bytes));
  return decoded.map(entry => entry.name);
}

export function validateRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") ||
      value.startsWith("/") || path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    fail("UNSAFE_PATH", "Memory path must be a non-empty relative slash path");
  }
  const parts = value.split("/");
  if (parts.some(component => component.length === 0 || component === "." || component === "..")) {
    fail("UNSAFE_PATH", "Memory path contains an empty or traversal component");
  }
  for (const component of parts) validatePathComponent(component);
  if (parts.length > MAX_PROJECT_MEMORY_DEPTH + 1) fail("UNSAFE_PATH", "Memory path exceeds the supported depth");
  return parts.join("/");
}

export function validateCapturedTree(value: CapturedMemoryTree): CapturedMemoryTree {
  if (typeof value !== "object" || value === null || (value.state !== "present" && value.state !== "absent") ||
      !Array.isArray(value.files) || !Array.isArray(value.directories) ||
      (value.rootIdentity !== null && typeof value.rootIdentity !== "string") ||
      typeof value.directoryIdentities !== "object" || value.directoryIdentities === null || Array.isArray(value.directoryIdentities)) {
    fail("MEMORY_CONFLICT", "Memory copy inventory is malformed");
  }
  if (value.files.length > MAX_PROJECT_MEMORY_FILES || value.directories.length > MAX_PROJECT_MEMORY_DIRECTORIES) {
    fail("UNSAFE_PATH", "Memory copy inventory exceeds supported entry limits");
  }
  if (value.state === "absent" && (value.files.length > 0 || value.directories.length > 0 || value.totalBytes !== 0)) {
    fail("MEMORY_CONFLICT", "Absent memory inventory must be empty");
  }
  if (value.state === "present" && typeof value.rootIdentity !== "string") fail("MEMORY_CONFLICT", "Present memory inventory has no root identity");
  const directories: string[] = [];
  const directoryKeys = new Set<string>();
  for (const raw of value.directories) {
    if (typeof raw !== "string") fail("UNSAFE_PATH", "Memory copy inventory has a non-string directory path");
    const directory = validateRelativePath(raw);
    const key = aliasKey(directory);
    if (directoryKeys.has(key)) fail("UNSAFE_PATH", "Memory copy inventory has aliased directories");
    directoryKeys.add(key);
    directories.push(directory);
  }
  const files: CapturedMemoryFile[] = [];
  const fileKeys = new Set<string>();
  let totalBytes = 0;
  for (const raw of value.files) {
    if (typeof raw !== "object" || raw === null || typeof raw.path !== "string" || !Buffer.isBuffer(raw.bytes) ||
        !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > MAX_PROJECT_MEMORY_FILE_BYTES || !isSha256(raw.sha256)) {
      fail("MEMORY_CONFLICT", "Memory copy inventory has an invalid file record");
    }
    const filePath = validateRelativePath(raw.path);
    const key = aliasKey(filePath);
    if (fileKeys.has(key) || directoryKeys.has(key) || raw.bytes.byteLength !== raw.size || sha256(raw.bytes) !== raw.sha256) {
      fail("UNSAFE_PATH", `Memory copy inventory has an aliased or unverified file: ${filePath}`);
    }
    fileKeys.add(key);
    totalBytes += raw.size;
    files.push(Object.freeze({ path: filePath, size: raw.size, sha256: raw.sha256, bytes: raw.bytes }));
  }
  if (totalBytes > MAX_PROJECT_MEMORY_TOTAL_BYTES || totalBytes !== value.totalBytes) {
    fail("UNSAFE_PATH", "Memory copy inventory exceeds its total byte limit or has an incorrect size");
  }
  for (const directory of directories) {
    const parts = directory.split("/");
    if (parts.length > MAX_PROJECT_MEMORY_DEPTH) fail("UNSAFE_PATH", "Memory copy directory exceeds its depth limit");
    for (let index = 1; index < parts.length; index++) {
      if (!directoryKeys.has(aliasKey(parts.slice(0, index).join("/")))) {
        fail("MEMORY_CONFLICT", "Memory copy inventory omits a parent directory");
      }
    }
  }
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length > MAX_PROJECT_MEMORY_DEPTH + 1) fail("UNSAFE_PATH", "Memory copy file exceeds its depth limit");
    for (let index = 1; index < parts.length; index++) {
      const parent = aliasKey(parts.slice(0, index).join("/"));
      if (!directoryKeys.has(parent)) fail("MEMORY_CONFLICT", "Memory copy inventory omits a file parent directory");
    }
  }
  directories.sort(compareUtf8);
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const expectedIdentityPaths = new Set(["", ...directories]);
  const identityKeys = Object.keys(value.directoryIdentities);
  if (identityKeys.length !== expectedIdentityPaths.size || identityKeys.some(key =>
      !expectedIdentityPaths.has(key) || typeof value.directoryIdentities[key] !== "string" || value.directoryIdentities[key]!.length === 0)) {
    fail("MEMORY_CONFLICT", "Memory copy inventory has incomplete directory identity evidence");
  }
  const directoryIdentities = Object.create(null) as Record<string, string>;
  for (const key of identityKeys) directoryIdentities[key] = value.directoryIdentities[key]!;
  if (value.state === "absent" && (value.rootIdentity !== null || identityKeys.length !== 0)) {
    fail("MEMORY_CONFLICT", "Absent memory inventory cannot carry physical directory identities");
  }
  return Object.freeze({ state: value.state, files: Object.freeze(files), directories: Object.freeze(directories),
    totalBytes, rootIdentity: value.rootIdentity, directoryIdentities: Object.freeze(directoryIdentities) });
}

export function fail(code: ProjectRegistryErrorCode | string, message: string, options?: ErrorOptions): never {
  throw new ProjectRegistryError(code as ProjectRegistryErrorCode, message, options);
}

function makeManifest(mapping: ProjectMapping, tree: CapturedMemoryTree, mappingSha256: string): ProjectMemoryManifest {
  return Object.freeze({
    schema: PROJECT_MEMORY_EXPORT_SCHEMA,
    projectId: mapping.projectId,
    sourceRevision: mapping.revision,
    memoryState: tree.state,
    fileCount: tree.files.length,
    totalBytes: tree.totalBytes,
    mappingSha256,
    directories: Object.freeze([...tree.directories]),
    files: Object.freeze(tree.files.map(({ path: filePath, size, sha256: digest }) => Object.freeze({ path: filePath, size, sha256: digest }))),
  });
}

function emptyCapturedTree(state: "present" | "absent"): CapturedMemoryTree {
  return Object.freeze({ state, files: Object.freeze([]), directories: Object.freeze([]), totalBytes: 0,
    rootIdentity: null, directoryIdentities: Object.freeze(Object.create(null) as Record<string, string>) });
}

function capturedTreeFromManifest(manifest: ProjectMemoryManifest, actual: CapturedMemoryTree): CapturedMemoryTree {
  const actualByPath = new Map(actual.files.map(file => [file.path, file]));
  const files = manifest.files.map(record => {
    const found = actualByPath.get(record.path);
    if (found === undefined || found.size !== record.size || found.sha256 !== record.sha256) {
      fail("MEMORY_CONFLICT", `Export file differs from manifest: ${record.path}`);
    }
    return found;
  });
  if (files.length !== actual.files.length || !sameStringArray(manifest.directories, actual.directories)) {
    fail("MEMORY_CONFLICT", "Export inventory differs from its manifest");
  }
  return Object.freeze({ ...actual, state: manifest.memoryState, files: Object.freeze(files), totalBytes: manifest.totalBytes });
}

function compareExistingBundle(bundleRoot: string, manifestBytes: Buffer, mappingBytes: Buffer,
  expectedMemory: CapturedMemoryTree): ProjectMemoryConflict[] {
  const conflicts: ProjectMemoryConflict[] = [{ path: ".", reason: "destination-exists" }];
  try {
    assertPhysicalDirectoryChain(bundleRoot);
    const actualNames = readDirectoryNames(bundleRoot);
    const expectedTop = ["manifest.json", "mapping.json", ...(expectedMemory.state === "present" ? ["memory"] : [])].sort(compareUtf8);
    for (const name of actualNames) {
      if (!expectedTop.includes(name)) conflicts.push({ path: name, reason: "unexpected-entry" });
    }
    for (const name of expectedTop) {
      if (!actualNames.includes(name)) conflicts.push({ path: name, reason: "missing-entry" });
    }
    compareBundleMetadata(bundleRoot, "manifest.json", manifestBytes, conflicts);
    compareBundleMetadata(bundleRoot, "mapping.json", mappingBytes, conflicts);
    const memoryPath = path.join(bundleRoot, "memory");
    if (actualNames.includes("memory")) {
      const actual = captureMemoryTree(memoryPath);
      compareTrees("memory", expectedMemory, actual, conflicts);
    }
  } catch (error) {
    conflicts.push({ path: ".", reason: `destination-uninspectable:${errorCode(error)}` });
  }
  return dedupeConflicts(conflicts);
}

function compareBundleMetadata(bundleRoot: string, filename: string, expected: Buffer, conflicts: ProjectMemoryConflict[]): void {
  const target = path.join(bundleRoot, filename);
  if (!entryExists(target)) return;
  try {
    const current = readStableFile(bundleRoot, filename, MAX_METADATA_BYTES);
    const expectedHash = sha256(expected);
    if (current.sha256 !== expectedHash) conflicts.push({ path: filename, reason: "content-differs",
      expectedSha256: expectedHash, currentSha256: current.sha256 });
  } catch (error) {
    conflicts.push({ path: filename, reason: `unsafe-existing-entry:${errorCode(error)}` });
  }
}

function compareTrees(prefix: string, expected: CapturedMemoryTree, actual: CapturedMemoryTree,
  conflicts: ProjectMemoryConflict[]): void {
  if (expected.state !== actual.state) conflicts.push({ path: prefix, reason: "memory-state-differs" });
  const expectedFiles = new Map(expected.files.map(file => [file.path, file]));
  const actualFiles = new Map(actual.files.map(file => [file.path, file]));
  for (const [filePath, file] of expectedFiles) {
    const current = actualFiles.get(filePath);
    if (current === undefined) conflicts.push({ path: `${prefix}/${filePath}`, reason: "missing-file", expectedSha256: file.sha256 });
    else if (current.sha256 !== file.sha256) conflicts.push({ path: `${prefix}/${filePath}`, reason: "content-differs",
      expectedSha256: file.sha256, currentSha256: current.sha256 });
  }
  for (const [filePath, file] of actualFiles) {
    if (!expectedFiles.has(filePath)) conflicts.push({ path: `${prefix}/${filePath}`, reason: "unexpected-file", currentSha256: file.sha256 });
  }
  const expectedDirectories = new Set(expected.directories);
  const actualDirectories = new Set(actual.directories);
  for (const directory of expectedDirectories) if (!actualDirectories.has(directory)) conflicts.push({ path: `${prefix}/${directory}`, reason: "missing-directory" });
  for (const directory of actualDirectories) if (!expectedDirectories.has(directory)) conflicts.push({ path: `${prefix}/${directory}`, reason: "unexpected-directory" });
}

function readStableFile(rootInput: string, relativeInput: string, maximum: number): { bytes: Buffer; sha256: string } {
  const root = absolutePath(rootInput, "Stable-read root");
  const relative = validateRelativePath(relativeInput);
  const located = locateFile(root, relative);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try { descriptor = openSync(located.filename, constants.O_RDONLY | noFollow); }
  catch (error) { throw asRegistryError(error, "UNSAFE_PATH", "File could not be opened safely"); }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileStat(located.stat, opened)) {
      fail("IDENTITY_CONFLICT", "File changed between path inspection and stable-handle open");
    }
    if (opened.size > BigInt(maximum)) fail("UNSAFE_PATH", "File exceeds the supported byte limit");
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1));
    for (;;) {
      const remaining = maximum + 1 - total;
      if (remaining <= 0) fail("UNSAFE_PATH", "File exceeds the supported byte limit");
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, remaining), null);
      if (count === 0) break;
      chunks.push(Buffer.from(chunk.subarray(0, count)));
      total += count;
    }
    const bytes = Buffer.concat(chunks, total);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(located.filename, { bigint: true });
    const again = locateFile(root, relative);
    if (bytes.byteLength > maximum || !sameFileStat(opened, after) || !sameFileStat(after, pathAfter) ||
        pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.nlink !== 1n ||
        !samePath(again.realpath, located.realpath) || !samePath(realpathSync.native(located.filename), located.realpath)) {
      fail("IDENTITY_CONFLICT", "File changed while it was read");
    }
    return { bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof ProjectRegistryError) throw error;
    throw asRegistryError(error, "IDENTITY_CONFLICT", "File could not be read stably");
  } finally {
    closeSync(descriptor);
  }
}

function locateFile(root: string, relative: string): { filename: string; realpath: string; stat: BigIntStats } {
  assertPhysicalDirectory(root);
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    const name = parts[index]!;
    const names = readDirectoryNames(current);
    if (!names.includes(name)) fail("IDENTITY_CONFLICT", `File path disappeared during read: ${relative}`);
    current = path.join(current, name);
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) fail("UNSAFE_PATH", `File path contains a symlink or junction: ${relative}`);
    const final = index === parts.length - 1;
    if (final ? (!stat.isFile() || stat.nlink !== 1n) : !stat.isDirectory()) {
      fail("UNSAFE_PATH", `File path contains an unsupported entry: ${relative}`);
    }
    const real = realpathSync.native(current);
    if (!isWithinPath(root, real) || !samePath(real, current)) fail("UNSAFE_PATH", "File path escapes its physical root");
    if (final) return { filename: current, realpath: real, stat };
  }
  fail("UNSAFE_PATH", "File path is empty");
}

function validatePathComponent(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || name.includes("\0") || name.includes("/") ||
      name.includes("\\") || name.includes(":") || /[. ]$/.test(name)) fail("UNSAFE_PATH", "Memory path contains an unsafe component");
  const deviceBase = name.split(".", 1)[0]!.replace(/[ .]+$/g, "").toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceBase)) fail("UNSAFE_PATH", "Memory path uses a reserved Windows device name");
}

function aliasKey(value: string): string {
  const normalized = value.normalize("NFC");
  return normalized.toLocaleLowerCase("en-US");
}

function fileIdentity(stat: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function sameFileStat(left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; birthtimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; birthtimeNs: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
}

function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort(compareUtf8);
  const rightKeys = Object.keys(right).sort(compareUtf8);
  return sameStringArray(leftKeys, rightKeys) && leftKeys.every(key => left[key] === right[key]);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalValue(item));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort(compareUtf8).map(key => [key, canonicalValue(record[key])]));
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseCanonicalJson(bytes: Buffer, label: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch (cause) { throw new ProjectRegistryError("MEMORY_CONFLICT", `${label} is not valid UTF-8 JSON`, { cause }); }
  if (!jsonBytes(parsed).equals(bytes)) fail("MEMORY_CONFLICT", `${label} is not in the canonical export encoding`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  return sameStringArray(keys, wanted);
}

function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function isSha256(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function isExists(error: unknown): boolean { return hasCode(error, "EEXIST"); }
function isMissing(error: unknown): boolean { return hasCode(error, "ENOENT"); }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorCode(error: unknown): string {
  if (error instanceof ProjectRegistryError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "UNKNOWN";
}

function asRegistryError(error: unknown, code: ProjectRegistryErrorCode, message: string): ProjectRegistryError {
  if (error instanceof ProjectRegistryError) return error;
  return new ProjectRegistryError(code, message, { cause: error });
}

function assertSynchronousResult(result: unknown): void {
  if ((typeof result === "object" && result !== null || typeof result === "function") &&
      "then" in result && typeof (result as { then?: unknown }).then === "function") {
    fail("INVALID_INPUT", "U06 fault and verification callbacks must be synchronous");
  }
}

function markInjectedFault(error: unknown): void {
  if (typeof error === "object" && error !== null) injectedFaultErrors.add(error);
}

export function conflictResult(bundleRoot: string, conflicts: readonly ProjectMemoryConflict[]): ExportProjectMemoryResult {
  const stable = [...conflicts].sort((left, right) => compareUtf8(left.path, right.path) || compareUtf8(left.reason, right.reason));
  return Object.freeze({ status: "conflict", bundleRoot, conflicts: Object.freeze(stable) });
}

function dedupeConflicts(conflicts: readonly ProjectMemoryConflict[]): ProjectMemoryConflict[] {
  const byKey = new Map<string, ProjectMemoryConflict>();
  for (const item of conflicts) byKey.set(`${item.path}\0${item.reason}\0${item.expectedSha256 ?? ""}\0${item.currentSha256 ?? ""}`, item);
  return [...byKey.values()].sort((left, right) => compareUtf8(left.path, right.path) || compareUtf8(left.reason, right.reason));
}
