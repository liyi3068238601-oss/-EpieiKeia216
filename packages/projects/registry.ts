import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openSQLiteConnection, type SQLiteConnection, type SQLiteRow } from "../storage/events/src/sqlite.js";

const APPLICATION_ID = 0x58495052;
const SCHEMA_VERSION = 2;
// Bind migration to the accepted U03 DDL, not just an application marker and
// column names. These constraints are part of the registry's safety contract.
const PROJECT_SCHEMA = `CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0),
  common_dir TEXT NOT NULL,
  common_identity TEXT NOT NULL UNIQUE,
  storage_root TEXT NOT NULL,
  native_key TEXT NOT NULL,
  canonical_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('uuid','adopted-legacy'))
) STRICT;`;
const WORKSPACE_SCHEMA = `CREATE TABLE workspaces (
  path_key TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  common_dir TEXT NOT NULL,
  private_dir TEXT NOT NULL,
  common_identity TEXT NOT NULL,
  private_identity TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('main','linked')),
  native_runtime_key TEXT NOT NULL,
  native_path_memory_key TEXT NOT NULL
) STRICT;`;
const RELOCATION_SCHEMA = `CREATE TABLE project_relocations (
  sequence INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  operation TEXT NOT NULL CHECK(operation IN ('workspace','native-storage','import')),
  previous_revision INTEGER,
  revision INTEGER NOT NULL CHECK(revision > 0),
  occurred_at TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL
) STRICT;`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NATIVE_KEY = /^[a-z0-9._-]{1,48}-[a-f0-9]{16}$/;
const trustedMappings = new WeakSet<object>();

export type ProjectRegistryErrorCode =
  | "INVALID_INPUT" | "UNSAFE_PATH" | "NOT_REPOSITORY" | "UNREGISTERED_WORKTREE"
  | "NOT_REGISTERED" | "IDENTITY_CONFLICT" | "RELOCATION_REQUIRED"
  | "LEGACY_ADOPTION_REQUIRED" | "MEMORY_CONFLICT" | "UNSUPPORTED_DATABASE"
  | "CORRUPT_DATABASE" | "CLOSED" | "STALE_REVISION" | "AUTHORIZATION_REQUIRED";

export class ProjectRegistryError extends Error {
  constructor(readonly code: ProjectRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectRegistryError";
  }
}

export interface NativeMemoryRootInput {
  readonly cliStorageRoot: string;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
}

export interface ProjectRegistryOptions {
  /** Existing application-owned directory. Only mapping metadata is written here. */
  readonly ownedDirectory: string;
  /** Existing trusted Native CLI storage root, not a value extracted from a conversation. */
  readonly nativeStorageRoot: string;
  /** Inject the Native helper; its private key algorithm is not copied into this registry. */
  readonly nativeMemoryRootResolver: (input: NativeMemoryRootInput) => string;
  readonly nativeRuntimeKeyResolver: (workspacePath: string) => string;
}

export interface WorkspaceBinding {
  readonly workspacePath: string;
  readonly gitCommonDir: string;
  readonly gitPrivateDir: string;
  readonly commonIdentity: string;
  readonly privateIdentity: string;
  readonly kind: "main" | "linked";
  readonly worktreeParent: string | null;
  readonly nativeRuntimeKey: string;
  readonly nativePathMemoryKey: string;
}

export interface ProjectMapping {
  readonly projectId: string;
  readonly revision: number;
  readonly gitCommonDir: string;
  readonly commonIdentity: string;
  readonly native: {
    readonly storageRoot: string;
    readonly key: string;
    readonly memoryRoot: string;
    readonly mode: "uuid" | "adopted-legacy";
  };
  readonly workspaces: readonly WorkspaceBinding[];
}

export interface ProjectRelocationRecord {
  readonly operation: "workspace" | "native-storage" | "import";
  readonly projectId: string;
  readonly previousRevision: number | null;
  readonly revision: number;
  readonly occurredAt: string;
  /** Historical metadata, deliberately not branded as a current trusted mapping. */
  readonly before: ProjectMapping | null;
  readonly after: ProjectMapping;
}

interface GitObservation {
  workspacePath: string;
  gitCommonDir: string;
  gitPrivateDir: string;
  commonIdentity: string;
  privateIdentity: string;
  kind: "main" | "linked";
}

export interface ProjectRegistry {
  registerWorkspace(input: { workspacePath: string; adoptLegacy?: boolean }): ProjectMapping;
  /** Read-only resolution rechecks current Git identity. It never creates a new project. */
  resolveWorkspace(workspacePath: string): ProjectMapping;
  /** Mapping lookup only: existence of a row is not evidence that Native memory exists. */
  get(projectId: string): ProjectMapping | undefined;
  list(): readonly ProjectMapping[];
  confirmWorkspaceRelocation(input: { projectId: string; expectedRevision: number; oldWorkspacePath: string;
    newWorkspacePath: string; confirmed: true }): ProjectMapping;
  relocateNativeStorage(input: { projectId: string; expectedRevision: number; nativeStorageRoot: string;
    confirmed: true; verifyTarget: () => void }): ProjectMapping;
  importProjectWorkspace(input: { projectId: string; sourceRevision: number; nativeKey: string;
    mode: "uuid" | "adopted-legacy"; workspacePath: string; nativeStorageRoot: string;
    confirmed: true; verifyTarget: () => void }): ProjectMapping;
  history(projectId: string): readonly ProjectRelocationRecord[];
  close(): void;
}

export function isTrustedProjectMapping(value: unknown): value is ProjectMapping {
  return typeof value === "object" && value !== null && trustedMappings.has(value);
}

/**
 * Reuses the accepted P02 SQLite wrapper. This database stores identity/pointers only;
 * it is separate from the event ledger and never reads, creates or copies topic bytes.
 */
export function openProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  const directory = physicalDirectory(options.ownedDirectory);
  const storageRoot = physicalDirectory(options.nativeStorageRoot);
  if (typeof options.nativeMemoryRootResolver !== "function" || typeof options.nativeRuntimeKeyResolver !== "function") {
    fail("INVALID_INPUT", "Trusted Native key resolvers are required");
  }
  const filename = path.join(directory, "project-registry.sqlite");
  const existed = inspectDatabaseFiles(filename);
  const database = openSQLiteConnection(filename, { readonly: false, timeout: 180 });
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    const application = database.prepare("PRAGMA application_id").get()?.application_id;
    if (existed && ((version !== 1 && version !== SCHEMA_VERSION) || application !== APPLICATION_ID)) {
      fail("UNSUPPORTED_DATABASE", "The existing database is not this registry schema");
    }
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      fail("CORRUPT_DATABASE", "Registry integrity check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) fail("CORRUPT_DATABASE", "Registry foreign key check failed");
    if (existed) validateRegistrySchema(database, version as number);
    if (!existed) {
      database.exec(`BEGIN IMMEDIATE;
        ${PROJECT_SCHEMA}
        ${WORKSPACE_SCHEMA}
        ${RELOCATION_SCHEMA}
        PRAGMA application_id=${APPLICATION_ID};
        PRAGMA user_version=${SCHEMA_VERSION};
        COMMIT;`);
    }
    if (existed && version === 1) {
      // Additive metadata-only migration. DDL, version and rows commit together;
      // never copy a live database or its WAL to make an export bundle.
      database.exec("BEGIN IMMEDIATE");
      const lockedVersion = database.prepare("PRAGMA user_version").get()?.user_version;
      if (lockedVersion !== 1 && lockedVersion !== SCHEMA_VERSION) fail("UNSUPPORTED_DATABASE", "Registry schema changed during migration");
      validateRegistrySchema(database, lockedVersion as number);
      if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) fail("CORRUPT_DATABASE", "Registry foreign key check failed");
      if (lockedVersion === 1) {
        database.exec(`${RELOCATION_SCHEMA} PRAGMA user_version=${SCHEMA_VERSION};`);
      }
      validateRegistrySchema(database, SCHEMA_VERSION);
      if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) fail("CORRUPT_DATABASE", "Registry foreign key check failed");
      database.exec("COMMIT");
    }
    validateRegistrySchema(database, SCHEMA_VERSION);
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) fail("CORRUPT_DATABASE", "Registry foreign key check failed");
    database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    return new SQLiteProjectRegistry(database, directory, storageRoot, Object.freeze({ ...options }));
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    throw error;
  }
}

class SQLiteProjectRegistry implements ProjectRegistry {
  private closed = false;
  private readonly ownedIdentity: string;
  private readonly databaseIdentity: string;
  constructor(
    private readonly database: SQLiteConnection,
    private readonly directory: string,
    private readonly storageRoot: string,
    private readonly options: ProjectRegistryOptions,
  ) {
    this.ownedIdentity = directoryIdentity(directory);
    this.databaseIdentity = directoryIdentity(path.join(directory, "project-registry.sqlite"));
  }

  registerWorkspace(input: { workspacePath: string; adoptLegacy?: boolean }): ProjectMapping {
    this.assertOpen();
    if (input.adoptLegacy !== undefined && typeof input.adoptLegacy !== "boolean") fail("INVALID_INPUT", "Invalid adoption choice");
    const observed = inspectGitWorkspace(input.workspacePath, this.directory);
    let legacy = this.nativeLocation(observed.workspacePath);
    const runtimeKey = boundedText(this.options.nativeRuntimeKeyResolver(observed.workspacePath), 128);
    return this.transaction(() => {
      const remembered = this.workspace(observed.workspacePath);
      if (remembered !== undefined) {
        verifyObservation(remembered, observed);
        return this.requireMapping(text(remembered, "project_id"));
      }
      const rememberedPrivate = this.database.prepare("SELECT * FROM workspaces WHERE private_identity = ?").get(observed.privateIdentity);
      if (rememberedPrivate !== undefined) fail("RELOCATION_REQUIRED", "This worktree identity was registered at another path; confirm relocation first");
      const parent = this.database.prepare("SELECT * FROM projects WHERE common_identity = ?").get(observed.commonIdentity);
      let projectId: string;
      if (parent !== undefined) {
        if (pathKey(text(parent, "common_dir")) !== pathKey(observed.gitCommonDir)) {
          fail("RELOCATION_REQUIRED", "The registered Git common directory moved");
        }
        projectId = text(parent, "project_id");
        const mapping = this.requireMapping(projectId);
        legacy = this.nativeLocation(observed.workspacePath, undefined, mapping.native.storageRoot);
        if (memoryDirectoryExists(legacy.memoryRoot, mapping.native.storageRoot) && pathKey(legacy.memoryRoot) !== pathKey(mapping.native.memoryRoot)) {
          fail("MEMORY_CONFLICT", "This worktree has a distinct legacy memory root; explicit ownership resolution is required");
        }
        this.database.prepare("UPDATE projects SET revision = revision + 1 WHERE project_id = ?").run(projectId);
      } else {
        if (Number(this.database.prepare("SELECT COUNT(*) AS count FROM projects").get()?.count) >= 10_000) fail("INVALID_INPUT", "Registry project limit reached");
        projectId = randomUUID();
        const proposed = this.nativeLocation(observed.workspacePath, projectId);
        const legacyExists = memoryDirectoryExists(legacy.memoryRoot, this.storageRoot);
        if (legacyExists && input.adoptLegacy !== true) fail("LEGACY_ADOPTION_REQUIRED", "An existing Native path-key memory requires explicit adoption");
        if (memoryDirectoryExists(proposed.memoryRoot, this.storageRoot)) fail("MEMORY_CONFLICT", "The proposed UUID memory root already exists without verified ownership");
        const canonical = legacyExists ? legacy : proposed;
        if (this.database.prepare("SELECT project_id FROM projects WHERE canonical_key = ?").get(pathKey(canonical.memoryRoot)) !== undefined) {
          fail("MEMORY_CONFLICT", "A different project already owns this Native key");
        }
        this.database.prepare(`INSERT INTO projects
          (project_id,revision,common_dir,common_identity,storage_root,native_key,canonical_key,mode)
          VALUES (?,1,?,?,?,?,?,?)`).run(projectId, observed.gitCommonDir, observed.commonIdentity,
          this.storageRoot, canonical.key, pathKey(canonical.memoryRoot), legacyExists ? "adopted-legacy" : "uuid");
      }
      this.database.prepare(`INSERT INTO workspaces
        (path_key,workspace_path,project_id,common_dir,private_dir,common_identity,private_identity,kind,native_runtime_key,native_path_memory_key)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(pathKey(observed.workspacePath), observed.workspacePath, projectId,
        observed.gitCommonDir, observed.gitPrivateDir, observed.commonIdentity, observed.privateIdentity, observed.kind, runtimeKey, legacy.key);
      return this.requireMapping(projectId);
    });
  }

  resolveWorkspace(workspacePath: string): ProjectMapping {
    this.assertOpen();
    const observed = inspectGitWorkspace(workspacePath, this.directory);
    const remembered = this.workspace(observed.workspacePath);
    if (remembered === undefined) {
      if (this.database.prepare("SELECT path_key FROM workspaces WHERE private_identity = ?").get(observed.privateIdentity)) {
        fail("RELOCATION_REQUIRED", "The known worktree moved; no alias is silently rewritten");
      }
      fail("NOT_REGISTERED", "Workspace has no accepted project mapping");
    }
    verifyObservation(remembered, observed);
    return this.requireMapping(text(remembered, "project_id"));
  }

  get(projectId: string): ProjectMapping | undefined {
    this.assertOpen();
    if (typeof projectId !== "string" || !UUID.test(projectId)) fail("INVALID_INPUT", "Expected a generated project UUID");
    const row = this.database.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
    return row === undefined ? undefined : this.mapping(row);
  }

  list(): readonly ProjectMapping[] {
    this.assertOpen();
    return Object.freeze(this.database.prepare("SELECT * FROM projects ORDER BY project_id").all().map(row => this.mapping(row)));
  }

  confirmWorkspaceRelocation(input: { projectId: string; expectedRevision: number; oldWorkspacePath: string;
    newWorkspacePath: string; confirmed: true }): ProjectMapping {
    this.assertOpen();
    requireConfirmation(input.confirmed);
    if (typeof input.oldWorkspacePath !== "string" || !path.isAbsolute(input.oldWorkspacePath) || input.oldWorkspacePath.includes("\0")) {
      fail("INVALID_INPUT", "The old workspace must be an absolute path");
    }
    const newObservation = inspectGitWorkspace(input.newWorkspacePath, this.directory);
    return this.transaction(() => {
      const before = this.atRevision(input.projectId, input.expectedRevision);
      const oldBinding = before.workspaces.find(binding => pathKey(binding.workspacePath) === pathKey(input.oldWorkspacePath));
      if (oldBinding === undefined) fail("NOT_REGISTERED", "The old workspace is not bound to this project");
      if (pathKey(oldBinding.workspacePath) === pathKey(newObservation.workspacePath)) fail("INVALID_INPUT", "Relocation requires a new workspace path");
      try { fs.lstatSync(oldBinding.workspacePath); fail("IDENTITY_CONFLICT", "The old workspace path must be vacant before relocation"); }
      catch (error) { if (!missing(error)) throw error; }
      if (newObservation.commonIdentity !== before.commonIdentity || newObservation.privateIdentity !== oldBinding.privateIdentity ||
          newObservation.kind !== oldBinding.kind) fail("IDENTITY_CONFLICT", "Copying or forking is not physical workspace relocation");
      if (this.workspace(newObservation.workspacePath) !== undefined) fail("IDENTITY_CONFLICT", "The target workspace already has a binding");
      // Re-observe every affected binding. A moved common directory must first
      // have its Git worktree backlinks repaired by the explicit operator.
      const observations = before.workspaces.map(binding => {
        const actual = inspectGitWorkspace(binding === oldBinding ? newObservation.workspacePath : binding.workspacePath, this.directory);
        if (actual.commonIdentity !== before.commonIdentity || actual.privateIdentity !== binding.privateIdentity || actual.kind !== binding.kind ||
            pathKey(actual.gitCommonDir) !== pathKey(newObservation.gitCommonDir)) {
          fail("IDENTITY_CONFLICT", "An affected Git worktree changed identity during relocation");
        }
        return actual;
      });
      this.database.prepare("UPDATE projects SET revision = revision + 1, common_dir = ? WHERE project_id = ?")
        .run(newObservation.gitCommonDir, before.projectId);
      for (let index = 0; index < observations.length; index++) {
        const observed = observations[index]!;
        const old = before.workspaces[index]!;
        const legacy = this.nativeLocation(observed.workspacePath, undefined, before.native.storageRoot);
        if (memoryDirectoryExists(legacy.memoryRoot, before.native.storageRoot) && pathKey(legacy.memoryRoot) !== pathKey(before.native.memoryRoot)) {
          fail("MEMORY_CONFLICT", "A relocated workspace has an independent Native memory root");
        }
        this.database.prepare(`UPDATE workspaces SET path_key=?, workspace_path=?, common_dir=?, private_dir=?,
          native_runtime_key=?, native_path_memory_key=? WHERE path_key=?`).run(pathKey(observed.workspacePath), observed.workspacePath,
          observed.gitCommonDir, observed.gitPrivateDir, boundedText(this.options.nativeRuntimeKeyResolver(observed.workspacePath), 128),
          legacy.key, pathKey(old.workspacePath));
      }
      for (const observed of observations) {
        verifyObservation({ common_identity: observed.commonIdentity, private_identity: observed.privateIdentity,
          common_dir: observed.gitCommonDir, private_dir: observed.gitPrivateDir }, inspectGitWorkspace(observed.workspacePath, this.directory));
      }
      const after = this.requireMapping(before.projectId);
      this.recordRelocation("workspace", before, after);
      return after;
    });
  }

  relocateNativeStorage(input: { projectId: string; expectedRevision: number; nativeStorageRoot: string;
    confirmed: true; verifyTarget: () => void }): ProjectMapping {
    this.assertOpen();
    requireConfirmation(input.confirmed, input.verifyTarget);
    const targetRoot = physicalDirectory(input.nativeStorageRoot);
    const targetIdentity = directoryIdentity(targetRoot);
    return this.transaction(() => {
      const before = this.atRevision(input.projectId, input.expectedRevision);
      if (pathKey(targetRoot) === pathKey(before.native.storageRoot)) fail("INVALID_INPUT", "Relocation requires a new Native storage root");
      const memoryRoot = path.join(targetRoot, "memories", "projects", before.native.key, "memory");
      if (this.database.prepare("SELECT project_id FROM projects WHERE canonical_key = ?").get(pathKey(memoryRoot)) !== undefined) {
        fail("MEMORY_CONFLICT", "The target Native pointer is already owned");
      }
      verifySynchronously(input.verifyTarget);
      this.assertOpen();
      physicalDirectory(targetRoot);
      if (directoryIdentity(targetRoot) !== targetIdentity) fail("IDENTITY_CONFLICT", "The target storage directory was replaced");
      this.database.prepare("UPDATE projects SET revision = revision + 1, storage_root = ?, canonical_key = ? WHERE project_id = ?")
        .run(targetRoot, pathKey(memoryRoot), before.projectId);
      const after = this.requireMapping(before.projectId);
      this.recordRelocation("native-storage", before, after);
      verifySynchronously(input.verifyTarget);
      this.assertOpen();
      physicalDirectory(targetRoot);
      if (directoryIdentity(targetRoot) !== targetIdentity) fail("IDENTITY_CONFLICT", "The target storage directory was replaced");
      return after;
    });
  }

  importProjectWorkspace(input: { projectId: string; sourceRevision: number; nativeKey: string;
    mode: "uuid" | "adopted-legacy"; workspacePath: string; nativeStorageRoot: string;
    confirmed: true; verifyTarget: () => void }): ProjectMapping {
    this.assertOpen();
    requireConfirmation(input.confirmed, input.verifyTarget);
    if (typeof input.projectId !== "string" || !UUID.test(input.projectId) || typeof input.nativeKey !== "string" || !NATIVE_KEY.test(input.nativeKey) ||
        (input.mode !== "uuid" && input.mode !== "adopted-legacy") || !Number.isSafeInteger(input.sourceRevision) ||
        input.sourceRevision < 1 || input.sourceRevision >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT", "Invalid import identity metadata");
    const observed = inspectGitWorkspace(input.workspacePath, this.directory);
    const targetRoot = physicalDirectory(input.nativeStorageRoot);
    const targetIdentity = directoryIdentity(targetRoot);
    const memoryRoot = path.join(targetRoot, "memories", "projects", input.nativeKey, "memory");
    return this.transaction(() => {
      if (this.get(input.projectId) !== undefined || this.workspace(observed.workspacePath) !== undefined ||
          this.database.prepare("SELECT project_id FROM projects WHERE common_identity = ?").get(observed.commonIdentity) !== undefined ||
          this.database.prepare("SELECT project_id FROM projects WHERE canonical_key = ?").get(pathKey(memoryRoot)) !== undefined ||
          this.database.prepare("SELECT project_id FROM workspaces WHERE private_identity = ?").get(observed.privateIdentity) !== undefined) {
        fail("IDENTITY_CONFLICT", "Import conflicts with an existing project, workspace or Native pointer");
      }
      if (Number(this.database.prepare("SELECT COUNT(*) AS count FROM projects").get()?.count) >= 10_000) fail("INVALID_INPUT", "Registry project limit reached");
      const legacy = this.nativeLocation(observed.workspacePath, undefined, targetRoot);
      if (memoryDirectoryExists(legacy.memoryRoot, targetRoot) && pathKey(legacy.memoryRoot) !== pathKey(memoryRoot)) {
        fail("MEMORY_CONFLICT", "The target workspace already has an independent legacy memory");
      }
      verifySynchronously(input.verifyTarget);
      this.assertOpen();
      verifyObservation({ common_identity: observed.commonIdentity, private_identity: observed.privateIdentity,
        common_dir: observed.gitCommonDir, private_dir: observed.gitPrivateDir }, inspectGitWorkspace(observed.workspacePath, this.directory));
      physicalDirectory(targetRoot);
      if (directoryIdentity(targetRoot) !== targetIdentity) fail("IDENTITY_CONFLICT", "The import storage directory was replaced");
      this.database.prepare(`INSERT INTO projects (project_id,revision,common_dir,common_identity,storage_root,native_key,canonical_key,mode)
        VALUES (?,?,?,?,?,?,?,?)`).run(input.projectId, input.sourceRevision + 1, observed.gitCommonDir, observed.commonIdentity,
          targetRoot, input.nativeKey, pathKey(memoryRoot), input.mode);
      this.database.prepare(`INSERT INTO workspaces
        (path_key,workspace_path,project_id,common_dir,private_dir,common_identity,private_identity,kind,native_runtime_key,native_path_memory_key)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(pathKey(observed.workspacePath), observed.workspacePath, input.projectId,
          observed.gitCommonDir, observed.gitPrivateDir, observed.commonIdentity, observed.privateIdentity, observed.kind,
          boundedText(this.options.nativeRuntimeKeyResolver(observed.workspacePath), 128), legacy.key);
      const after = this.requireMapping(input.projectId);
      this.recordRelocation("import", null, after, input.sourceRevision);
      verifySynchronously(input.verifyTarget);
      this.assertOpen();
      verifyObservation({ common_identity: observed.commonIdentity, private_identity: observed.privateIdentity,
        common_dir: observed.gitCommonDir, private_dir: observed.gitPrivateDir }, inspectGitWorkspace(observed.workspacePath, this.directory));
      physicalDirectory(targetRoot);
      if (directoryIdentity(targetRoot) !== targetIdentity) fail("IDENTITY_CONFLICT", "The import storage directory was replaced");
      return after;
    });
  }

  history(projectId: string): readonly ProjectRelocationRecord[] {
    this.assertOpen();
    // Validate the UUID even when it has no rows. Historical snapshots remain
    // untrusted provenance; get/resolve produce the only current branded values.
    this.get(projectId);
    return Object.freeze(this.database.prepare("SELECT * FROM project_relocations WHERE project_id = ? ORDER BY sequence").all(projectId).map(row => {
      const operation = text(row, "operation");
      if (operation !== "workspace" && operation !== "native-storage" && operation !== "import") fail("CORRUPT_DATABASE", "Invalid relocation operation");
      const revision = row.revision;
      const previousRevision = row.previous_revision;
      if (!Number.isSafeInteger(revision) || (revision as number) < 1 ||
          (previousRevision !== null && (!Number.isSafeInteger(previousRevision) || (previousRevision as number) < 1))) {
        fail("CORRUPT_DATABASE", "Invalid relocation revision");
      }
      let before: ProjectMapping | null;
      let after: ProjectMapping;
      try {
        before = row.before_json === null ? null : JSON.parse(text(row, "before_json")) as ProjectMapping;
        after = JSON.parse(text(row, "after_json")) as ProjectMapping;
      } catch (cause) { throw new ProjectRegistryError("CORRUPT_DATABASE", "Invalid relocation metadata JSON", { cause }); }
      if (after?.projectId !== projectId || after.revision !== revision || (before !== null && (before.projectId !== projectId || before.revision !== previousRevision))) {
        fail("CORRUPT_DATABASE", "Relocation metadata does not match its row");
      }
      return freezeMetadata<ProjectRelocationRecord>({ operation, projectId, previousRevision: previousRevision as number | null,
        revision: revision as number, occurredAt: text(row, "occurred_at"), before, after });
    }));
  }

  close(): void {
    if (!this.closed) { this.database.close(); this.closed = true; }
  }

  private assertOpen(): void {
    if (this.closed) fail("CLOSED", "Project registry is closed");
    physicalDirectory(this.directory);
    inspectDatabaseFiles(path.join(this.directory, "project-registry.sqlite"));
    if (directoryIdentity(this.directory) !== this.ownedIdentity ||
        directoryIdentity(path.join(this.directory, "project-registry.sqlite")) !== this.databaseIdentity) {
      fail("IDENTITY_CONFLICT", "The owned registry location was replaced while open");
    }
  }

  private transaction<T>(action: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private workspace(workspacePath: string): SQLiteRow | undefined {
    return this.database.prepare("SELECT * FROM workspaces WHERE path_key = ?").get(pathKey(workspacePath));
  }

  private requireMapping(projectId: string): ProjectMapping {
    const mapping = this.get(projectId);
    if (mapping === undefined) fail("CORRUPT_DATABASE", "Workspace refers to an unknown project");
    return mapping;
  }

  private atRevision(projectId: string, expectedRevision: number): ProjectMapping {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail("INVALID_INPUT", "Invalid expected revision");
    const mapping = this.get(projectId);
    if (mapping === undefined) fail("NOT_REGISTERED", "The project has no registered mapping");
    if (mapping.revision !== expectedRevision) fail("STALE_REVISION", "The project mapping changed; obtain fresh ownership confirmation");
    return mapping;
  }

  private recordRelocation(operation: ProjectRelocationRecord["operation"], before: ProjectMapping | null, after: ProjectMapping,
    previousRevision = before?.revision ?? null): void {
    this.database.prepare(`INSERT INTO project_relocations (project_id,operation,previous_revision,revision,occurred_at,before_json,after_json)
      VALUES (?,?,?,?,?,?,?)`).run(after.projectId, operation, previousRevision, after.revision, new Date().toISOString(),
        before === null ? null : JSON.stringify(before), JSON.stringify(after));
  }

  private nativeLocation(workspacePath: string, identity?: string, root = this.storageRoot): { key: string; memoryRoot: string } {
    physicalDirectory(root);
    const resolved = this.options.nativeMemoryRootResolver({ cliStorageRoot: root, workspacePath,
      ...(identity === undefined ? {} : { workspaceIdentity: identity }) });
    if (typeof resolved !== "string" || !path.isAbsolute(resolved)) fail("INVALID_INPUT", "Native resolver must return an absolute path");
    const memoryRoot = path.resolve(resolved);
    const key = path.basename(path.dirname(memoryRoot));
    if (!NATIVE_KEY.test(key) || pathKey(memoryRoot) !== pathKey(path.join(root, "memories", "projects", key, "memory"))) {
      fail("UNSAFE_PATH", "Native resolver returned a path outside the expected Native layout");
    }
    return { key, memoryRoot };
  }

  private mapping(row: SQLiteRow): ProjectMapping {
    const projectId = text(row, "project_id");
    const key = text(row, "native_key");
    const storageRoot = text(row, "storage_root");
    const mode = text(row, "mode");
    const revision = row.revision;
    if (!UUID.test(projectId) || !NATIVE_KEY.test(key) || !path.isAbsolute(storageRoot) ||
        (mode !== "uuid" && mode !== "adopted-legacy") || !Number.isSafeInteger(revision) || (revision as number) < 1) {
      fail("CORRUPT_DATABASE", "Invalid project mapping metadata");
    }
    const memoryRoot = path.join(storageRoot, "memories", "projects", key, "memory");
    if (pathKey(memoryRoot) !== text(row, "canonical_key")) fail("CORRUPT_DATABASE", "Canonical pointer does not match Native key");
    const gitCommonDir = text(row, "common_dir");
    const commonIdentity = text(row, "common_identity");
    const workspaces = this.database.prepare("SELECT * FROM workspaces WHERE project_id = ? ORDER BY path_key").all(projectId).map(binding => {
      const kind = text(binding, "kind");
      if ((kind !== "main" && kind !== "linked") || text(binding, "common_identity") !== commonIdentity ||
          pathKey(text(binding, "common_dir")) !== pathKey(gitCommonDir) || !NATIVE_KEY.test(text(binding, "native_path_memory_key"))) {
        fail("CORRUPT_DATABASE", "Invalid workspace mapping metadata");
      }
      return Object.freeze({ workspacePath: text(binding, "workspace_path"), gitCommonDir,
        gitPrivateDir: text(binding, "private_dir"), commonIdentity, privateIdentity: text(binding, "private_identity"), kind,
        worktreeParent: kind === "linked" ? projectId : null,
        nativeRuntimeKey: text(binding, "native_runtime_key"), nativePathMemoryKey: text(binding, "native_path_memory_key") });
    });
    const mapping: ProjectMapping = Object.freeze({ projectId, revision: revision as number, gitCommonDir, commonIdentity,
      native: Object.freeze({ storageRoot, key, memoryRoot, mode }), workspaces: Object.freeze(workspaces) });
    trustedMappings.add(mapping);
    return mapping;
  }
}

function inspectGitWorkspace(workspacePath: string, ownedDirectory: string): GitObservation {
  const requested = physicalDirectory(workspacePath);
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(ownedDirectory, ".disabled-global-git-config"),
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
  const git = (args: string[]): string => {
    try { return execFileSync("git", ["-c", "core.fsmonitor=false", "-C", requested, ...args],
      { encoding: "utf8", env, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (cause) { throw new ProjectRegistryError("NOT_REPOSITORY", "Cannot inspect the workspace's Git identity", { cause }); }
  };
  const top = physicalDirectory(git(["rev-parse", "--show-toplevel"]).trim());
  if (pathKey(top) !== pathKey(requested)) fail("INVALID_INPUT", "Register the repository/worktree root, not a nested directory");
  const gitCommonDir = physicalDirectory(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  const gitPrivateDir = physicalDirectory(git(["rev-parse", "--absolute-git-dir"]).trim());
  const registered = git(["worktree", "list", "--porcelain", "-z"]).split("\0")
    .filter(field => field.startsWith("worktree ")).map(field => pathKey(field.slice(9)));
  if (!registered.includes(pathKey(top))) fail("UNREGISTERED_WORKTREE", "Git's worktree registry does not point back to this path");
  return { workspacePath: top, gitCommonDir, gitPrivateDir, commonIdentity: directoryIdentity(gitCommonDir),
    privateIdentity: directoryIdentity(gitPrivateDir), kind: pathKey(gitCommonDir) === pathKey(gitPrivateDir) ? "main" : "linked" };
}

function verifyObservation(row: SQLiteRow, actual: GitObservation): void {
  if (text(row, "common_identity") !== actual.commonIdentity || text(row, "private_identity") !== actual.privateIdentity ||
      pathKey(text(row, "common_dir")) !== pathKey(actual.gitCommonDir) || pathKey(text(row, "private_dir")) !== pathKey(actual.gitPrivateDir)) {
    fail("IDENTITY_CONFLICT", "A remembered path now refers to a different physical repository/worktree");
  }
}

function inspectDatabaseFiles(filename: string): boolean {
  let exists = false;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const stat = fs.lstatSync(filename + suffix);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || pathKey(fs.realpathSync.native(filename + suffix)) !== pathKey(filename + suffix)) {
        fail("UNSAFE_PATH", "Registry database files must be unlinked physical files");
      }
      if (suffix === "") exists = true;
    } catch (error) { if (!missing(error)) throw error; }
  }
  return exists;
}

function validateRegistrySchema(database: SQLiteConnection, version: number): void {
  const expected: Record<string, readonly string[]> = {
    projects: ["project_id", "revision", "common_dir", "common_identity", "storage_root", "native_key", "canonical_key", "mode"],
    workspaces: ["path_key", "workspace_path", "project_id", "common_dir", "private_dir", "common_identity", "private_identity", "kind", "native_runtime_key", "native_path_memory_key"],
    ...(version === 2 ? { project_relocations: ["sequence", "project_id", "operation", "previous_revision", "revision", "occurred_at", "before_json", "after_json"] } : {}),
  };
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => row.name);
  if (JSON.stringify(tables) !== JSON.stringify(Object.keys(expected).sort()) ||
      database.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").get() !== undefined) {
    fail("UNSUPPORTED_DATABASE", "Unexpected registry schema objects");
  }
  for (const [table, columns] of Object.entries(expected)) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(columns)) fail("UNSUPPORTED_DATABASE", "Unexpected registry table columns");
  }
  const definitions: Record<string, string> = { projects: PROJECT_SCHEMA, workspaces: WORKSPACE_SCHEMA,
    ...(version === 2 ? { project_relocations: RELOCATION_SCHEMA } : {}) };
  for (const [table, sql] of Object.entries(definitions)) {
    const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
    if (typeof actual !== "string" || normalizeDDL(actual) !== normalizeDDL(sql)) {
      fail("UNSUPPORTED_DATABASE", "Registry constraints differ from the accepted schema");
    }
  }
  const indexes = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
  const expectedIndexes = ["sqlite_autoindex_projects_1", "sqlite_autoindex_projects_2", "sqlite_autoindex_projects_3",
    "sqlite_autoindex_workspaces_1", "sqlite_autoindex_workspaces_2"];
  if (JSON.stringify(indexes.map(row => row.name)) !== JSON.stringify(expectedIndexes) || indexes.some(row => row.sql !== null)) {
    fail("UNSUPPORTED_DATABASE", "Unexpected registry indexes");
  }
}

function normalizeDDL(sql: string): string { return sql.replace(/\s+/g, " ").trim().replace(/;$/, ""); }

function requireConfirmation(confirmed: boolean, verifier?: () => void): void {
  if (confirmed !== true) fail("AUTHORIZATION_REQUIRED", "Explicit ownership confirmation is required");
  if (arguments.length > 1 && typeof verifier !== "function") fail("INVALID_INPUT", "A synchronous target ownership verifier is required");
}

function verifySynchronously(verifier: () => void): void {
  const result: unknown = verifier();
  if (result !== undefined) fail("INVALID_INPUT", "Target verification must complete synchronously and return no value");
}

function freezeMetadata<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}

function memoryDirectoryExists(memoryRoot: string, storageRoot: string): boolean {
  let current = storageRoot;
  for (const component of path.relative(storageRoot, memoryRoot).split(path.sep)) {
    current = path.join(current, component);
    try { physicalDirectory(current); }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  return true;
}

function physicalDirectory(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) fail("INVALID_INPUT", "Expected an absolute physical directory");
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH", "Directories cannot be symlinks or junctions");
  const canonical = fs.realpathSync.native(resolved);
  if (pathKey(resolved) !== pathKey(canonical)) fail("UNSAFE_PATH", "A parent directory resolves through a link");
  return canonical;
}

function directoryIdentity(directory: string): string {
  const stat = fs.statSync(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function text(row: SQLiteRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("CORRUPT_DATABASE", `Invalid mapping field ${field}`);
  return value;
}

function boundedText(value: string, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit || value.includes("\0")) fail("INVALID_INPUT", "Invalid Native runtime key");
  return value;
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function fail(code: ProjectRegistryErrorCode, message: string): never { throw new ProjectRegistryError(code, message); }
