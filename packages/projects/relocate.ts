import path from "node:path";
import {
  ProjectRegistryError,
  type ProjectRegistry,
  type ProjectMapping,
} from "./registry.js";
import {
  assertAuthorization,
  assertPhysicalDirectory,
  assertPhysicalDirectoryChain,
  assertFreshMapping,
  assertSameCapturedTree,
  assertSameTreeContents,
  absolutePath,
  captureExportMemory,
  captureMemoryTree,
  captureNativeMemoryTree,
  copyCapturedTree,
  createManifest,
  directoryIdentity,
  diffExistingMemoryTarget,
  fail,
  isInjectedFault,
  jsonBytes,
  mappingSnapshot,
  nativeMemoryPath,
  runSynchronousCopyFault,
  runSynchronousFault,
  readProjectMemoryExport,
  requireCurrentMapping,
  sha256,
  type ProjectMemoryConflict,
  type ProjectMemoryFaults,
} from "./export.js";

export interface RelocateProjectMemoryAuthorization {
  readonly projectId: string;
  readonly action: "relocate-memory";
  readonly confirmed: true;
}

export interface RelocateProjectMemoryInput {
  readonly registry: ProjectRegistry;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly nativeStorageRoot: string;
  readonly authorization: RelocateProjectMemoryAuthorization;
  readonly faults?: ProjectMemoryFaults;
}

export interface ImportProjectMemoryAuthorization {
  readonly projectId: string;
  readonly manifestSha256: string;
  readonly action: "import";
  readonly confirmed: true;
}

export interface ImportProjectMemoryInput {
  readonly registry: ProjectRegistry;
  readonly bundleRoot: string;
  readonly workspacePath: string;
  readonly nativeStorageRoot: string;
  readonly authorization: ImportProjectMemoryAuthorization;
  readonly faults?: ProjectMemoryFaults;
}

export type RelocateProjectMemoryResult =
  | {
      readonly status: "relocated";
      readonly mapping: ProjectMapping;
      readonly manifestSha256: string;
      readonly targetMemoryRoot: string;
      readonly sourceRetained: true;
    }
  | {
      readonly status: "conflict";
      readonly targetMemoryRoot: string;
      readonly conflicts: readonly ProjectMemoryConflict[];
    };

export type ImportProjectMemoryResult =
  | {
      readonly status: "imported";
      readonly mapping: ProjectMapping;
      readonly sourceProjectId: string;
      readonly manifestSha256: string;
      readonly targetMemoryRoot: string;
      readonly sourceRetained: true;
    }
  | {
      readonly status: "conflict";
      readonly targetMemoryRoot: string;
      readonly conflicts: readonly ProjectMemoryConflict[];
    };

export function relocateProjectMemory(input: RelocateProjectMemoryInput): RelocateProjectMemoryResult {
  assertAuthorization(input.authorization, input.projectId, "relocate-memory");
  const before = requireCurrentMapping(input.registry, input.projectId, input.expectedRevision);
  const source = captureNativeMemoryTree(before);
  const targetStorageRoot = absolutePath(input.nativeStorageRoot, "Native storage root");
  assertStorageRoot(targetStorageRoot);
  if (samePath(targetStorageRoot, before.native.storageRoot)) {
    fail("INVALID_INPUT", "Native memory relocation requires a different storage root");
  }
  const targetMemoryRoot = nativeMemoryPath(targetStorageRoot, before.native.key);
  const conflicts = diffExistingMemoryTarget(targetMemoryRoot, targetStorageRoot, source);
  if (conflicts.length > 0) return relocationConflict(targetMemoryRoot, conflicts);

  const mappingBytes = jsonBytes({ schema: "xiadie-project-mapping-snapshot/v1", mapping: mappingSnapshot(before) });
  const operationManifest = createManifest(before, source, sha256(mappingBytes));
  const manifestSha256 = sha256(jsonBytes(operationManifest));

  try {
    copyCapturedTree(source, targetMemoryRoot, targetStorageRoot, directoryIdentity(targetStorageRoot),
      event => runSynchronousCopyFault(input.faults?.afterFileCopy, event));
  } catch (error) {
    if (!isInjectedFault(error) && error instanceof ProjectRegistryError &&
        (error.code === "MEMORY_CONFLICT" || error.code === "UNSAFE_PATH")) {
      const racedTarget = diffExistingMemoryTarget(targetMemoryRoot, targetStorageRoot, source);
      if (racedTarget.length > 0) return relocationConflict(targetMemoryRoot, racedTarget);
    }
    throw error;
  }
  runSynchronousFault(input.faults?.afterCopy);

  assertFreshMapping(input.registry, before, input.expectedRevision);
  const sourceAfterCopy = captureNativeMemoryTree(before);
  assertSameCapturedTree(source, sourceAfterCopy, "Source memory changed while it was relocated");
  const targetBeforeMetadata = captureMemoryTree(targetMemoryRoot, targetStorageRoot);
  assertSameTreeContents(source, targetBeforeMetadata, "Relocation target does not match the source memory tree");
  runSynchronousFault(input.faults?.afterVerify);

  let verifyCalls = 0;
  const verifyTarget = (): void => {
    verifyCalls++;
    if (verifyCalls === 2) runSynchronousFault(input.faults?.afterMetadataWrite);
    const currentSource = captureNativeMemoryTree(before);
    assertSameCapturedTree(source, currentSource, "Source memory changed during the registry transaction");
    const current = captureMemoryTree(targetMemoryRoot, targetStorageRoot);
    assertSameTreeContents(source, current, "Relocation target changed during the registry transaction");
  };
  const mapping = input.registry.relocateNativeStorage({
    projectId: before.projectId,
    expectedRevision: before.revision,
    nativeStorageRoot: targetStorageRoot,
    confirmed: true,
    verifyTarget,
  });
  assertRelocatedMapping(mapping, before, targetStorageRoot, targetMemoryRoot);
  return Object.freeze({ status: "relocated", mapping, manifestSha256, targetMemoryRoot, sourceRetained: true });
}

export function importProjectMemory(input: ImportProjectMemoryInput): ImportProjectMemoryResult {
  const bundle = readProjectMemoryExport(input.bundleRoot);
  assertAuthorization(input.authorization, bundle.projectId, "import", bundle.manifestSha256);
  const snapshot = bundle.mappingSnapshot;
  if (snapshot.projectId !== bundle.projectId || snapshot.revision !== bundle.sourceRevision) {
    fail("MEMORY_CONFLICT", "Export project identity does not match its mapping snapshot");
  }

  const source = captureExportMemory(bundle);
  const targetStorageRoot = absolutePath(input.nativeStorageRoot, "Native storage root");
  assertStorageRoot(targetStorageRoot);
  const targetMemoryRoot = nativeMemoryPath(targetStorageRoot, snapshot.native.key);
  const conflicts = diffExistingMemoryTarget(targetMemoryRoot, targetStorageRoot, source);
  if (conflicts.length > 0) return importConflict(targetMemoryRoot, conflicts);

  try {
    copyCapturedTree(source, targetMemoryRoot, targetStorageRoot, directoryIdentity(targetStorageRoot),
      event => runSynchronousCopyFault(input.faults?.afterFileCopy, event));
  } catch (error) {
    if (!isInjectedFault(error) && error instanceof ProjectRegistryError &&
        (error.code === "MEMORY_CONFLICT" || error.code === "UNSAFE_PATH")) {
      const racedTarget = diffExistingMemoryTarget(targetMemoryRoot, targetStorageRoot, source);
      if (racedTarget.length > 0) return importConflict(targetMemoryRoot, racedTarget);
    }
    throw error;
  }
  runSynchronousFault(input.faults?.afterCopy);

  const bundleAfterCopy = readProjectMemoryExport(bundle.bundleRoot);
  if (bundleAfterCopy.manifestSha256 !== bundle.manifestSha256 || bundleAfterCopy.projectId !== bundle.projectId) {
    fail("IDENTITY_CONFLICT", "Import bundle changed while it was copied");
  }
  const sourceAfterCopy = captureExportMemory(bundleAfterCopy);
  assertSameCapturedTree(source, sourceAfterCopy, "Import bundle memory changed while it was copied");
  const targetBeforeMetadata = captureMemoryTree(targetMemoryRoot, targetStorageRoot);
  assertSameTreeContents(source, targetBeforeMetadata, "Import target does not match the authorized export");
  runSynchronousFault(input.faults?.afterVerify);

  let verifyCalls = 0;
  const verifyTarget = (): void => {
    verifyCalls++;
    if (verifyCalls === 2) runSynchronousFault(input.faults?.afterMetadataWrite);
    const currentBundle = readProjectMemoryExport(bundle.bundleRoot);
    if (currentBundle.manifestSha256 !== bundle.manifestSha256 || currentBundle.projectId !== bundle.projectId) {
      fail("IDENTITY_CONFLICT", "Authorized import bundle changed during the registry transaction");
    }
    const currentSource = captureExportMemory(currentBundle);
    assertSameCapturedTree(source, currentSource, "Authorized import memory changed during the registry transaction");
    const current = captureMemoryTree(targetMemoryRoot, targetStorageRoot);
    assertSameTreeContents(source, current, "Import target changed during the registry transaction");
  };
  const mapping = input.registry.importProjectWorkspace({
    projectId: bundle.projectId,
    sourceRevision: bundle.sourceRevision,
    nativeKey: snapshot.native.key,
    mode: snapshot.native.mode,
    workspacePath: input.workspacePath,
    nativeStorageRoot: targetStorageRoot,
    confirmed: true,
    verifyTarget,
  });
  assertImportedMapping(mapping, bundle, input.workspacePath, targetStorageRoot, targetMemoryRoot);
  return Object.freeze({ status: "imported", mapping, sourceProjectId: bundle.projectId,
    manifestSha256: bundle.manifestSha256, targetMemoryRoot, sourceRetained: true });
}

function assertStorageRoot(value: string): void {
  const resolved = absolutePath(value, "Native storage root");
  // The registry repeats this physical-directory and identity check inside its transaction.
  assertPhysicalDirectoryChain(resolved);
  assertPhysicalDirectory(resolved);
}

function assertRelocatedMapping(mapping: ProjectMapping, before: ProjectMapping, storageRoot: string, memoryRoot: string): void {
  if (mapping.projectId !== before.projectId || mapping.revision !== before.revision + 1 ||
      !samePath(mapping.native.storageRoot, storageRoot) || !samePath(mapping.native.memoryRoot, memoryRoot) ||
      mapping.native.key !== before.native.key || mapping.native.mode !== before.native.mode) {
    throw new ProjectRegistryError("IDENTITY_CONFLICT", "Registry returned an unexpected post-relocation mapping");
  }
}

function assertImportedMapping(mapping: ProjectMapping, bundle: ReturnType<typeof readProjectMemoryExport>,
  workspacePath: string, storageRoot: string, memoryRoot: string): void {
  if (mapping.projectId !== bundle.projectId || mapping.revision !== bundle.sourceRevision + 1 ||
      !samePath(mapping.native.storageRoot, storageRoot) || !samePath(mapping.native.memoryRoot, memoryRoot) ||
      mapping.native.key !== bundle.mappingSnapshot.native.key || mapping.native.mode !== bundle.mappingSnapshot.native.mode ||
      !mapping.workspaces.some(binding => samePath(binding.workspacePath, workspacePath))) {
    throw new ProjectRegistryError("IDENTITY_CONFLICT", "Registry returned an unexpected post-import mapping");
  }
}

function relocationConflict(targetMemoryRoot: string, conflicts: readonly ProjectMemoryConflict[]): RelocateProjectMemoryResult {
  return Object.freeze({ status: "conflict", targetMemoryRoot, conflicts: Object.freeze([...conflicts]) });
}

function importConflict(targetMemoryRoot: string, conflicts: readonly ProjectMemoryConflict[]): ImportProjectMemoryResult {
  return Object.freeze({ status: "conflict", targetMemoryRoot, conflicts: Object.freeze([...conflicts]) });
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
