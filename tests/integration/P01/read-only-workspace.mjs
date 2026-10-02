// Derived from the accepted P01-U09 filesystem port. This is an application
// boundary for the local candidate, not an OS sandbox against concurrent actors.
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const READ_METHODS = new Set(["stat", "readText", "readBinary", "readRange"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function checkPath(root, candidate) {
  if (!path.isAbsolute(candidate) || !isInside(root, candidate)) throw new Error("filesystem_scope_denied");
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      // Native Read must retain its ordinary missing-file error.
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw new Error("filesystem_scope_denied");
    }
    if (info.isSymbolicLink() || !isInside(root, realpathSync.native(current))) {
      throw new Error("filesystem_scope_denied");
    }
  }
}

export function createReadOnlyWorkspaceFileSystemPort(basePort, workspaceRoot, createFileSystemError) {
  const physicalRoot = realpathSync.native(workspaceRoot);
  const denied = () => createFileSystemError({ code: "permission_denied", message: "P01 workspace filesystem scope denied" });
  return new Proxy(basePort, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (!READ_METHODS.has(property)) return async () => { throw denied(); };
      return async (request, ...rest) => {
        if (!isRecord(request) || typeof request.path !== "string" || !path.isAbsolute(request.path)) throw denied();
        try { checkPath(physicalRoot, path.resolve(request.path)); }
        catch { throw denied(); }
        return method.call(target, request, ...rest);
      };
    },
  });
}
