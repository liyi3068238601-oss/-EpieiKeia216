import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openSQLiteConnection, type SQLiteConnection, type SQLiteRow } from "../storage/events/src/sqlite.js";

const APPLICATION_ID = 0x58495052;
const SCHEMA_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NATIVE_KEY = /^[a-z0-9._-]{1,48}-[a-f0-9]{16}$/;
const trustedMappings = new WeakSet<object>();

export type ProjectRegistryErrorCode =
  | "INVALID_INPUT" | "UNSAFE_PATH" | "NOT_REPOSITORY" | "UNREGISTERED_WORKTREE"
  | "NOT_REGISTERED" | "IDENTITY_CONFLICT" | "RELOCATION_REQUIRED"
  | "LEGACY_ADOPTION_REQUIRED" | "MEMORY_CONFLICT" | "UNSUPPORTED_DATABASE"
  | "CORRUPT_DATABASE" | "CLOSED";

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
    if (existed && (version !== SCHEMA_VERSION || application !== APPLICATION_ID)) {
      fail("UNSUPPORTED_DATABASE", "The existing database is not this registry schema");
    }
    if (!existed) {
      database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK(revision > 0),
          common_dir TEXT NOT NULL,
          common_identity TEXT NOT NULL UNIQUE,
          storage_root TEXT NOT NULL,
          native_key TEXT NOT NULL,
          canonical_key TEXT NOT NULL UNIQUE,
          mode TEXT NOT NULL CHECK(mode IN ('uuid','adopted-legacy'))
        ) STRICT;
        CREATE TABLE workspaces (
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
        ) STRICT;
        PRAGMA application_id=${APPLICATION_ID};
        PRAGMA user_version=${SCHEMA_VERSION};
        COMMIT;`);
    }
    if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      fail("CORRUPT_DATABASE", "Registry integrity check failed");
    }
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
    const legacy = this.nativeLocation(observed.workspacePath);
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
        if (memoryDirectoryExists(legacy.memoryRoot, this.storageRoot) && pathKey(legacy.memoryRoot) !== pathKey(mapping.native.memoryRoot)) {
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

  private nativeLocation(workspacePath: string, identity?: string): { key: string; memoryRoot: string } {
    physicalDirectory(this.storageRoot);
    const resolved = this.options.nativeMemoryRootResolver({ cliStorageRoot: this.storageRoot, workspacePath,
      ...(identity === undefined ? {} : { workspaceIdentity: identity }) });
    if (typeof resolved !== "string" || !path.isAbsolute(resolved)) fail("INVALID_INPUT", "Native resolver must return an absolute path");
    const memoryRoot = path.resolve(resolved);
    const key = path.basename(path.dirname(memoryRoot));
    if (!NATIVE_KEY.test(key) || pathKey(memoryRoot) !== pathKey(path.join(this.storageRoot, "memories", "projects", key, "memory"))) {
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
