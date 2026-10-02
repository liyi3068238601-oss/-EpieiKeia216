// U09 Node-only test guard. This constrains instrumented requests for this
// evaluation; it is not an OS-level network sandbox.
const fs = require("node:fs");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");

const logFile = process.env.P01_GUARD_LOG;
const DENIED_CODE = "P01_EGRESS_DENIED";

function log(entry) {
  if (typeof logFile !== "string" || !require("node:path").isAbsolute(logFile)) {
    throw new Error("P01 guard log path is required");
  }
  fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`, "utf8");
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
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash || value !== url.origin) {
      throw new Error("P01 allowed origins are invalid");
    }
    origins.add(url.origin);
  }
  return origins;
}

const allowedOrigins = loadAllowedOrigins(process.env.P01_ALLOWED_HTTP_ORIGINS);
const allowedEndpoints = new Set([...allowedOrigins].map((origin) => {
  const url = new URL(origin);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  return `${host}|${url.port}`;
}));

function denied(message) {
  const error = new Error(message);
  error.code = DENIED_CODE;
  return error;
}

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
    const parsed = Number(value);
    if (parsed >= 1 && parsed <= 65535) return String(parsed);
  }
  return null;
}

function isAllowedSocketOptions(options) {
  if (!isPlainRecord(options) || (options.path !== undefined && options.path !== null) || Object.hasOwn(options, "lookup")) return false;
  const host = normalizeHost(options.host);
  const port = normalizePort(options.port);
  return host !== null && port !== null && allowedEndpoints.has(`${host}|${port}`);
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = connectOptions(args);
  const allowed = options !== null && isAllowedSocketOptions(options);
  const host = options === null ? "unknown" : normalizeHost(options.host) ?? "unknown";
  const port = options === null ? "unknown" : normalizePort(options.port) ?? "unknown";
  log({ kind: "socket", allowed, target: `${host}:${port}` });
  if (!allowed) throw denied("P01 U09 egress blocked");
  return originalSocketConnect.apply(this, args);
};

function requestOrigin(input) {
  const raw = typeof input === "string" || input instanceof URL
    ? input
    : input !== null && typeof input === "object" && typeof input.url === "string" ? input.url : undefined;
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && !url.username && !url.password && allowedOrigins.has(url.origin)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

const originalFetch = globalThis.fetch;
if (typeof originalFetch !== "function") throw new Error("P01 Node fetch is unavailable");
globalThis.fetch = function (input, ...args) {
  const origin = requestOrigin(input);
  const allowed = origin !== null;
  log({ kind: "request", api: "node.fetch", target: origin ?? "denied", allowed });
  if (!allowed) return Promise.reject(denied("P01 U09 egress blocked"));
  return originalFetch.call(this, input, ...args);
};
syncBuiltinESMExports();
log({ kind: "guard_loaded" });
process.on("uncaughtExceptionMonitor", (error) => {
  log({ kind: "uncaught_error", error_type: error?.name === "Error" ? "Error" : "Unknown" });
});

// A reserved .invalid host verifies that a denied connection never reaches DNS.
const canarySocket = new net.Socket();
try {
  canarySocket.connect({ host: "p01-egress-canary.invalid", port: 443 });
  throw new Error("P01 canary guard bypassed");
} catch (error) {
  if (error?.code !== DENIED_CODE) throw error;
  log({ kind: "egress_canary_denied" });
} finally {
  canarySocket.destroy();
}

globalThis.__p01Guard = true;
