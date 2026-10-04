"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function isRegistryExecutable(command) {
  if (typeof command !== "string") return false;
  const normalized = command.trim().replace(/^"|"$/g, "").replaceAll("/", "\\");
  return path.win32.basename(normalized).toLowerCase() === "reg.exe";
}

function requireGuardLogPath(env) {
  const logPath = env.P02_REGISTRY_GUARD_LOG;
  if (typeof logPath !== "string" || !path.win32.isAbsolute(logPath)) {
    throw new Error("P02_REGISTRY_GUARD_LOG must be an absolute path");
  }
  if (!fs.existsSync(path.dirname(logPath))) throw new Error("P02_REGISTRY_GUARD_LOG parent is missing");
  return logPath;
}

function processMetadata(processInfo) {
  return {
    pid: processInfo.pid,
    processType: typeof processInfo.type === "string" ? processInfo.type : null,
    cwd: typeof processInfo.cwd === "function" ? processInfo.cwd() : null,
  };
}

function appendBlockedRequest(logPath, record) {
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

function writeMainProcessSnapshot({ env = process.env, processInfo = process } = {}) {
  const snapshotPath = env.P02_MAIN_PROCESS_SNAPSHOT;
  if (typeof snapshotPath !== "string" || !path.win32.isAbsolute(snapshotPath)) {
    throw new Error("P02_MAIN_PROCESS_SNAPSHOT must be an absolute path");
  }
  if (!fs.existsSync(path.dirname(snapshotPath))) {
    throw new Error("P02_MAIN_PROCESS_SNAPSHOT parent is missing");
  }
  const cwd = processInfo.cwd();
  const argv = Array.isArray(processInfo.argv) ? processInfo.argv : null;
  if (!path.win32.isAbsolute(cwd) || !Array.isArray(argv) || !argv.every((item) => typeof item === "string") ||
      typeof processInfo.execPath !== "string" || !path.win32.isAbsolute(processInfo.execPath)) {
    throw new Error("P02 main process snapshot inputs are invalid");
  }
  const record = {
    schemaVersion: 1,
    pid: processInfo.pid,
    processType: typeof processInfo.type === "string" ? processInfo.type : null,
    cwd,
    execPath: processInfo.execPath,
    defaultApp: processInfo.defaultApp === true,
    argv,
    argvSha256: createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex"),
    argvEntry: typeof argv[1] === "string" ? argv[1] : null,
    resolvedArgvEntry: typeof argv[1] === "string" ? path.resolve(cwd, argv[1]) : null,
  };
  fs.writeFileSync(snapshotPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return record;
}

function installRegistryWriteGuard({
  childProcess = require("node:child_process"),
  env = process.env,
  processInfo = process,
} = {}) {
  const logPath = requireGuardLogPath(env);
  if (!childProcess || typeof childProcess.spawn !== "function") {
    throw new Error("P02 child_process.spawn is unavailable");
  }

  const originalSpawn = childProcess.spawn;
  function guardedSpawn(command, args, options) {
    if (isRegistryExecutable(command)) {
      const rawArgv = [command, ...(Array.isArray(args) ? args : [])];
      const metadata = processMetadata(processInfo);
      const record = {
        schemaVersion: 1,
        kind: "blocked_reg_exe",
        ...metadata,
        cwd: options && typeof options.cwd === "string" ? options.cwd : metadata.cwd,
        rawArgv,
        rawArgvSha256: createHash("sha256").update(JSON.stringify(rawArgv), "utf8").digest("hex"),
      };
      appendBlockedRequest(logPath, record);
      const error = new Error("P02_REGISTRY_WRITE_BLOCKED");
      error.code = "P02_REGISTRY_WRITE_BLOCKED";
      error.p02RegistryWriteBlocked = true;
      throw error;
    }

    return originalSpawn.apply(this, [command, args, options]);
  }

  childProcess.spawn = guardedSpawn;
  return () => {
    if (childProcess.spawn === guardedSpawn) childProcess.spawn = originalSpawn;
  };
}

function installBlockedAppMethod({ app, methodName, code, kind, env, processInfo, result, targetSubkeys }) {
  const logPath = requireGuardLogPath(env);
  if (!app || typeof app[methodName] !== "function") {
    throw new Error(`Electron app.${methodName} is unavailable`);
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(app, methodName);
  if (originalDescriptor && !originalDescriptor.configurable && !originalDescriptor.writable) {
    throw new Error(`Electron app.${methodName} cannot be guarded`);
  }
  const original = app[methodName];
  const guarded = function p02BlockedAppSideEffect(...rawArgs) {
    const metadata = processMetadata(processInfo);
    const record = {
      schemaVersion: 1,
      kind,
      code,
      method: `app.${methodName}`,
      ...metadata,
      rawArgs,
      rawArgsSha256: createHash("sha256").update(JSON.stringify(rawArgs), "utf8").digest("hex"),
      ...(targetSubkeys ? { expectedRegistrySubkeys: targetSubkeys } : {}),
      returnValue: result === undefined ? null : result,
      returnType: result === undefined ? "undefined" : typeof result,
      blocked: true,
    };
    appendBlockedRequest(logPath, record);
    return result;
  };

  Object.defineProperty(app, methodName, {
    configurable: true,
    enumerable: originalDescriptor?.enumerable ?? false,
    writable: true,
    value: guarded,
  });
  if (app[methodName] !== guarded) {
    throw new Error(`Electron app.${methodName} guard could not be installed`);
  }
  return () => {
    if (app[methodName] !== guarded) return;
    if (originalDescriptor) Object.defineProperty(app, methodName, originalDescriptor);
    else delete app[methodName];
  };
}

const PROTOCOL_REGISTRY_SUBKEYS = [
  "Software\\Classes\\zcode",
  "Software\\Classes\\zcode\\DefaultIcon",
  "Software\\Classes\\zcode\\shell",
  "Software\\Classes\\zcode\\shell\\open",
  "Software\\Classes\\zcode\\shell\\open\\command",
];

/*
 * Keep this preload policy narrow: these are the methods observed in the
 * frozen Native startup path. The wrapper returns failure/void so Native's
 * own failure reporting runs, and never claims that an OS operation succeeded.
 */
function installDefaultProtocolClientGuard({ app, env = process.env, processInfo = process } = {}) {
  const methods = [
    {
      methodName: "setAsDefaultProtocolClient",
      kind: "blocked_default_protocol_registration",
      code: "P02_DEFAULT_PROTOCOL_REGISTRATION_BLOCKED",
      result: false,
      targetSubkeys: PROTOCOL_REGISTRY_SUBKEYS,
    },
    {
      methodName: "removeAsDefaultProtocolClient",
      kind: "blocked_default_protocol_removal",
      code: "P02_DEFAULT_PROTOCOL_REMOVAL_BLOCKED",
      result: false,
      targetSubkeys: PROTOCOL_REGISTRY_SUBKEYS,
    },
    {
      methodName: "clearRecentDocuments",
      kind: "blocked_clear_recent_documents",
      code: "P02_CLEAR_RECENT_DOCUMENTS_BLOCKED",
      result: undefined,
    },
  ];
  for (const { methodName } of methods) {
    if (!app || typeof app[methodName] !== "function") {
      throw new Error(`Electron app.${methodName} is unavailable`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(app, methodName);
    if (descriptor && !descriptor.configurable && !descriptor.writable) {
      throw new Error(`Electron app.${methodName} cannot be guarded`);
    }
  }

  const uninstall = [];
  try {
    for (const method of methods) {
      uninstall.push(installBlockedAppMethod({
        app,
        ...method,
        env,
        processInfo,
      }));
    }
  } catch (error) {
    uninstall.reverse().forEach((restore) => restore());
    throw error;
  }
  return () => uninstall.reverse().forEach((restore) => restore());
}

module.exports = {
  installDefaultProtocolClientGuard,
  installRegistryWriteGuard,
  isRegistryExecutable,
  writeMainProcessSnapshot,
};
