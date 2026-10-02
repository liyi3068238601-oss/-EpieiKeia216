import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTurnEventCollector } from "../../../dist/packages/application/turn-projection.js";

const runnerDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(runnerDirectory, "../../../");
const casesPath = path.join(runnerDirectory, "cases.json");
const casesDocument = JSON.parse(readFileSync(casesPath, "utf8"));
const casesById = new Map(casesDocument.scenarios.map((scenario) => [scenario.id, scenario]));
const nativeSourceCommit = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const nativeSourceRoot = process.env.P01_U09_ZCODE_SOURCE ?? "E:/Xiadie/Xiadie/.runtime/P00/zcode/source";
const MAX_CAPTURE_BYTES = 128 * 1024;
const READ_METHODS = new Set(["stat", "readTextFile", "readBinaryFile", "readTextFileRange"]);
const TERMINAL_TOOL_EVENTS = new Set(["tool_call_result", "tool_call_error", "hook_run_blocked"]);
const SAFE_ENV_KEYS = new Set([
  "APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "PATHEXT", "PATH", "SYSTEMROOT", "TEMP", "TMP",
  "USERPROFILE", "WINDIR", "ZCODE_BASE_URL", "ZCODE_DATA_BASE_DIR", "ZCODE_DESKTOP_HOME_DIR",
  "ZCODE_DESKTOP_SESSION_DATA_DIR", "ZCODE_DESKTOP_USER_DATA_DIR", "ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT",
  "ZCODE_ENDPOINT_ORIGIN", "ZCODE_STORAGE_DIR",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateRelayOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid_relay_origin"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid_relay_origin");
  }
  return url.origin;
}

export function validateNativeSpec(value) {
  if (!isRecord(value)) throw new Error("invalid_spec");
  const keys = new Set(["mode", "model", "scenario", "profile_root", "relay_origin", "output_dir", "system_env"]);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error("invalid_spec");
  if (value.mode !== "mock" && value.mode !== "real") throw new Error("invalid_mode");
  if (!casesDocument.models.includes(value.model)) throw new Error("invalid_model");
  if (!isRecord(value.scenario)) throw new Error("invalid_scenario");
  const scenarioKeys = new Set(["id", "prompt", "max_requests", "target"]);
  if (Object.keys(value.scenario).some((key) => !scenarioKeys.has(key))) throw new Error("invalid_scenario");
  const expected = casesById.get(value.scenario.id);
  if (!expected || expected.prompt !== value.scenario.prompt || expected.max_requests !== value.scenario.max_requests ||
      expected.target !== value.scenario.target) throw new Error("scenario_does_not_match_cases");
  if (typeof value.profile_root !== "string" || !path.isAbsolute(value.profile_root)) throw new Error("invalid_profile_root");
  if (typeof value.output_dir !== "string" || !path.isAbsolute(value.output_dir)) throw new Error("invalid_output_dir");
  if (!isRecord(value.system_env)) throw new Error("invalid_system_environment");
  const actualEnvKeys = Object.keys(value.system_env).map((key) => key.toUpperCase());
  if (actualEnvKeys.some((key) => !["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].includes(key))) {
    throw new Error("invalid_system_environment");
  }
  return { ...value, relay_origin: validateRelayOrigin(value.relay_origin) };
}

export function createLocalProvider(modelId, relayOrigin) {
  const origin = validateRelayOrigin(relayOrigin);
  return {
    providerId: "p01-u09-loopback",
    providerName: "P01 U09 loopback relay",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "p01-u09-loopback-only" },
      api: { type: "openai-chat-completions", baseUrl: `${origin}/v1` },
      builtinModelIds: [],
      personalModelIds: [modelId],
      modelOrder: [modelId],
      visibility: "visible",
    },
    models: [{
      modelId,
      config: {
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 65536,
          inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
        },
        optionSpecs: {
          reasoningLevel: { values: ["disabled"], map: '{"thinking":{"type":"disabled"}}' },
          maxOutputTokens: { max: 1024, map: "{\"max_tokens\":maxOutputTokens}" },
        },
      },
    }],
  };
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertPhysicalPathInside(root, candidate) {
  if (!path.isAbsolute(candidate) || !pathIsInside(root, candidate)) throw new Error("filesystem_scope_denied");
  const relative = path.relative(root, candidate);
  if (relative === "") return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
      throw new Error("filesystem_scope_denied");
    }
    if (info.isSymbolicLink()) throw new Error("filesystem_scope_denied");
    let canonical;
    try { canonical = realpathSync.native(current); }
    catch { throw new Error("filesystem_scope_denied"); }
    if (!pathIsInside(root, canonical)) throw new Error("filesystem_scope_denied");
  }
}

export function createReadOnlyWorkspaceFileSystemPort(basePort, workspaceRoot, createFileSystemError) {
  const physicalRoot = realpathSync.native(workspaceRoot);
  const denied = () => createFileSystemError({
    code: "permission_denied",
    message: "P01 fixture filesystem scope denied",
  });
  return new Proxy(basePort, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") return method;
      if (!READ_METHODS.has(property)) return async () => { throw denied(); };
      return async (request, ...rest) => {
        if (!isRecord(request) || typeof request.path !== "string") throw denied();
        const candidate = path.resolve(request.path);
        try { assertPhysicalPathInside(physicalRoot, candidate); }
        catch { throw denied(); }
        return method.call(target, request, ...rest);
      };
    },
  });
}

function eventRecord(value) {
  if (!isRecord(value)) return undefined;
  return value;
}

function getPayload(event) {
  return isRecord(event?.payload) ? event.payload : {};
}

function eventTurnId(event, payload) {
  return typeof event?.turnId === "string" ? event.turnId :
    typeof payload.turnId === "string" ? payload.turnId : null;
}

export function createNativeEventObserver({ scenarioId, sessionId, collector, receiptsPath }) {
  const toolNames = new Map();
  const seen = new Set();
  const receipts = [];
  const scheduled = [];
  let journalFailure = false;
  const onSessionEvent = (value) => {
    const event = eventRecord(value);
    if (!event || typeof event.type !== "string") return;
    try { collector?.onSessionEvent(value); } catch { journalFailure = true; }
    const payload = getPayload(event);
    const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
    if (callId && toolName && ["tool_call_scheduled", "tool_call_started", "tool_call_progress"].includes(event.type)) {
      toolNames.set(callId, toolName);
      scheduled.push({
        sessionId: typeof event.sessionId === "string" ? event.sessionId : sessionId,
        turnId: eventTurnId(event, payload),
        toolCallId: callId,
        toolName,
      });
    }
    if (!callId || !TERMINAL_TOOL_EVENTS.has(event.type)) return;
    const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : sessionId;
    const turnId = eventTurnId(event, payload);
    const success = event.type === "tool_call_result" && typeof payload.result?.success === "boolean"
      ? payload.result.success
      : event.type === "tool_call_error" ? false : null;
    const receipt = {
      scenario_id: scenarioId,
      session_id: eventSessionId,
      turn_id: turnId,
      tool_call_id: callId,
      tool_name: toolName ?? toolNames.get(callId) ?? null,
      event_type: event.type,
      result_success: success,
    };
    const identity = typeof event.id === "string" && event.id.length > 0
      ? `id:${event.id}`
      : `${eventSessionId}:${turnId}:${callId}:${event.type}:${event.sequenceNumber ?? ""}:${success}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    try {
      appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, "utf8");
      receipts.push(receipt);
    } catch {
      journalFailure = true;
    }
  };
  return {
    onSessionEvent,
    receipts,
    scheduled,
    get journalFailure() { return journalFailure; },
    toolNames,
  };
}

function flattenRequestText(messages) {
  const chunks = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message)) continue;
    if (typeof message.content === "string") chunks.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") chunks.push(block.text);
      }
    }
  }
  return chunks.join("\\n");
}

function safeHookReceipt(value) {
  if (!isRecord(value)) return null;
  const character = isRecord(value.character) ? value.character : {};
  return {
    version: value.version,
    nonce: value.nonce,
    event: value.event,
    sessionId: value.sessionId,
    turnId: value.turnId,
    packetSha256: value.packetSha256,
    transcriptBytes: value.transcriptBytes,
    transcriptSha256: value.transcriptSha256,
    character: {
      id: character.id,
      version: character.version,
      contentSha256: character.contentSha256,
    },
  };
}

export function createObservedNativeModelAdapter(delegate, getNativeContext, getLastHookEnvelope, scenarioId, contextsPath) {
  const state = { requestIndex: 0, contexts: [] };
  const observeModel = (model) => {
    const observed = Object.create(model);
    Object.defineProperties(observed, {
      bind: { value: (options) => observeModel(model.bind.call(model, options)) },
      generateText: { value: (request) => {
        observeCall(request);
        return model.generateText.call(model, request);
      } },
      streamText: { value: (request) => {
        observeCall(request);
        return model.streamText.call(model, request);
      } },
    });
    return observed;
  };
  const observeCall = (request) => {
    const context = getNativeContext();
    const trace = context?.traceContext;
    const envelope = getLastHookEnvelope();
    const canonicalPacket = typeof envelope?.additionalContext === "string" ? envelope.additionalContext : "";
    const receipt = safeHookReceipt(envelope?.xiadieReceipt);
    const hasCanonicalPacket = canonicalPacket.length > 0 && flattenRequestText(request?.messages).includes(canonicalPacket);
    const receiptMatches = receipt?.event === "UserPromptSubmit" && receipt.sessionId === trace?.sessionId &&
      receipt.turnId === trace?.turnId && receipt.character?.contentSha256 === casesDocument.runtime_persona.sha256;
    const row = {
      scenario_id: scenarioId,
      session_id: typeof trace?.sessionId === "string" ? trace.sessionId : null,
      turn_id: typeof trace?.turnId === "string" ? trace.turnId : null,
      request_index: ++state.requestIndex,
      canonical_packet: canonicalPacket,
      receipt,
      operation: typeof context?.modelCall?.operation === "string" ? context.modelCall.operation : null,
      has_canonical_packet: hasCanonicalPacket,
      receipt_matches_invocation: receiptMatches,
    };
    state.contexts.push(row);
    appendFileSync(contextsPath, `${JSON.stringify(row)}\n`, "utf8");
    if (!row.session_id || !row.turn_id || !hasCanonicalPacket || !receiptMatches) {
      throw new Error("native_model_context_unverified");
    }
  };
  const adapter = Object.create(delegate);
  Object.defineProperties(adapter, {
    createModel: { value: (options) => observeModel(delegate.createModel.call(delegate, options)) },
    addStatusSink: { value: (sink) => delegate.addStatusSink.call(delegate, sink) },
    setModelIoFullRetentionEnabled: { value: (enabled) => delegate.setModelIoFullRetentionEnabled.call(delegate, enabled) },
  });
  return { adapter, contexts: state.contexts };
}

function currentReadCallIds(events, sessionId, turnId) {
  const ids = new Set();
  for (const value of events ?? []) {
    const event = eventRecord(value);
    if (!event) continue;
    const payload = getPayload(event);
    const eventSession = typeof event.sessionId === "string" ? event.sessionId : payload.sessionId;
    if (eventSession !== sessionId || eventTurnId(event, payload) !== turnId) continue;
    const normalizedReceipt = typeof event.toolCallId === "string";
    if (!normalizedReceipt && !["tool_call_scheduled", "tool_call_started", "tool_call_progress"].includes(event.type)) continue;
    const name = typeof event.toolName === "string" ? event.toolName :
      typeof payload.toolName === "string" ? payload.toolName : undefined;
    const callId = typeof event.toolCallId === "string" ? event.toolCallId :
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    if (name === "Read" && callId) ids.add(callId);
  }
  return [...ids];
}

function inspectBridge(spec, bridge) {
  if (!isRecord(bridge) || !isRecord(bridge.env) || !isRecord(bridge.paths) || !isRecord(bridge.profile)) {
    throw new Error("invalid_profile_bridge_output");
  }
  if (bridge.profile.modelId !== spec.model || bridge.profile.networkMode !== "offline") throw new Error("profile_model_mismatch");
  if (path.resolve(bridge.paths.root) !== path.resolve(spec.profile_root)) throw new Error("profile_root_mismatch");
  if (bridge.env.ZCODE_ENDPOINT_ORIGIN !== spec.relay_origin || bridge.env.ZCODE_BASE_URL !== spec.relay_origin) {
    throw new Error("profile_relay_mismatch");
  }
  for (const [key, value] of Object.entries(bridge.env)) {
    if (!SAFE_ENV_KEYS.has(key) || typeof value !== "string" || /(?:API[_-]?KEY|TOKEN|SECRET|AUTHORIZATION)/i.test(key)) {
      throw new Error("profile_environment_rejected");
    }
  }
  const decision = bridge.credential_decision?.decision;
  if (spec.mode === "mock" && (decision !== "no-key" || Object.hasOwn(bridge.profile, "credentialRef"))) {
    throw new Error("mock_profile_must_be_no_key");
  }
  if (spec.mode === "real" && decision !== "authorized") throw new Error("real_profile_not_authorized");
  return bridge;
}

function readOnlyModelRuntimeEnv(environment) {
  const keys = Object.keys(environment);
  if (keys.some((key) => !SAFE_ENV_KEYS.has(key))) throw new Error("unsafe_runtime_environment");
  return { ...environment };
}

function assertPinnedSource(environment) {
  const head = spawnSync("git", ["-C", nativeSourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true, env: environment });
  if (head.status !== 0 || head.stdout.trim() !== nativeSourceCommit) throw new Error("native_source_commit_mismatch");
  const status = spawnSync("git", ["-C", nativeSourceRoot, "status", "--porcelain"], { encoding: "utf8", windowsHide: true, env: environment });
  if (status.status !== 0 || status.stdout.trim() !== "") throw new Error("native_source_dirty");
}

function verifyAssets() {
  const personaPath = path.join(repositoryRoot, casesDocument.runtime_persona.path);
  const manifestPath = path.join(repositoryRoot, casesDocument.runtime_persona.manifest_path);
  if (hash(readFileSync(personaPath)) !== casesDocument.runtime_persona.sha256 ||
      hash(readFileSync(manifestPath)) !== casesDocument.runtime_persona.manifest_sha256) {
    throw new Error("runtime_persona_asset_mismatch");
  }
}

function verifyFixture(spec, workspace) {
  const target = spec.scenario.target;
  const allowedNames = new Set(["readme.txt", "missing.txt"]);
  if (target !== undefined && !allowedNames.has(target)) throw new Error("fixture_target_rejected");
  const readmePath = path.join(workspace, "readme.txt");
  if (lstatSync(readmePath).isSymbolicLink() || !lstatSync(readmePath).isFile()) throw new Error("fixture_readme_invalid");
  const readmeBytes = readFileSync(readmePath);
  const expected = Buffer.from("P01_ONLY_READ_VALUE=orchid-42\n", "utf8");
  if (!readmeBytes.equals(expected)) throw new Error("fixture_readme_mismatch");
  const missingPath = path.join(workspace, "missing.txt");
  if (existsSync(missingPath)) throw new Error("fixture_missing_file_exists");
  if (target === "readme.txt" && !casesById.get(spec.scenario.id)?.fixture) throw new Error("unexpected_fixture_target");
  if (target === "missing.txt" && casesById.get(spec.scenario.id)?.fixture?.expected_exists !== false) {
    throw new Error("unexpected_fixture_target");
  }
  return {
    target: target ?? null,
    readme_sha256: hash(readmeBytes),
    missing_exists: false,
    agents_sha256: existsSync(path.join(workspace, "AGENTS.md")) ? hash(readFileSync(path.join(workspace, "AGENTS.md"))) : null,
  };
}

function createExecutionPort(baseEnvironment, hookRuns, getLastHookEnvelope, defaultWorkingDirectory) {
  const run = async (request, options = {}) => {
    const isHook = typeof request?.trace?.attributes?.hookEventName === "string";
    const event = isHook ? request.trace.attributes.hookEventName : undefined;
    const result = await runNativeCommand(request, baseEnvironment, defaultWorkingDirectory, options);
    if (event === "UserPromptSubmit") {
      let envelope;
      if (result.status === "completed" && !result.stdout.truncated) {
        try {
          const parsed = JSON.parse(result.stdout.text);
          if (isRecord(parsed)) envelope = parsed;
        } catch { envelope = undefined; }
      }
      if (envelope && typeof envelope.additionalContext === "string" && isRecord(envelope.xiadieReceipt)) {
        getLastHookEnvelope.set(envelope);
      }
      const hook = {
        event,
        status: result.status,
        exit_code: result.exitCode ?? null,
        timed_out: result.timedOut,
        cancelled: result.cancelled,
        duration_ms: result.durationMs,
        stdout_bytes: result.stdout.bytes,
        stdout_sha256: hash(result.stdout.text),
        stderr_bytes: result.stderr.bytes,
        stderr_sha256: hash(result.stderr.text),
        receipt: safeHookReceipt(envelope?.xiadieReceipt),
      };
      hookRuns.push(hook);
    }
    return result;
  };
  return { run };
}

async function runNativeCommand(request, baseEnvironment, defaultWorkingDirectory, options) {
  const startedAt = new Date();
  const command = request?.command;
  if (!isRecord(command) || command.mode !== "argv" || typeof command.file !== "string" || !Array.isArray(command.args)) {
    return executionResult("failed", startedAt, new Date(), Buffer.alloc(0), Buffer.from("P01 argv execution only"), { exitCode: 1 });
  }
  const env = request.env?.base === "empty" ? {} : { ...baseEnvironment };
  const set = isRecord(request.env?.set) ? request.env.set : {};
  for (const [key, value] of Object.entries(set)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|AUTHORIZATION)/i.test(key)) {
      return executionResult("failed", startedAt, new Date(), Buffer.alloc(0), Buffer.from("P01 execution environment denied"), { exitCode: 1 });
    }
    if (typeof value === "string") env[key] = value;
  }
  for (const key of request.env?.unset ?? []) delete env[key];

  const cwd = typeof request.cwd === "string" ? request.cwd : defaultWorkingDirectory;
  const safeCwd = path.resolve(cwd);
  const profileRoot = baseEnvironment.ZCODE_DATA_BASE_DIR ? path.dirname(baseEnvironment.ZCODE_DATA_BASE_DIR) : undefined;
  if (profileRoot) {
    const physicalRoot = realpathSync.native(profileRoot);
    const physicalCwd = realpathSync.native(safeCwd);
    if (!pathIsInside(physicalRoot, physicalCwd)) {
      return executionResult("failed", startedAt, new Date(), Buffer.alloc(0), Buffer.from("P01 execution cwd denied"), { exitCode: 1 });
    }
  }

  const child = spawn(command.file, command.args.map((arg) => String(arg)), {
    cwd: safeCwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  const appendBounded = (list, chunk, count) => {
    const remaining = Math.max(0, MAX_CAPTURE_BYTES - count);
    if (chunk.byteLength > remaining) truncated = true;
    if (remaining > 0) list.push(chunk.subarray(0, remaining));
  };
  child.stdout.on("data", (chunk) => {
    appendBounded(stdoutChunks, chunk, stdoutBytes);
    stdoutBytes += chunk.byteLength;
  });
  child.stderr.on("data", (chunk) => {
    appendBounded(stderrChunks, chunk, stderrBytes);
    stderrBytes += chunk.byteLength;
  });
  if (request.stdin !== undefined) child.stdin.end(request.stdin);
  else child.stdin.end();

  let timedOut = false;
  let cancelled = false;
  let spawnError;
  const timeoutMs = Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : undefined;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const signal = options?.signal;
  const abort = () => {
    cancelled = true;
    child.kill();
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signalValue) => resolve({ code, signal: signalValue }));
  });
  if (timer !== undefined) clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  const completedAt = new Date();
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  const status = spawnError ? "spawn_error" : cancelled ? "cancelled" : timedOut ? "timed_out" : exit.code === 0 ? "completed" : "failed";
  return executionResult(status, startedAt, completedAt, stdout, stderr, {
    ...(exit.code === null ? {} : { exitCode: exit.code }),
    ...(exit.signal ? { signal: exit.signal } : {}),
    timedOut,
    cancelled,
    truncated,
    ...(spawnError ? { error: { type: "spawn_error", message: "P01 native child could not start" } } : {}),
    stdoutByteCount: stdoutBytes,
    stderrByteCount: stderrBytes,
  });
}

function executionResult(status, startedAt, completedAt, stdoutBuffer, stderrBuffer, options = {}) {
  return {
    status,
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    stdout: {
      text: stdoutBuffer.toString("utf8"),
      bytes: options.stdoutByteCount ?? stdoutBuffer.byteLength,
      truncated: options.truncated ?? false,
    },
    stderr: {
      text: stderrBuffer.toString("utf8"),
      bytes: options.stderrByteCount ?? stderrBuffer.byteLength,
      truncated: options.truncated ?? false,
    },
    durationMs: completedAt.getTime() - startedAt.getTime(),
    timedOut: options.timedOut ?? false,
    cancelled: options.cancelled ?? false,
    startedAt,
    completedAt,
    ...(options.error ? { error: options.error } : {}),
  };
}

async function loadPinnedNativeModules() {
  const tsxApiPath = path.join(nativeSourceRoot, "node_modules", "tsx", "dist", "esm", "api", "index.mjs");
  const { register } = await import(pathToFileURL(tsxApiPath).href);
  register();
  const load = (parts) => import(pathToFileURL(path.join(nativeSourceRoot, ...parts)).href);
  const [bootstrap, contracts, provider, modelRunner, filesystem, host, appContracts] = await Promise.all([
    load(["apps", "zcode-cli", "packages", "bootstrap", "dist", "index.js"]),
    load(["apps", "zcode-cli", "packages", "contracts", "dist", "model", "invocation-context.js"]),
    load(["packages", "provider", "dist", "registry.js"]),
    load(["apps", "zcode-cli", "packages", "adapters", "dist", "model", "runner.js"]),
    load(["apps", "zcode-cli", "packages", "adapters", "dist", "fs", "index.js"]),
    import(pathToFileURL(path.join(repositoryRoot, "dist", "packages", "adapters", "zcode", "src", "index.js")).href),
    load(["apps", "zcode-cli", "packages", "contracts", "dist", "interfaces", "file-system.port.js"]),
  ]);
  return { bootstrap, contracts, provider, modelRunner, filesystem, host, appContracts };
}

function normalizeHookEnvelope(value) {
  if (!isRecord(value)) return undefined;
  if (typeof value.additionalContext !== "string" || !isRecord(value.xiadieReceipt)) return undefined;
  return { additionalContext: value.additionalContext, xiadieReceipt: safeHookReceipt(value.xiadieReceipt) };
}

async function installNativePlugin(native, bridge) {
  const paths = bridge.paths;
  const pluginStorageRoot = path.join(paths.root, "plugin-storage");
  await mkdir(pluginStorageRoot, { recursive: true });
  const userConfigPath = path.join(paths.root, "user.json");
  const projectConfigPath = path.join(paths.root, "project.json");
  const marketplace = await native.addZCodePluginMarketplace({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env: bridge.env,
    source: path.join(repositoryRoot, "plugins", "xiadie", "marketplace.json"),
  });
  await native.installZCodeMarketplacePlugin({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env: bridge.env,
    marketplace: marketplace.id,
    pluginName: "xiadie",
  });
  await native.setZCodePluginEnabled({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env: bridge.env,
    plugin: `xiadie@${marketplace.id}`,
    enabled: true,
  });
  let userConfig = {};
  try { userConfig = JSON.parse(await readFile(userConfigPath, "utf8")); } catch { userConfig = {}; }
  userConfig.storage = { ...(userConfig.storage ?? {}), dir: paths.storage };
  await writeFile(userConfigPath, `${JSON.stringify(userConfig, null, 2)}\n`, "utf8");
  const discovered = native.listZCodePlugins({
    pluginStorageRoot,
    userConfigPath,
    projectConfigPath,
    workingDirectory: paths.workspace,
    env: bridge.env,
  });
  const plugin = discovered.plugins.find((item) => item.name === "xiadie");
  if (!plugin?.enabled || typeof plugin.rootPath !== "string" || typeof plugin.dataPath !== "string") {
    throw new Error("native_plugin_install_failed");
  }
  return { plugin, pluginStorageRoot, userConfigPath, projectConfigPath };
}

async function runOne(spec, bridgePath) {
  const outputDir = path.resolve(spec.output_dir);
  await mkdir(outputDir, { recursive: true });
  const outputInfo = lstatSync(outputDir);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error("invalid_output_dir");
  const contextsPath = path.join(outputDir, "model-context.jsonl");
  const receiptsPath = path.join(outputDir, "native-tool-receipts.jsonl");
  const resultPath = path.join(outputDir, "result.json");
  writeFileSync(contextsPath, "", { flag: "wx" });
  writeFileSync(receiptsPath, "", { flag: "wx" });

  const bridge = inspectBridge(spec, JSON.parse(await readFile(bridgePath, "utf8")));
  const environment = readOnlyModelRuntimeEnv(bridge.env);
  const fixture = verifyFixture(spec, bridge.paths.workspace);
  verifyAssets();
  assertPinnedSource(environment);

  const modules = await loadPinnedNativeModules();
  const pluginInfo = await installNativePlugin(modules.bootstrap, bridge);
  const { NodeFileSystemAdapter } = modules.filesystem;
  const baseFileSystem = new NodeFileSystemAdapter({ textSearchEngine: "javascript" });
  const fileSystemPort = createReadOnlyWorkspaceFileSystemPort(
    baseFileSystem,
    bridge.paths.workspace,
    modules.appContracts.createFileSystemError,
  );

  const provider = createLocalProvider(spec.model, spec.relay_origin);
  const providerRegistry = new modules.provider.ProviderRegistry([provider]);
  const getLastHookEnvelope = { current: undefined, set(value) { this.current = normalizeHookEnvelope(value); } };
  const hookRuns = [];
  const executionPort = createExecutionPort(environment, hookRuns, getLastHookEnvelope, bridge.paths.workspace);
  const delegateModelAdapter = new modules.modelRunner.AiSdkModelAdapter({ env: environment });
  const modelObserver = createObservedNativeModelAdapter(
    delegateModelAdapter,
    modules.contracts.getCurrentModelInvocationContext,
    () => getLastHookEnvelope.current,
    spec.scenario.id,
    contextsPath,
  );
  const runtimeConfig = {
    mode: "plan",
    memory: { enabled: false, use: false, extractionEnabled: false },
    dynamicWorkflowEnabled: false,
    modelSelection: {
      providerId: provider.providerId,
      modelId: spec.model,
      options: { reasoningLevel: "disabled", maxOutputTokens: 1024 },
    },
    modelStreaming: "on",
    toolAllowlist: ["Read"],
    workingDirectory: bridge.paths.workspace,
    maxTurns: 4,
    presentationSurface: "terminal",
  };
  const host = await modules.host.createXiadieZCodeApp({
    native: {
      createZCodeApp: modules.bootstrap.createZCodeApp,
      getCurrentModelInvocationContext: modules.contracts.getCurrentModelInvocationContext,
    },
    appOptions: {
      providerRegistry,
      runtimeConfig,
      pluginStorageRoot: pluginInfo.pluginStorageRoot,
      userConfigPath: pluginInfo.userConfigPath,
      projectConfigPath: pluginInfo.projectConfigPath,
      workingDirectory: bridge.paths.workspace,
      skipUserConfig: false,
      officialPluginRoots: [],
      fileSystemPort,
      env: environment,
    },
    executionPort,
    modelAdapter: modelObserver.adapter,
    enabled: true,
    assetsRoot: path.join(repositoryRoot, "assets", "character"),
    moduleRoot: path.join(repositoryRoot, "dist"),
    installedPluginRoot: pluginInfo.plugin.rootPath,
    dataRoot: pluginInfo.plugin.dataPath,
    pluginStorageRoot: pluginInfo.pluginStorageRoot,
    ownedProfileRoot: bridge.paths.root,
    nodeExecutable: process.execPath,
  });

  const collector = createTurnEventCollector(host.app.sessionId);
  const eventObserver = createNativeEventObserver({
    scenarioId: spec.scenario.id,
    sessionId: host.app.sessionId,
    collector,
    receiptsPath,
  });
  const unsubscribe = host.app.runtime.subscribeEvents({ onSessionEvent: eventObserver.onSessionEvent });
  let turnResult;
  let projection;
  let readCallIds = [];
  let runnerError = null;
  try {
    turnResult = await host.submitPrompt(spec.scenario.prompt);
    collector.bindTurn(turnResult.turnId);
    readCallIds = currentReadCallIds([...eventObserver.scheduled, ...(turnResult.events ?? [])], host.app.sessionId, turnResult.turnId);
    projection = collector.project(turnResult, readCallIds);
  } catch {
    runnerError = "native_turn_failed";
  } finally {
    unsubscribe();
    collector.close();
    await host.close?.();
    await modules.bootstrap.shutdownZCodeTelemetry();
  }

  const admissionFailures = host.readAdmissionFailures().map((failure) => ({
    reasonCode: failure.reasonCode,
    status: failure.status,
    exitCode: failure.exitCode ?? null,
    timedOut: failure.timedOut,
    cancelled: failure.cancelled,
    stdoutSha256: failure.stdoutSha256,
    stderrSha256: failure.stderrSha256,
    sessionId: failure.sessionId ?? null,
    turnId: failure.turnId ?? null,
    operation: failure.operation ?? null,
    identity: failure.identity ?? null,
  }));
  const result = {
    schema: "p01-u09-native-result/v1",
    status: runnerError ? "failed" : "completed",
    mode: spec.mode,
    model: spec.model,
    scenario_id: spec.scenario.id,
    request_limit: spec.scenario.max_requests,
    session_id: host.app.sessionId,
    turn_id: turnResult?.turnId ?? null,
    trace_id: turnResult?.traceId ?? null,
    response: typeof turnResult?.response === "string" ? turnResult.response : null,
    projection: projection ?? null,
    read_call_ids: readCallIds,
    native_tool_receipts: eventObserver.receipts,
    native_receipt_journal_failed: eventObserver.journalFailure,
    hook_runs: hookRuns,
    admission_failures: admissionFailures,
    model_contexts: modelObserver.contexts,
    plugin_metadata: {
      name: pluginInfo.plugin.name,
      version: pluginInfo.plugin.version,
      enabled: pluginInfo.plugin.enabled,
      rootPath: pluginInfo.plugin.rootPath,
      dataPath: pluginInfo.plugin.dataPath,
      hook_events: Array.isArray(pluginInfo.plugin.hookDetails)
        ? pluginInfo.plugin.hookDetails.map((hook) => hook.event)
        : [],
    },
    runtime_persona_sha256: casesDocument.runtime_persona.sha256,
    runtime_manifest_sha256: casesDocument.runtime_persona.manifest_sha256,
    fixture,
    ...(runnerError ? { runner_error: runnerError } : {}),
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

async function main(argv) {
  if (argv.length !== 2) throw new Error("usage");
  const [specPath, bridgePath] = argv;
  if (!path.isAbsolute(specPath) || !path.isAbsolute(bridgePath)) throw new Error("paths_must_be_absolute");
  const spec = validateNativeSpec(JSON.parse(await readFile(specPath, "utf8")));
  const result = await runOne(spec, bridgePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "completed" || result.native_receipt_journal_failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "native_runner_failed";
    process.stderr.write(`P01_U09_NATIVE_FAILED:${code}\n`);
    process.exitCode = 1;
  });
}
