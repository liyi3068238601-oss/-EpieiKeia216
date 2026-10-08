import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";

const FILENAME = "p03-memory-audit.jsonl";
const IDENTITIES = new Map();
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | NOFOLLOW;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | NOFOLLOW;

function key(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function reject(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function physicalRoot(profileRoot) {
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot)) reject("P03_MEMORY_AUDIT_ROOT_INVALID");
  const requested = path.resolve(profileRoot);
  const requestedInfo = lstatSync(requested, { bigint: true });
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) reject("P03_MEMORY_AUDIT_ROOT_INVALID");
  const actual = realpathSync(requested);
  const actualInfo = lstatSync(actual, { bigint: true });
  if (!actualInfo.isDirectory() || actualInfo.isSymbolicLink() || key(realpathSync(actual)) !== key(actual)) {
    reject("P03_MEMORY_AUDIT_ROOT_INVALID");
  }
  return actual;
}

function regularSingleLink(info) {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1n;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathIdentity(filename, root, expected) {
  const entry = lstatSync(filename, { bigint: true });
  if (!regularSingleLink(entry)) reject("P03_MEMORY_AUDIT_PATH_INVALID");
  const actual = realpathSync(filename);
  if (key(actual) !== key(filename) || !inside(root, actual)) reject("P03_MEMORY_AUDIT_PATH_INVALID");
  if (expected && !sameIdentity(entry, expected)) reject("P03_MEMORY_AUDIT_IDENTITY_CHANGED");
  return entry;
}

function verifyDescriptor(descriptor, profileRoot, root, filename, expected) {
  if (key(physicalRoot(profileRoot)) !== key(root)) reject("P03_MEMORY_AUDIT_ROOT_CHANGED");
  const entry = pathIdentity(filename, root, expected);
  const opened = fstatSync(descriptor, { bigint: true });
  if (!regularSingleLink(opened) || !sameIdentity(opened, entry) || (expected && !sameIdentity(opened, expected))) {
    reject("P03_MEMORY_AUDIT_IDENTITY_CHANGED");
  }
  return { dev: opened.dev, ino: opened.ino };
}

/** Open this Host's own append descriptor for the fixed profile audit log. */
export function openProjectMemoryAudit(profileRoot) {
  const root = physicalRoot(profileRoot);
  const filename = path.join(root, FILENAME);
  const mapKey = key(filename);
  const knownIdentity = IDENTITIES.get(mapKey);
  let descriptor;
  try {
    if (knownIdentity) {
      pathIdentity(filename, root, knownIdentity);
      descriptor = openSync(filename, APPEND_FLAGS);
      verifyDescriptor(descriptor, profileRoot, root, filename, knownIdentity);
      return descriptor;
    }

    // An existing file without an in-process identity is deliberately refused with EEXIST.
    descriptor = openSync(filename, CREATE_FLAGS, 0o600);
    const identity = verifyDescriptor(descriptor, profileRoot, root, filename);
    IDENTITIES.set(mapKey, Object.freeze(identity));
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the validation error */ }
    }
    throw error;
  }
}
