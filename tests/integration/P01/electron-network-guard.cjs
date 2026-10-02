// U10 test instrumentation for the Node/Electron request paths; not an OS sandbox.
const fs = require("node:fs");
const childProcess = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");

if (!globalThis.__p01U10GuardInstalled) {
  globalThis.__p01U10GuardInstalled = true;

  const logFile = process.env.P01_GUARD_LOG;
  const DENIED_CODE = "P01_EGRESS_DENIED";
  const processRole = process.env.P01_GUARD_PROCESS_ROLE || process.type || "node";

  function log(entry) {
    if (typeof logFile !== "string" || !path.isAbsolute(logFile)) {
      throw new Error("P01 guard log path is required");
    }
    fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, process_type: process.type, process_role: processRole, ...entry })}\n`, "utf8");
  }

  function normalizedPath(value) {
    if (typeof value !== "string" || !path.isAbsolute(value)) return null;
    return path.resolve(value).toLowerCase();
  }

  const cliEntryPath = process.env.P01_GUARD_CLI_ENTRY;
  const cliEntrySha256 = process.env.P01_GUARD_CLI_ENTRY_SHA256;
  const electronExecutablePath = process.env.P01_GUARD_ELECTRON_EXE;
  const normalizedCliEntry = normalizedPath(cliEntryPath);
  const normalizedElectronExecutable = normalizedPath(electronExecutablePath);
  let loadedCliEntrySha256 = null;
  if (processRole === "cli") {
    const actualEntry = normalizedPath(process.argv[1]);
    if (!normalizedCliEntry || actualEntry !== normalizedCliEntry ||
        !/^[a-f0-9]{64}$/.test(cliEntrySha256 || "")) {
      throw new Error("P01 CLI guard entry identity is invalid");
    }
    loadedCliEntrySha256 = createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
    if (loadedCliEntrySha256 !== cliEntrySha256) throw new Error("P01 CLI guard entry hash mismatch");
  }

  function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function loadAllowedOrigins(serialized) {
    let values;
    try { values = JSON.parse(serialized); } catch { throw new Error("P01 allowed origins are invalid"); }
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string")) {
      throw new Error("P01 allowed origins are invalid");
    }
    const origins = new Set();
    for (const value of values) {
      let url;
      try { url = new URL(value); } catch { throw new Error("P01 allowed origins are invalid"); }
      if (
        url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port ||
        url.pathname !== "/" || url.username || url.password || url.search || url.hash || value !== url.origin
      ) throw new Error("P01 allowed origins are invalid");
      origins.add(url.origin);
    }
    return origins;
  }

  const allowedOrigins = loadAllowedOrigins(process.env.P01_ALLOWED_HTTP_ORIGINS);
  const allowedEndpoints = new Set([...allowedOrigins].map((origin) => {
    const url = new URL(origin);
    return `${url.hostname === "[::1]" ? "::1" : url.hostname}|${url.port}`;
  }));
  const allowedPipePrefix = process.env.P01_ALLOWED_IPC_PIPE_PREFIX;
  const ipcPrefixHeader = "\\\\.\\pipe\\p01-u10-";
  const ipcPrefixSuffix = typeof allowedPipePrefix === "string"
    ? allowedPipePrefix.slice(ipcPrefixHeader.length).toLowerCase()
    : "";
  if (typeof allowedPipePrefix !== "string" || !allowedPipePrefix.toLowerCase().startsWith(ipcPrefixHeader) ||
      !/^[a-z0-9-]{8,}-$/.test(ipcPrefixSuffix)) {
    throw new Error("P01 IPC prefix is invalid");
  }

  function denied() {
    const error = new Error("P01 U10 egress blocked");
    error.code = DENIED_CODE;
    return error;
  }

  // Electron/Node may call Socket.connect with Node's normalized argument tuple.
  function connectOptions(args) {
    if (args.length === 1 && Array.isArray(args[0])) {
      const normalized = args[0];
      if (normalized.length !== 2 || !isPlainRecord(normalized[0]) ||
          (normalized[1] !== null && normalized[1] !== undefined && typeof normalized[1] !== "function")) return null;
      return normalized[0];
    }
    if (args.length < 1 || args.length > 3) return null;
    if (isPlainRecord(args[0])) {
      if (args.length > 1 && typeof args[1] !== "function") return null;
      return args[0];
    }
    if (typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]))) {
      const options = { port: args[0] };
      if (typeof args[1] === "string") options.host = args[1];
      else if (args[1] !== undefined && args[1] !== null && typeof args[1] !== "function") return null;
      if (args.length === 3 && typeof args[2] !== "function") return null;
      return options;
    }
    if (typeof args[0] === "string" && args[0].startsWith("\\\\.\\pipe\\")) return { path: args[0] };
    return null;
  }

  function normalizeHost(value) {
    if (typeof value !== "string" || value.length === 0) return null;
    const host = value.toLowerCase();
    return host === "[::1]" ? "::1" : host;
  }

  function normalizePort(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return String(value);
    if (typeof value === "string" && /^\d{1,5}$/.test(value)) {
      const port = Number(value);
      if (port >= 1 && port <= 65535) return String(port);
    }
    return null;
  }

  function isAllowedSocketOptions(options) {
    if (!isPlainRecord(options) || Object.hasOwn(options, "lookup")) return false;
    if (typeof options.path === "string") {
      return options.path.toLowerCase().startsWith(allowedPipePrefix.toLowerCase());
    }
    if (options.path !== undefined && options.path !== null) return false;
    const host = normalizeHost(options.host);
    const port = normalizePort(options.port);
    return host !== null && port !== null && allowedEndpoints.has(`${host}|${port}`);
  }

  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = connectOptions(args);
    const allowed = options !== null && isAllowedSocketOptions(options);
    const target = options?.path ? "candidate-ipc" :
      options ? `${normalizeHost(options.host) ?? "unknown"}:${normalizePort(options.port) ?? "unknown"}` : "unknown";
    log({ kind: "socket", allowed, target });
    if (!allowed) throw denied();
    return originalSocketConnect.apply(this, args);
  };

  function requestTarget(input) {
    if (typeof input === "string" || input instanceof URL) return String(input);
    if (input !== null && typeof input === "object") {
      if (typeof input.url === "string") return input.url;
      if (typeof input.href === "string") return input.href;
      if (typeof input.hostname === "string" || typeof input.host === "string") {
        const protocol = typeof input.protocol === "string" ? input.protocol : "https:";
        const host = input.hostname ?? input.host;
        const port = input.port ? `:${input.port}` : "";
        const pathname = typeof input.path === "string" ? input.path : "/";
        return `${protocol}//${host}${port}${pathname}`;
      }
    }
    return null;
  }

  function checkRequest(input, api) {
    const raw = requestTarget(input);
    let allowed = false;
    let safeTarget = "denied";
    try {
      const url = new URL(raw);
      if (["file:", "data:", "devtools:", "chrome:", "chrome-extension:"].includes(url.protocol)) {
        allowed = true;
        safeTarget = `internal:${url.protocol}`;
      } else if (url.protocol === "http:" && !url.username && !url.password && allowedOrigins.has(url.origin)) {
        allowed = true;
        safeTarget = url.origin;
      }
    } catch { /* fail closed */ }
    log({ kind: "request", api, target: safeTarget, allowed });
    if (!allowed) throw denied();
  }

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") throw new Error("P01 Node fetch is unavailable");
  globalThis.fetch = function (input, ...args) {
    try { checkRequest(input, "node.fetch"); }
    catch (error) { return Promise.reject(error); }
    return originalFetch.call(this, input, ...args);
  };
  syncBuiltinESMExports();
  log({ kind: "guard_loaded", ...(processRole === "cli" ? { cli_entry_sha256: loadedCliEntrySha256 } : {}) });
  process.on("uncaughtExceptionMonitor", (error) => {
    const errorType = ["Error", "TypeError", "RangeError", "AssertionError"].includes(error?.name) ? error.name : "Unknown";
    const errorCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? error.code : "unknown";
    const message = typeof error?.message === "string" ? error.message.slice(0, 240) : "unknown";
    const stack = typeof error?.stack === "string" ? error.stack.slice(0, 2400) : "unknown";
    log({ kind: "uncaught_error", error_type: errorType, error_code: errorCode, message, stack });
  });

  const canarySocket = new net.Socket();
  canarySocket.on("error", (error) => {
    if (error?.code !== DENIED_CODE) {
      const errorCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? error.code : "unknown";
      log({ kind: "canary_socket_error", error_code: errorCode });
    }
  });
  try {
    canarySocket.connect({ host: "p01-u10-egress-canary.invalid", port: 443 });
    throw new Error("P01 U10 canary guard bypassed");
  } catch (error) {
    if (error?.code !== DENIED_CODE) throw error;
    log({ kind: "egress_canary_denied" });
  } finally { canarySocket.destroy(); }

  globalThis.__p01Guard = true;

  if (process.type === "browser") {
    const electron = require("electron");
    const originalNetRequest = electron.net.request.bind(electron.net);
    electron.net.request = function (input, ...args) {
      checkRequest(input, "electron.net.request");
      return originalNetRequest(input, ...args);
    };
    const originalNetFetch = electron.net.fetch.bind(electron.net);
    electron.net.fetch = function (input, ...args) {
      try { checkRequest(input, "electron.net.fetch"); }
      catch (error) { return Promise.reject(error); }
      return originalNetFetch(input, ...args);
    };

    const originalUtilityFork = electron.utilityProcess.fork.bind(electron.utilityProcess);
    electron.utilityProcess.fork = function (modulePath, args, options = {}) {
      if (typeof modulePath !== "string" || !path.isAbsolute(modulePath)) throw new Error("P01 utility module path invalid");
      const wrappersRoot = process.env.P01_GUARD_WRAPPERS;
      if (typeof wrappersRoot !== "string" || !path.isAbsolute(wrappersRoot)) throw new Error("P01 wrapper path invalid");
      fs.mkdirSync(wrappersRoot, { recursive: true });
      const wrapper = path.join(wrappersRoot, `${createHash("sha256").update(modulePath).digest("hex")}.mjs`);
      fs.writeFileSync(wrapper, `import ${JSON.stringify(pathToFileURL(__filename).href)};\nimport ${JSON.stringify(pathToFileURL(modulePath).href)};\n`);
      const child = originalUtilityFork(wrapper, args, {
        ...options,
        execArgv: [...(options.execArgv ?? []), `--require=${__filename}`],
        env: {
          ...(options.env ?? process.env),
          P01_GUARD_LOG: logFile,
          P01_GUARD_WRAPPERS: wrappersRoot,
          P01_GUARD_PROCESS_ROLE: "utility",
          P01_GUARD_CLI_ENTRY: cliEntryPath,
          P01_GUARD_CLI_ENTRY_SHA256: cliEntrySha256,
          P01_GUARD_ELECTRON_EXE: electronExecutablePath,
          P01_ALLOWED_HTTP_ORIGINS: JSON.stringify([...allowedOrigins]),
          P01_ALLOWED_IPC_PIPE_PREFIX: allowedPipePrefix,
        },
      });
      child.on("spawn", () => log({ kind: "utility_fork", child_pid: child.pid }));
      child.on("exit", (exitCode) => log({ kind: "utility_exit", child_pid: child.pid, exit_code: exitCode }));
      return child;
    };

    for (const method of ["show", "showInactive", "focus", "restore"]) {
      if (typeof electron.BrowserWindow.prototype[method] === "function") {
        electron.BrowserWindow.prototype[method] = function () {};
      }
    }
    electron.app.on("browser-window-created", (_event, window) => {
      window.setSkipTaskbar(true);
      window.hide();
      window.on("show", () => window.hide());
    });

    function guardSession(session) {
      session.webRequest.onBeforeRequest((details, callback) => {
        try { checkRequest(details.url, "electron.webRequest"); callback({ cancel: false }); }
        catch { callback({ cancel: true }); }
      });
    }
    electron.app.on("session-created", (session) => guardSession(session));
    electron.app.whenReady().then(() => guardSession(electron.session.defaultSession));
  }

  if (process.type === "utility" || processRole === "utility") {
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = function (...callArgs) {
      const [command, args, options] = callArgs;
      const matchesExecutable = normalizedPath(command) !== null &&
        normalizedPath(command) === normalizedElectronExecutable;
      const matchesEntry = Array.isArray(args) && normalizedPath(args[0]) !== null &&
        normalizedPath(args[0]) === normalizedCliEntry;
      if (!matchesExecutable || !matchesEntry) return originalSpawn.apply(this, callArgs);

      if (!normalizedCliEntry || !/^[a-f0-9]{64}$/.test(cliEntrySha256 || "") ||
          args.length !== 3 || args[1] !== "app-server" || args[2] !== "--stdio" ||
          !isPlainRecord(options) || !isPlainRecord(options.env) ||
          options.env.ELECTRON_RUN_AS_NODE !== "1" ||
          Object.keys(options.env).some((key) => key.toUpperCase() === "NODE_OPTIONS")) {
        throw new Error("P01 candidate CLI spawn contract is invalid");
      }
      const childEnv = {
        ...options.env,
        P01_GUARD_PROCESS_ROLE: "cli",
        P01_GUARD_CLI_ENTRY: cliEntryPath,
        P01_GUARD_CLI_ENTRY_SHA256: cliEntrySha256,
        P01_GUARD_ELECTRON_EXE: electronExecutablePath,
      };
      const guardedOptions = { ...options, env: childEnv };
      const guardedArgs = ["--require", __filename, ...args];
      const child = originalSpawn.call(this, command, guardedArgs, guardedOptions);
      log({ kind: "cli_spawn_injected", child_pid: child.pid ?? null, cli_entry_sha256: cliEntrySha256 });
      child.once("error", (error) => {
        const errorCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code)
          ? error.code : "unknown";
        log({ kind: "cli_spawn_error", child_pid: child.pid ?? null, error_code: errorCode });
      });
      child.once("exit", (exitCode, signal) => {
        log({ kind: "cli_exit", child_pid: child.pid ?? null,
              exit_code: Number.isInteger(exitCode) ? exitCode : null,
              signal: typeof signal === "string" ? signal : null });
      });
      return child;
    };
    syncBuiltinESMExports();
  }

  if (processRole === "cli") {
    for (const key of ["P01_GUARD_PROCESS_ROLE", "P01_GUARD_CLI_ENTRY", "P01_GUARD_CLI_ENTRY_SHA256",
      "P01_GUARD_ELECTRON_EXE", "P01_GUARD_LOG", "P01_GUARD_WRAPPERS",
      "P01_ALLOWED_HTTP_ORIGINS", "P01_ALLOWED_IPC_PIPE_PREFIX"]) {
      delete process.env[key];
    }
  }
}
