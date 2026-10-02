import fs from "node:fs";
import path from "node:path";

export const PROFILE_SCHEMA_VERSION = 1 as const;
export const DEEPSEEK_OFFICIAL_PROVIDER_ID = "deepseek-official" as const;
export const DEEPSEEK_MODEL_IDS = ["deepseek-flash", "deepseek-v4-pro"] as const;
export const EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE =
  "existing-zcode:deepseek-official" as const;

export type DeepSeekModelId = (typeof DEEPSEEK_MODEL_IDS)[number];
export type CredentialReference = typeof EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE;

/** Portable, non-secret profile settings. Authorization is always per request and never stored here. */
export interface ProfileV1 {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  readonly providerId: typeof DEEPSEEK_OFFICIAL_PROVIDER_ID;
  readonly modelId: DeepSeekModelId;
  readonly networkMode: "offline";
  readonly credentialRef?: CredentialReference;
}

export interface OwnedProfilePaths {
  readonly root: string;
  readonly profileFile: string;
  readonly home: string;
  readonly data: string;
  readonly temp: string;
  readonly workspace: string;
  readonly storage: string;
  readonly userData: string;
  readonly sessionData: string;
  readonly appData: string;
  readonly localAppData: string;
}

export interface ChildEnvironmentOptions {
  /** A caller-owned, already-listening loopback endpoint allocated by the OS. */
  readonly endpointOrigin: string;
  /** Pass only the host values selected by the launcher; this function still applies its own allowlist. */
  readonly systemEnv: Readonly<Record<string, string | undefined>>;
}

const PROFILE_KEYS = new Set([
  "schemaVersion",
  "providerId",
  "modelId",
  "networkMode",
  "credentialRef",
]);
const SYSTEM_ENV_KEYS = ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const;
const PROFILE_DIRECTORY_KEYS = [
  "home",
  "data",
  "temp",
  "workspace",
  "storage",
  "userData",
  "sessionData",
  "appData",
  "localAppData",
] as const;

function invalidProfile(): never {
  throw new Error("Invalid P01 profile");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function validateExistingSegments(root: string, candidate: string, finalKind: "directory" | "file"): void {
  if (!inside(root, candidate)) throw new Error("Profile path is outside the owned root");
  const relative = path.relative(root, candidate);
  if (relative === "") {
    if (finalKind !== "directory") throw new Error("Profile file path is invalid");
    return;
  }

  let current = root;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw new Error("Owned profile path cannot be inspected");
    }
    if (stat.isSymbolicLink()) throw new Error("Owned profile paths cannot contain links");

    let canonical: string;
    try {
      canonical = fs.realpathSync.native(current);
    } catch {
      throw new Error("Owned profile path cannot be resolved");
    }
    if (!inside(root, canonical)) throw new Error("Owned profile path resolves outside the root");

    const isLast = index === segments.length - 1;
    if (!isLast && !stat.isDirectory()) throw new Error("Owned profile path has a non-directory parent");
    if (isLast && finalKind === "directory" && !stat.isDirectory()) {
      throw new Error("Owned profile path is not a directory");
    }
    if (isLast && finalKind === "file" && !stat.isFile()) {
      throw new Error("Owned profile file path is not a file");
    }
  }
}

function normalizeEndpointOrigin(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("P01 endpoint must be an assigned loopback HTTP origin");
  }
  const isLoopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  const port = Number(endpoint.port);
  if (
    endpoint.protocol !== "http:" || !isLoopback || !Number.isInteger(port) ||
    port < 1 || port > 65535 || port === 9229 || endpoint.username || endpoint.password ||
    endpoint.pathname !== "/" || endpoint.search || endpoint.hash
  ) {
    throw new Error("P01 endpoint must be an assigned loopback HTTP origin");
  }
  return endpoint.origin;
}

export function createDefaultProfile(): ProfileV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    providerId: DEEPSEEK_OFFICIAL_PROVIDER_ID,
    modelId: "deepseek-flash",
    networkMode: "offline",
  };
}

export function parseProfileV1(value: unknown): ProfileV1 {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return invalidProfile();
  const keys = Object.keys(value);
  if (keys.some((key) => !PROFILE_KEYS.has(key))) return invalidProfile();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return invalidProfile();
  }

  if (
    value.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    value.providerId !== DEEPSEEK_OFFICIAL_PROVIDER_ID ||
    (value.modelId !== "deepseek-flash" && value.modelId !== "deepseek-v4-pro") ||
    value.networkMode !== "offline"
  ) {
    return invalidProfile();
  }

  const hasCredentialRef = Object.prototype.hasOwnProperty.call(value, "credentialRef");
  if (hasCredentialRef && value.credentialRef !== EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE) {
    return invalidProfile();
  }
  return Object.freeze({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    providerId: DEEPSEEK_OFFICIAL_PROVIDER_ID,
    modelId: value.modelId,
    networkMode: "offline",
    ...(hasCredentialRef ? { credentialRef: EXISTING_DEEPSEEK_CREDENTIAL_REFERENCE } : {}),
  });
}

/** Return a fresh allowlisted document. It intentionally contains no owned paths or authorization. */
export function exportPortableProfile(value: unknown): ProfileV1 {
  return parseProfileV1(value);
}

/** Importing validates the portable document; paths are re-derived from a separately owned root. */
export function importPortableProfile(value: unknown): ProfileV1 {
  return parseProfileV1(value);
}

export function resolveOwnedProfilePaths(ownedRoot: string): OwnedProfilePaths {
  if (typeof ownedRoot !== "string" || !path.isAbsolute(ownedRoot)) {
    throw new Error("Owned profile root must be an absolute existing directory");
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(ownedRoot);
  } catch {
    throw new Error("Owned profile root must be an absolute existing directory");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Owned profile root must be a physical directory");
  }

  let root: string;
  try {
    root = fs.realpathSync.native(ownedRoot);
  } catch {
    throw new Error("Owned profile root cannot be resolved");
  }
  if (path.relative(path.resolve(ownedRoot), root) !== "") {
    throw new Error("Owned profile root cannot resolve through a link");
  }

  const paths: OwnedProfilePaths = {
    root,
    profileFile: path.join(root, "profile.json"),
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    temp: path.join(root, "temp"),
    workspace: path.join(root, "workspace"),
    storage: path.join(root, "storage"),
    userData: path.join(root, "userData"),
    sessionData: path.join(root, "sessionData"),
    appData: path.join(root, "home", "AppData", "Roaming"),
    localAppData: path.join(root, "home", "AppData", "Local"),
  };
  for (const key of PROFILE_DIRECTORY_KEYS) {
    validateExistingSegments(root, paths[key], "directory");
  }
  validateExistingSegments(root, paths.profileFile, "file");
  return Object.freeze(paths);
}

function validateProvidedPaths(paths: OwnedProfilePaths): OwnedProfilePaths {
  if (!isRecord(paths) || typeof paths.root !== "string") {
    throw new Error("Owned profile paths are invalid");
  }
  const resolved = resolveOwnedProfilePaths(paths.root);
  for (const key of Object.keys(resolved) as (keyof OwnedProfilePaths)[]) {
    if (paths[key] !== resolved[key]) throw new Error("Owned profile paths do not match their root");
  }
  return resolved;
}

/** Build a clean child environment; credentials and arbitrary inherited variables are never copied. */
export function buildChildEnvironment(
  pathsValue: OwnedProfilePaths,
  options: ChildEnvironmentOptions,
): Record<string, string> {
  const paths = validateProvidedPaths(pathsValue);
  const endpointOrigin = normalizeEndpointOrigin(options.endpointOrigin);
  const env: Record<string, string> = {};
  for (const key of SYSTEM_ENV_KEYS) {
    const entry = Object.entries(options.systemEnv).find(([name]) => name.toUpperCase() === key);
    const value = entry?.[1];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }

  Object.assign(env, {
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    ZCODE_DATA_BASE_DIR: paths.data,
    ZCODE_STORAGE_DIR: paths.storage,
    ZCODE_DESKTOP_HOME_DIR: paths.home,
    ZCODE_DESKTOP_USER_DATA_DIR: paths.userData,
    ZCODE_DESKTOP_SESSION_DATA_DIR: paths.sessionData,
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
    ZCODE_ENDPOINT_ORIGIN: endpointOrigin,
    ZCODE_BASE_URL: endpointOrigin,
  });
  return env;
}
