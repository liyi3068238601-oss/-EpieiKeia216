// Composition only: keep the accepted identity gate, Native Loop and read-only tools.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createXiadieZCodeApp } from "../../../dist/packages/adapters/zcode/src/index.js";
import { normalizeRuntimeEvent, canonicalizeEventFacts, projectAttempt } from "../../../dist/packages/contracts/src/events.js";
import { openEventStore } from "../../../dist/packages/storage/events/src/index.js";
import { recoverAttempt, inspectOperation } from "../../../dist/packages/application/recovery/src/index.js";
import { buildTurnDiagnostics } from "../../../dist/packages/diagnostics/src/index.js";

const PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const NATIVE = "zcode.native/v1";
const TRANSCRIPT = "xiadie.transcript/v1";
const MAX_EVENTS = 2048;
const SQLITE_LOADS_KEY = Symbol.for("xiadie.p02.better-sqlite3-loads");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const normalizedPath = (value) => path.resolve(value).toLowerCase();
function inside(root, child) {
  const relative = path.relative(root, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function all(read, query = {}) {
  const rows = [];
  let cursor = 0;
  for (let page = 0; page < 32; page++) {
    const result = read({ ...query, limit: 256, afterCommitSequence: cursor });
    rows.push(...result.items);
    if (!result.hasMore) return rows;
    if (!Number.isSafeInteger(result.nextAfterCommitSequence) || result.nextAfterCommitSequence <= cursor) throw new Error("LEDGER_SCAN_PARTIAL");
    cursor = result.nextAfterCommitSequence;
  }
  throw new Error("LEDGER_SCAN_PARTIAL");
}
function cloneFacade(base, overrides) {
  const result = Object.create(null);
  const keys = new Set();
  for (let current = base; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const key of Reflect.ownKeys(current)) keys.add(key);
  }
  for (const key of keys) {
    if (key === "constructor" || Object.hasOwn(overrides, key)) continue;
    const value = Reflect.get(base, key, base);
    Object.defineProperty(result, key, { configurable: true, enumerable: true,
      ...(typeof value === "function" ? { value: (...args) => value.apply(base, args) } : { get: () => Reflect.get(base, key, base) }) });
  }
  for (const [key, value] of Object.entries(overrides)) Object.defineProperty(result, key, { enumerable: true, value });
  return result;
}

function writeSqliteRuntimeProbe(profileRoot) {
  const probeDirectory = process.env.P02_SQLITE_RUNTIME_PROBE_DIR;
  if (probeDirectory === undefined) return;
  if (!path.isAbsolute(probeDirectory)) throw new Error("SQLITE_RUNTIME_PROBE_PATH_INVALID");
  const expectedDirectory = path.join(profileRoot, "sqlite-runtime-probes");
  const physicalDirectory = path.resolve(probeDirectory);
  if (normalizedPath(physicalDirectory) !== normalizedPath(expectedDirectory) || !existsSync(physicalDirectory)) {
    throw new Error("SQLITE_RUNTIME_PROBE_PATH_INVALID");
  }
  const directoryStat = lstatSync(physicalDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      normalizedPath(realpathSync(physicalDirectory)) !== normalizedPath(expectedDirectory)) {
    throw new Error("SQLITE_RUNTIME_PROBE_PATH_INVALID");
  }
  const loads = globalThis[SQLITE_LOADS_KEY];
  if (!Array.isArray(loads) || loads.length !== 1 || loads[0]?.pid !== process.pid || typeof loads[0]?.path !== "string") {
    throw new Error("SQLITE_RUNTIME_LOAD_UNOBSERVED");
  }
  const addonPath = realpathSync(loads[0].path);
  if (path.basename(addonPath) !== "win32-x64.node" || path.basename(path.dirname(addonPath)) !== "prebuilds") {
    throw new Error("SQLITE_RUNTIME_ADDON_PATH_INVALID");
  }
  const packageRoot = realpathSync(path.dirname(path.dirname(addonPath)));
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== "better-sqlite3" || packageJson.version !== "13.0.3") {
    throw new Error("SQLITE_RUNTIME_PACKAGE_INVALID");
  }
  const runtimeDatabase = new Database(":memory:");
  let sqliteVersion;
  try {
    sqliteVersion = runtimeDatabase.prepare("SELECT sqlite_version() AS version").get().version;
  } finally {
    runtimeDatabase.close();
  }
  if (sqliteVersion !== "3.53.4") throw new Error("SQLITE_RUNTIME_VERSION_INVALID");
  const probe = {
    schema: "p02-sqlite-runtime-binding/v1",
    pid: process.pid,
    processDlopenLoads: loads.map(({ pid, path: filename }) => ({ pid, path: realpathSync(filename) })),
    addonPath,
    addonSha256: sha(readFileSync(addonPath)),
    packageVersion: packageJson.version,
    sqliteVersion,
  };
  writeFileSync(path.join(physicalDirectory, `${process.pid}.json`), `${JSON.stringify(probe, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" });
}

export async function createDurableHost(input) {
  if (!input.enabled) return createXiadieZCodeApp(input);
  const profileRoot = realpathSync(input.ownedProfileRoot);
  const env = input.appOptions.env;
  if (!env || realpathSync(env.TEMP) !== realpathSync(os.tmpdir()) || realpathSync(env.TMP) !== realpathSync(env.TEMP) ||
      !inside(profileRoot, realpathSync(env.TEMP))) throw new Error("OWNED_PROCESS_TEMP_MISMATCH");
  const dataParent = realpathSync(existsSync(input.dataRoot) ? input.dataRoot : path.dirname(input.dataRoot));
  if (!inside(profileRoot, dataParent)) throw new Error("LEDGER_OUTSIDE_OWNED_PROFILE");
  mkdirSync(input.dataRoot, { recursive: true });
  const dataRoot = realpathSync(input.dataRoot);
  if (!inside(profileRoot, dataRoot)) throw new Error("LEDGER_OUTSIDE_OWNED_PROFILE");
  const databasePath = path.join(dataRoot, "event-ledger.sqlite");
  if (existsSync(databasePath) && (!lstatSync(databasePath).isFile() || lstatSync(databasePath).isSymbolicLink())) throw new Error("LEDGER_LINKED_PATH");
  const store = openEventStore({ path: databasePath });
  try {
    writeSqliteRuntimeProbe(profileRoot);
  } catch (error) {
    await store.close();
    throw error;
  }
  const records = [];
  const bindings = new Map();
  const captures = new Map();
  const pending = new Set();
  let active;
  let closing = false;
  let closePromise;
  let nativeApp;
  let host;
  let unsubscribe;
  const recovery = { status: "complete", attempts: [], operations: [], needsReview: false };
  const flag = (binding, code, status = "unavailable") => {
    binding.codes.add(code);
    if (binding.status !== "failed" && binding.status !== "unknown") binding.status = status;
    if (status === "failed" || status === "unknown") binding.status = status;
  };
  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  const settleWrites = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
    await store.drain();
  };
  async function persist(binding, event, origin, capture) {
    try {
      if (++binding.eventCount > MAX_EVENTS) { flag(binding, "EVENT_LIMIT"); return null; }
      const admission = store.append({ event, origin, ...(capture ? { capture } : {}) });
      if (admission.status !== "queued") { flag(binding, "WRITER_ADMISSION_FAILED", "failed"); return null; }
      const result = await admission.completion;
      if (result.status === "unknown") { flag(binding, "WRITER_ACK_UNKNOWN", "unknown"); return null; }
      if (!["committed", "duplicate"].includes(result.status)) { flag(binding, "WRITER_COMMIT_FAILED", "failed"); return null; }
      const receipt = store.queryReceipt({ source: event.source, eventId: event.eventId }, admission.observationKey);
      if (receipt.status !== "found" || receipt.firstReceipt?.canonicalHash !== sha(canonicalizeEventFacts(event)) ||
          receipt.firstReceipt?.commitSequence !== result.firstCommitSequence ||
          receipt.observation?.commitSequence !== result.commitSequence ||
          !["accepted", "duplicate", "redelivery_resequenced"].includes(receipt.observation?.disposition)) {
        flag(binding, "WRITER_RECEIPT_UNVERIFIED", "unknown"); return null;
      }
      return receipt;
    } catch { flag(binding, "WRITER_UNAVAILABLE", "unknown"); return null; }
  }
  function nativeProjection(event) {
    let kind = "fact";
    const payload = { nativeType: event.type };
    if (event.type === "turn_complete") {
      const outcome = event.payload?.resultType;
      kind = outcome === "success" ? "success" : outcome === "cancelled" ? "cancel" :
        typeof outcome === "string" && outcome.startsWith("error_") ? "failure" : null;
      if (!kind) return null;
      payload.resultType = kind;
      if (typeof event.payload?.response === "string") {
        payload.responseSha256 = sha(event.payload.response);
        payload.responseBytes = Buffer.byteLength(event.payload.response);
      }
    } else if (event.type === "turn_error") kind = "failure";
    else if (["tool_call_started", "tool_call_result", "tool_call_error"].includes(event.type)) {
      if (typeof event.payload?.toolCallId === "string") payload.toolCallId = event.payload.toolCallId;
      payload.toolName = event.payload?.toolName === "Read" ? "Read" : "other";
      payload.toolStatus = event.type === "tool_call_started" ? "started" : event.type === "tool_call_result" ? "result" : "error";
    } else if (["hook_run_started", "hook_run_completed", "hook_run_failed", "hook_run_blocked"].includes(event.type))
      payload.hookEventName = event.payload?.hookEventName === "UserPromptSubmit" ? "UserPromptSubmit" : "other";
    else if (event.type !== "turn_started") return null;
    return { kind, payload };
  }
  async function observe(event) {
    let binding;
    try {
      binding = bindings.get(event.turnId);
      if (event.type === "turn_started" && !binding && active && event.sessionId === nativeApp.sessionId && typeof event.turnId === "string") {
        binding = active;
        binding.scope = { sessionId: event.sessionId, turnId: event.turnId, runId: binding.runId, taskId: binding.taskId };
        bindings.set(event.turnId, binding);
      }
      if (!binding) return;
      const projection = nativeProjection(event);
      if (!projection) return;
      if (typeof event.id !== "string" || !(event.timestamp instanceof Date) || !Number.isFinite(event.timestamp.valueOf()) ||
          event.sessionId !== binding.scope.sessionId) { flag(binding, "NATIVE_BINDING_INVALID"); return; }
      if (event.type === "hook_run_started") {
        const descriptor = event.payload?.descriptor;
        if (event.payload?.hookEventName === "UserPromptSubmit" && descriptor?.sourceKind === "plugin" &&
            descriptor.pluginName === "xiadie" && descriptor.executionType === "process" && descriptor.executionMode === "foreground" &&
            typeof descriptor.sourcePath === "string" && inside(normalizedPath(input.installedPluginRoot), normalizedPath(descriptor.sourcePath)) &&
            typeof event.payload?.hookSource === "string" && event.payload.hookSource.length > 0) {
          binding.hooks.push({ id: event.id, occurredAt: event.timestamp.toISOString(), used: false });
        }
      }
      const raw = JSON.stringify(event);
      const normalized = normalizeRuntimeEvent({ source: NATIVE, eventId: event.id, scope: binding.scope, attemptId: binding.attemptId,
        operationId: null, kind: projection.kind, occurredAt: event.timestamp.toISOString(), observedAt: new Date().toISOString(),
        sourceSequence: event.sequenceNumber ?? null, payload: projection.payload });
      await track(persist(binding, normalized, { sourcePin: PIN, historicalLocator: `native-event:${event.id}`,
        rawSha256: sha(raw), rawBytes: Buffer.byteLength(raw), extent: "native-session-event-envelope", rawRetained: false }));
    } catch { if (binding) flag(binding, "NATIVE_EVENT_UNAVAILABLE"); }
  }
  const executionPort = Object.create(input.executionPort);
  Object.defineProperty(executionPort, "run", { value(request, options) {
    try {
      if (request.trace?.attributes?.hookEventName === "UserPromptSubmit" && request.command?.mode === "argv" &&
          request.command.args?.length === 1 && normalizedPath(request.command.args[0]) === normalizedPath(path.join(input.installedPluginRoot, "hooks/context.mjs")) &&
          normalizedPath(request.command.file) === normalizedPath(input.nodeExecutable ?? process.execPath)) {
        const binding = bindings.get(request.trace.turnId);
        const envelope = JSON.parse(typeof request.stdin === "string" ? request.stdin : Buffer.from(request.stdin).toString("utf8"));
        const eligible = binding?.hooks.filter((hook) => !hook.used) ?? [];
        const locator = envelope.transcriptPath ?? envelope.transcript_path;
        if (!binding || eligible.length !== 1 || request.trace.sessionId !== binding.scope.sessionId ||
            (envelope.sessionId ?? envelope.session_id) !== binding.scope.sessionId ||
            (envelope.turnId ?? envelope.turn_id) !== binding.scope.turnId || typeof locator !== "string") throw new Error("CAPTURE_BINDING_INVALID");
        const relative = path.relative(realpathSync(env.TEMP), path.resolve(locator)).split(path.sep).join("/");
        if (!inside(realpathSync(env.TEMP), path.resolve(locator))) throw new Error("CAPTURE_BINDING_INVALID");
        eligible[0].used = true;
        captures.set(JSON.stringify([binding.scope.sessionId, binding.scope.turnId, relative]), { binding, hook: eligible[0] });
      }
    } catch { if (active) flag(active, "CAPTURE_BINDING_INVALID"); }
    return input.executionPort.run.call(input.executionPort, request, options);
  } });
  async function transcriptSink(capture) {
    const correlation = captures.get(JSON.stringify([capture.sessionId, capture.turnId, capture.origin.temporaryLocator]));
    if (!correlation) { if (active) flag(active, "CAPTURE_BINDING_MISSING"); return { status: "failed", code: "CAPTURE_BINDING_MISSING" }; }
    const { binding, hook } = correlation;
    const event = normalizeRuntimeEvent({ source: TRANSCRIPT, eventId: `${hook.id}:${capture.snapshotSha256}`, scope: binding.scope,
      attemptId: binding.attemptId, operationId: null, kind: "fact", occurredAt: hook.occurredAt, observedAt: new Date().toISOString(),
      sourceSequence: null, payload: { nativeHookEventId: hook.id, hookEventName: "UserPromptSubmit", snapshotSha256: capture.snapshotSha256 } });
    const receipt = await track(persist(binding, event, { sourcePin: PIN, historicalLocator: capture.origin.temporaryLocator,
      rawSha256: capture.origin.rawSha256, rawBytes: capture.origin.rawBytes, extent: "current-message", rawRetained: false }, capture));
    if (!receipt) return { status: binding.status === "unknown" ? "unknown" : "failed", code: "CAPTURE_NOT_COMMITTED" };
    binding.captureCount++;
    return { status: "saved", receiptId: String(receipt.firstReceipt.commitSequence), snapshotSha256: capture.snapshotSha256 };
  }
  try {
    const rows = all(store.read.bind(store));
    const targets = new Map();
    const operations = new Map();
    for (const { event } of rows) {
      if ([NATIVE, TRANSCRIPT].includes(event.source) && event.attemptId && Object.values(event.scope).every((value) => typeof value === "string"))
        targets.set(JSON.stringify([event.scope, event.attemptId]), { scope: event.scope, attemptId: event.attemptId });
      if (event.kind === "operation_intent" && event.operationId && event.scope.sessionId && event.scope.taskId)
        operations.set(event.operationId, { owner: { sessionId: event.scope.sessionId, taskId: event.scope.taskId }, operationId: event.operationId });
    }
    if (targets.size + operations.size > 256) throw new Error("RECOVERY_SCAN_LIMIT");
    for (const target of targets.values()) {
      const result = await recoverAttempt(store, target);
      recovery.attempts.push({ ...target, status: result.status, lifecycle: result.projection?.lifecycle ?? "unavailable", needsReview: result.needsReview });
      recovery.needsReview ||= result.needsReview;
    }
    for (const query of operations.values()) {
      const result = inspectOperation(store, query);
      recovery.operations.push({ ...query, status: result.status });
      recovery.needsReview ||= ["unknown", "conflict", "unavailable"].includes(result.status);
    }
  } catch { recovery.status = "unavailable"; recovery.needsReview = true; }
  try {
    host = await createXiadieZCodeApp({ ...input, executionPort, transcriptSink,
      native: { ...input.native, createZCodeApp: async (options) => { nativeApp = await input.native.createZCodeApp(options); return nativeApp; } } });
    unsubscribe = host.app.runtime.subscribeEvents({ onSessionEvent: observe });
  } catch (error) { await store.close(); throw error; }
  const readDurableRecords = () => records.map((item) => Object.freeze({ scope: item.scope ? { ...item.scope } : null,
    attemptId: item.attemptId, status: item.status, lifecycle: item.lifecycle, codes: [...item.codes] }));
  async function finish(binding) {
    try {
      await host.drainTranscripts();
      await settleWrites();
      if (!binding.scope) { flag(binding, "NO_ADMITTED_TURN"); return; }
      const facts = all(store.read.bind(store), { scope: binding.scope });
      if (!facts.some((row) => row.event.attemptId === binding.attemptId)) {
        binding.lifecycle = "unavailable";
        flag(binding, "NO_COMMITTED_HISTORY");
        return;
      }
      let projection = projectAttempt(facts, { scope: binding.scope, attemptId: binding.attemptId });
      if (!projection.terminal && facts.some((row) => row.event.attemptId === binding.attemptId)) {
        const recovered = await recoverAttempt(store, { scope: binding.scope, attemptId: binding.attemptId });
        projection = recovered.projection ?? projection;
        flag(binding, "TERMINAL_RECOVERY_REQUIRED");
      }
      binding.lifecycle = projection.lifecycle;
      const deliveries = host.readTranscriptDeliveries().filter((item) => item.sessionId === binding.scope.sessionId && item.turnId === binding.scope.turnId);
      if (!binding.captureCount || !deliveries.length || deliveries.some((item) => item.status !== "saved")) flag(binding, "CAPTURE_UNAVAILABLE");
      if (!projection.terminal) flag(binding, "TERMINAL_UNAVAILABLE");
      if (!binding.codes.size && projection.terminal && binding.captureCount > 0) binding.status = "saved";
    } catch { flag(binding, "DURABILITY_UNAVAILABLE", "unknown"); }
  }
  function enter(options) {
    if (closing || active) throw new Error("DURABLE_HOST_NOT_IDLE");
    const abort = new AbortController();
    const binding = { runId: `run:${randomUUID()}`, taskId: `task:${randomUUID()}`, attemptId: `attempt:${randomUUID()}`,
      scope: null, status: "unavailable", lifecycle: "unavailable", codes: new Set(), eventCount: 0, captureCount: 0, hooks: [], abort };
    active = binding;
    records.push(binding);
    if (records.length > 256) records.shift();
    const callerSignal = options?.abortSignal;
    return { binding, options: { ...options, abortSignal: callerSignal ? AbortSignal.any([callerSignal, abort.signal]) : abort.signal } };
  }
  function complete(binding, promise) {
    const completion = Promise.resolve(promise).then(async (value) => { await finish(binding); return value; }, async (error) => {
      await finish(binding); throw error;
    }).finally(() => { if (active === binding) active = undefined; });
    binding.completion = completion;
    completion.catch(() => {});
    return completion;
  }
  async function submitPrompt(prompt, options) {
    const operation = enter(options);
    return complete(operation.binding, host.submitPrompt(prompt, operation.options));
  }
  async function sendInput(prompt, options) {
    const operation = enter(options);
    try {
      operation.binding.admission = host.sendInput(prompt, operation.options);
      const result = await operation.binding.admission;
      if (result.kind !== "started_turn") { flag(operation.binding, "NO_ADMITTED_TURN"); active = undefined; return result; }
      return { ...result, completion: complete(operation.binding, result.completion) };
    } catch (error) { await complete(operation.binding, Promise.reject(error)); throw error; }
  }
  async function resume(options) {
    if (closing || active) throw new Error("DURABLE_HOST_NOT_IDLE");
    if (recovery.needsReview) throw new Error("RECOVERY_NEEDS_REVIEW");
    return host.resume(options);
  }
  async function drainDurability() {
    if (active?.admission) await Promise.allSettled([active.admission]);
    if (active?.completion) await Promise.allSettled([active.completion]);
    await host.drainTranscripts();
    await settleWrites();
    return readDurableRecords();
  }
  function close() {
    closePromise ??= (async () => {
      closing = true;
      active?.abort.abort();
      if (active?.admission) await Promise.allSettled([active.admission]);
      if (active?.completion) await Promise.allSettled([active.completion]);
      try { await host.drainTranscripts(); await settleWrites(); await nativeApp.close?.(); }
      finally {
        try { await host.close?.(); }
        finally { unsubscribe?.(); try { await settleWrites(); } finally { await store.close(); } }
      }
    })();
    return closePromise;
  }
  const additions = { submitPrompt, sendInput, compact: (options) => submitPrompt("/compact", options), resume, close, databasePath, readDurableRecords,
    readRecovery: () => structuredClone(recovery), drainDurability,
    exportDiagnostics: (target) => buildTurnDiagnostics({ scope: target.scope, attemptId: target.attemptId, store,
      ...(target.evidenceReports === undefined ? {} : { evidenceReports: target.evidenceReports }),
      ...(target.memoryCandidates === undefined ? {} : { memoryCandidates: target.memoryCandidates }) }) };
  const app = cloneFacade(host.app, additions);
  return { ...host, ...additions, app };
}
