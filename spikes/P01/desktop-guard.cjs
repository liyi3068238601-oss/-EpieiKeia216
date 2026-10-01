// Test instrumentation only. No upstream modification or OS sandbox claim.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { syncBuiltinESMExports } = require('node:module');
const logFile = process.env.P01_GUARD_LOG;
function log(entry) {
  fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, process_type: process.type, ...entry }) + '\n');
}
const httpOrigins = new Set(JSON.parse(process.env.P01_ALLOWED_HTTP_ORIGINS));
const httpPorts = new Set([...httpOrigins].map(value => new URL(value).port));
function local(host) { return ['localhost','127.0.0.1','::1','[::1]'].includes(host); }
function permitted(value) {
  try { const u = new URL(value); return ['file:','data:','devtools:','chrome:','chrome-extension:'].includes(u.protocol) || httpOrigins.has(u.origin); }
  catch { return false; }
}
function checkUrl(value, api) {
  const url = typeof value === 'string' ? value : value?.url;
  const allowed = permitted(url);
  let target = 'unknown';
  try { const u = new URL(url); target = u.origin + u.pathname; } catch {}
  log({ kind: 'request', api, target, allowed });
  if (!allowed) throw new Error('P01 no-Key test blocked outbound request');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  const pipe = opts.path || (typeof args[0] === 'string' && !/^\d+$/.test(args[0]) ? args[0] : null);
  const allowed = pipe ? /^\\\\[.?]\\pipe\\/i.test(pipe) : local(opts.host || 'localhost') && httpPorts.has(String(opts.port));
  log({ kind: 'socket', allowed, target: pipe ? 'local IPC pipe' : String(opts.host || 'localhost') });
  if (!allowed) throw new Error('P01 no-Key test blocked outbound socket');
  return connect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { checkUrl(args[0], 'node.fetch'); return originalFetch(...args); };
syncBuiltinESMExports();
log({ kind: 'guard_loaded' });
process.on('uncaughtExceptionMonitor', error => log({ kind: 'uncaught_error', error_type: error.name, message: error.message }));
// Exercise the socket denial in every instrumented process without sending
// anything. The reserved .invalid hostname is never resolved or connected.
const canarySocket = new net.Socket();
try { canarySocket.connect({ host: 'p01-egress-canary.invalid', port: 443 }); throw new Error('socket guard bypass'); }
catch (error) {
  if (error.message !== 'P01 no-Key test blocked outbound socket') throw error;
  log({ kind: 'egress_canary_denied' });
} finally { canarySocket.destroy(); }
globalThis.__p01Guard = true;
if (process.type === 'browser') {
  const electron = require('electron');
  const request = electron.net.request.bind(electron.net);
  electron.net.request = function (value, ...args) {
    const url = typeof value === 'string' ? value : value.url || `${value.protocol || 'https:'}//${value.hostname || value.host}${value.path || '/'}`;
    checkUrl(url, 'electron.net.request'); return request(value, ...args);
  };
  const fetch = electron.net.fetch.bind(electron.net);
  electron.net.fetch = (...args) => { checkUrl(args[0], 'electron.net.fetch'); return fetch(...args); };
  const fork = electron.utilityProcess.fork.bind(electron.utilityProcess);
  electron.utilityProcess.fork = (modulePath, args, options) => {
    const wrapperRoot = process.env.P01_GUARD_WRAPPERS;
    fs.mkdirSync(wrapperRoot, { recursive: true });
    const wrapper = path.join(wrapperRoot, createHash('sha256').update(modulePath).digest('hex') + '.mjs');
    // Import the native module at its original URL, retaining its own relative
    // resources, parentPort, Loop and services. Only test guards precede it.
    fs.writeFileSync(wrapper, `import ${JSON.stringify(pathToFileURL(__filename).href)};\nimport ${JSON.stringify(pathToFileURL(modulePath).href)};\n`);
    const child = fork(wrapper, args, {
      ...options, execArgv: [...(options?.execArgv || []), '--require=' + __filename],
      env: { ...(options?.env || process.env), P01_GUARD_LOG: logFile,
        P01_ALLOWED_HTTP_ORIGINS: process.env.P01_ALLOWED_HTTP_ORIGINS },
    });
    child.on('spawn', () => log({ kind: 'utility_fork', child_pid: child.pid, modulePath }));
    child.on('exit', exit_code => log({ kind: 'utility_exit', child_pid: child.pid, modulePath, exit_code }));
    return child;
  };
  // Existing Desktop windows start hidden. Suppress only display/focus in this
  // test; their renderer, preload, host and settings services remain native.
  electron.BrowserWindow.prototype.show = function () {};
  electron.BrowserWindow.prototype.showInactive = function () {};
  electron.BrowserWindow.prototype.focus = function () {};
  electron.BrowserWindow.prototype.restore = function () {};
  electron.app.on('browser-window-created', (_event, win) => {
    win.setSkipTaskbar(true); win.hide();
    win.on('show', () => win.hide());
  });
  function guardSession(session) {
    session.webRequest.onBeforeRequest((details, callback) => {
      try { checkUrl(details.url, 'electron.webRequest'); callback({ cancel: false }); }
      catch { callback({ cancel: true }); }
    });
  }
  electron.app.on('session-created', guardSession);
  electron.app.whenReady().then(() => guardSession(electron.session.defaultSession));
}
