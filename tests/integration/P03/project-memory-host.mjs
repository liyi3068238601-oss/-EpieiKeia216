import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, writeSync, fsyncSync } from "node:fs";
import path from "node:path";
import { createFileSystemError } from "@p01/native-filesystem-contracts";
import { resolveProjectMemoryRoot } from "@p03/native-project-root";
import { getCliStorageRoot, projectIdFromDirectory } from "@p03/native-paths";
import { openProjectRegistry, isTrustedProjectMapping } from "../../../dist/packages/projects/registry.js";
import { createProjectMemoryReader } from "../../../dist/packages/adapters/zcode/src/project-memory.js";
import { createDurableHost } from "../P02/durable-host.mjs";

export const P03_SELECTED_TOPIC = "p03-topic.md";
const AUDIT_FILENAME = "p03-memory-audit.jsonl";

function key(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requirePhysicalDirectory(filename, root, code) {
  const info = lstatSync(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
  const actual = realpathSync(filename);
  if (!inside(root, actual)) throw new Error(code);
  return actual;
}

function auditPath(filename, projectMemoryRoot, memoryFamily) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) return "invalid-path";
  const absolute = path.resolve(filename);
  if (inside(projectMemoryRoot, absolute)) {
    const relative = path.relative(projectMemoryRoot, absolute).split(path.sep).join("/");
    return relative || "MEMORY.md";
  }
  if (inside(memoryFamily, absolute)) {
    return `foreign/${path.relative(memoryFamily, absolute).split(path.sep).join("/")}`;
  }
  return "outside";
}

function appendAudit(descriptor, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
  }
  fsyncSync(descriptor);
}

function closeResources(resources) {
  if (resources.closed) return;
  resources.closed = true;
  let failure;
  if (resources.auditDescriptor !== undefined) {
    try { closeSync(resources.auditDescriptor); } catch (error) { failure = error; }
  }
  try { resources.registry?.close(); } catch (error) { failure ??= error; }
  if (failure) throw failure;
}

function validateOwnedBinding(input) {
  if (!input || typeof input.ownedProfileRoot !== "string" || !path.isAbsolute(input.ownedProfileRoot) ||
      typeof input.appOptions?.workingDirectory !== "string" || !path.isAbsolute(input.appOptions.workingDirectory)) {
    throw new Error("P03_OWNED_CONTEXT_INVALID");
  }
  const profileRoot = realpathSync(input.ownedProfileRoot);
  const workspacePath = realpathSync(input.appOptions.workingDirectory);
  if (!inside(profileRoot, workspacePath)) throw new Error("P03_WORKSPACE_OUTSIDE_PROFILE");
  const workspaceInfo = lstatSync(workspacePath);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw new Error("P03_WORKSPACE_INVALID");

  const env = input.appOptions.env;
  if (!env || typeof env.ZCODE_STORAGE_DIR !== "string" || !path.isAbsolute(env.ZCODE_STORAGE_DIR)) {
    throw new Error("P03_NATIVE_STORAGE_ENV_INVALID");
  }
  const registryDirectoryPath = path.join(profileRoot, "p03-registry");
  const registryDirectory = requirePhysicalDirectory(registryDirectoryPath, profileRoot, "P03_REGISTRY_DIRECTORY_INVALID");
  const registryPath = path.join(registryDirectory, "project-registry.sqlite");
  const databaseInfo = lstatSync(registryPath);
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink() || !inside(profileRoot, realpathSync(registryPath))) {
    throw new Error("P03_REGISTRY_DATABASE_MISSING");
  }

  const nativeStorageCandidate = getCliStorageRoot(env.ZCODE_STORAGE_DIR);
  const expectedStorageCandidate = path.join(profileRoot, "storage", "cli");
  if (key(nativeStorageCandidate) !== key(expectedStorageCandidate)) throw new Error("P03_NATIVE_STORAGE_ROOT_MISMATCH");
  const nativeStorageRoot = requirePhysicalDirectory(nativeStorageCandidate, profileRoot, "P03_NATIVE_STORAGE_ROOT_INVALID");
  return { profileRoot, workspacePath, env, registryDirectory, registryPath, nativeStorageRoot };
}

/**
 * P03 composition around the accepted P02 durable host. The harness owns and
 * seeds registry rows and Native memory; this runtime only resolves a row and
 * reads its selected topic through the accepted Native Read bridge.
 */
export async function createP03DurableHost(input) {
  if (!input.enabled) return createDurableHost(input);

  const owned = validateOwnedBinding(input);
  const resources = { closed: false, registry: undefined, auditDescriptor: undefined };
  let host;
  try {
    resources.registry = openProjectRegistry({
      ownedDirectory: owned.registryDirectory,
      nativeStorageRoot: owned.nativeStorageRoot,
      nativeMemoryRootResolver: resolveProjectMemoryRoot,
      nativeRuntimeKeyResolver: projectIdFromDirectory,
    });
    const project = resources.registry.resolveWorkspace(owned.workspacePath);
    if (!isTrustedProjectMapping(project) ||
        key(project.native.storageRoot) !== key(owned.nativeStorageRoot) ||
        key(project.native.memoryRoot) !== key(resolveProjectMemoryRoot({
          cliStorageRoot: owned.nativeStorageRoot,
          workspacePath: owned.workspacePath,
          workspaceIdentity: project.projectId,
        }))) {
      throw new Error("P03_PROJECT_MAPPING_INVALID");
    }
    const runtimeConfig = input.appOptions.runtimeConfig ?? {};
    const memoryConfig = runtimeConfig.memory ?? {};
    if (memoryConfig.enabled !== false || memoryConfig.use !== false || memoryConfig.extractionEnabled !== false) {
      throw new Error("P03_NATIVE_MEMORY_MUST_REMAIN_DISABLED");
    }
    const appOptions = {
      ...input.appOptions,
      runtimeConfig: {
        ...runtimeConfig,
        memory: { ...memoryConfig, workspaceIdentity: project.projectId },
      },
    };

    const memoryFamily = path.join(project.native.storageRoot, "memories");
    const reader = createProjectMemoryReader({
      registry: resources.registry,
      workspacePath: owned.workspacePath,
      selectedTopics: () => [P03_SELECTED_TOPIC],
    });
    const auditLogPath = path.join(owned.profileRoot, AUDIT_FILENAME);
    resources.auditDescriptor = openSync(auditLogPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
    const auditInfo = fstatSync(resources.auditDescriptor);
    if (!auditInfo.isFile() || key(realpathSync(auditLogPath)) !== key(auditLogPath) || !inside(owned.profileRoot, realpathSync(auditLogPath))) {
      throw new Error("P03_MEMORY_AUDIT_PATH_INVALID");
    }

    const auditedReader = Object.freeze({
      capture() {
        const snapshot = reader.capture();
        appendAudit(resources.auditDescriptor, {
          event: "capture",
          projectId: snapshot.project_id,
          path: "MEMORY.md",
          kind: snapshot.kind,
          code: snapshot.code,
          sampledAt: snapshot.sampled_at,
          hash: snapshot.index.source_hash,
          size: snapshot.index.sizeBytes ?? null,
        });
        // Return the original object; the reader binds admission authority to it.
        return snapshot;
      },
      read(snapshot, filename) {
        try {
          const source = reader.read(snapshot, filename);
          appendAudit(resources.auditDescriptor, {
            event: "read",
            projectId: snapshot.project_id,
            path: source.path,
            kind: source.kind,
            code: source.code,
            sampledAt: snapshot.sampled_at,
            hash: source.source_hash,
            size: source.sizeBytes,
          });
          return source;
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "READ_FAILED";
          appendAudit(resources.auditDescriptor, {
            event: "read",
            projectId: snapshot?.project_id ?? project.projectId,
            path: auditPath(filename, project.native.memoryRoot, memoryFamily),
            kind: code === "READ_NOT_ADMITTED" ? "unreadable" : "corrupt",
            code,
            sampledAt: snapshot?.sampled_at ?? null,
            hash: null,
            size: null,
          });
          throw error;
        }
      },
    });

    host = await createDurableHost({
      ...input,
      appOptions,
      projectMemory: auditedReader,
      projectMemoryReadPort: {
        project,
        workspacePath: owned.workspacePath,
        createError: createFileSystemError,
      },
    });
  } catch (error) {
    try { closeResources(resources); } catch { /* keep the initialization error */ }
    throw error;
  }

  let closePromise;
  const close = (...args) => {
    closePromise ??= (async () => {
      try { return await host.close?.(...args); }
      finally { closeResources(resources); }
    })();
    return closePromise;
  };
  return { ...host, close };
}
