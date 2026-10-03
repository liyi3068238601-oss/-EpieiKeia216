import { randomBytes, createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { buildContextPacket, renderContextPacket } from "../../../context/src/index.js";
import { APPROVED_CHARACTER, loadCharacter } from "../../../character/src/loader.js";
import type { ContextPacket } from "../../../contracts/src/context.js";

import { captureTranscript, createTranscriptQueue, type TranscriptSink } from "./transcript.js";

const TRANSCRIPT_SOURCE_PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const HOOK_RELATIVE_PATH = path.join("hooks", "context.mjs");
const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_HOOK_STDOUT_BYTES = 30 * 1024;
const GATE_BLOCK = "Xiadie identity gate rejected this turn before model execution.";

export interface XiadieTraceContext {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface XiadieModelInvocationContext {
  readonly modelCall?: { readonly operation?: string };
  readonly traceContext?: XiadieTraceContext;
}

export interface XiadieModelRequest {
  readonly messages: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface XiadieModel {
  readonly providerId: unknown;
  readonly modelId: unknown;
  readonly displayName?: unknown;
  readonly properties: unknown;
  readonly optionSpecs: unknown;
  readonly options: unknown;
  bind(options?: unknown): XiadieModel;
  generateText(request: XiadieModelRequest): Promise<unknown>;
  streamText(request: XiadieModelRequest): AsyncIterable<unknown>;
}

export interface XiadieModelAdapter {
  createModel(options: unknown): XiadieModel;
  addStatusSink(sink: unknown): void;
  setModelIoFullRetentionEnabled(enabled: boolean): void;
}

export interface XiadieExecutionRequest {
  readonly command: { readonly mode: string; readonly file?: string; readonly args?: readonly string[] };
  readonly stdin?: string | Uint8Array;
  readonly env?: { readonly base?: "inherit" | "empty"; readonly set?: Readonly<Record<string, string>>; readonly unset?: readonly string[] };
  readonly trace?: XiadieTraceContext;
  readonly [key: string]: unknown;
}

export interface XiadieExecutionResult {
  readonly status: string;
  readonly exitCode?: number;
  readonly stdout: { readonly text: string; readonly bytes: number; readonly truncated: boolean; readonly [key: string]: unknown };
  readonly stderr: { readonly text: string; readonly bytes: number; readonly truncated: boolean; readonly [key: string]: unknown };
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly [key: string]: unknown;
}

export interface XiadieExecutionPort {
  run(request: XiadieExecutionRequest, options?: unknown): Promise<XiadieExecutionResult>;
  readonly [key: string]: unknown;
}

export interface XiadieNativeTurnResult {
  readonly response: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly events: readonly unknown[];
  readonly projection: unknown;
  readonly [key: string]: unknown;
}

export interface XiadieNativeRuntime {
  subscribeEvents(sink: { onSessionEvent(event: unknown): void | Promise<void> }): () => void;
  readonly [key: string]: unknown;
}

export interface XiadieNativeSendInputStartedTurn {
  readonly kind: "started_turn";
  readonly turnId: string;
  readonly completion: Promise<XiadieNativeTurnResult>;
}

export type XiadieNativeSendInputResult = XiadieNativeSendInputStartedTurn
  | { readonly kind: "queued"; readonly pendingInputId: string; readonly queueLength: number; readonly turnId: string }
  | { readonly kind: "rejected"; readonly activeTurnId?: string; readonly reason: string };

export interface XiadieNativeApp {
  readonly sessionId: string;
  readonly runtime: XiadieNativeRuntime;
  submitPrompt(prompt: unknown, options?: unknown): Promise<XiadieNativeTurnResult>;
  sendInput(input: unknown, options?: unknown): Promise<XiadieNativeSendInputResult>;
  resume?(options?: unknown): Promise<unknown>;
  close?(): Promise<void>;
  readonly [key: string]: unknown;
}

export interface XiadieNativeApi {
  createZCodeApp(options: Record<string, unknown>): Promise<XiadieNativeApp>;
  getCurrentModelInvocationContext(): XiadieModelInvocationContext | undefined;
}

export interface XiadieTranscriptDelivery {
  readonly status: "queued" | "saving" | "saved" | "failed" | "unknown" | "unavailable";
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly jobId?: number;
  readonly snapshotSha256?: string;
  readonly code?: string;
  readonly receiptId?: string;
}

export interface XiadieHostOptions {
  readonly native: XiadieNativeApi;
  readonly appOptions: Record<string, unknown>;
  readonly executionPort: XiadieExecutionPort;
  readonly modelAdapter: XiadieModelAdapter;
  readonly enabled: boolean;
  readonly assetsRoot?: string;
  readonly moduleRoot?: string;
  readonly installedPluginRoot?: string;
  readonly dataRoot?: string;
  readonly pluginStorageRoot?: string;
  /** Trusted, per-host runtime profile containing the supplied config/storage/HOME/TEMP paths. */
  readonly ownedProfileRoot?: string;
  readonly nodeExecutable?: string;
  /** A local bounded writer; absence is explicitly unavailable, never saved. */
  readonly transcriptSink?: TranscriptSink;
  readonly transcriptMaxPending?: number;
}

export interface XiadieReceipt {
  readonly version: 1;
  readonly nonce: string;
  readonly event: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly packetSha256: string;
  readonly transcriptBytes: number;
  readonly transcriptSha256: string;
  readonly character: { readonly id: "xiadie"; readonly version: "v3"; readonly contentSha256: string };
}

interface Ticket {
  readonly kind: "turn" | "compact";
  readonly sessionId: string;
  readonly nonce: string;
  readonly packet: ContextPacket;
  readonly rendered: string;
  readonly packetSha256: string;
  readonly characterDigest: string;
  receipt?: XiadieReceipt;
  compactTurnId?: string;
}

type AdmissionCorrelation = {
  sessionId?: string;
  turnId?: string;
  nonce?: string;
  operation?: string;
  ticket?: Ticket;
};
type ModelBlockRecorder = (
  reasonCode: "model-receipt" | "compact-session",
  correlation: AdmissionCorrelation,
) => void;

export interface XiadieZCodeHost {
  readonly app: XiadieNativeApp;
  submitPrompt(prompt: unknown, options?: unknown): Promise<XiadieNativeTurnResult>;
  sendInput(input: unknown, options?: unknown): Promise<XiadieNativeSendInputResult>;
  resume(options?: unknown): Promise<unknown>;
  compact(options?: unknown): Promise<XiadieNativeTurnResult>;
  readAdmissionFailures(): readonly XiadieAdmissionFailure[];
  readTranscriptDeliveries(): readonly XiadieTranscriptDelivery[];
  drainTranscripts(): Promise<readonly XiadieTranscriptDelivery[]>;
  close?(): Promise<void>;
}

export interface XiadieAdmissionFailure {
  readonly reasonCode: "host-before-turn" | "missing-ticket" | "hook-receipt" | "model-receipt" | "compact-session";
  readonly status: string;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly nonce?: string;
  readonly operation?: string;
  readonly identity?: { readonly id: "xiadie"; readonly version: "v3"; readonly digest: string };
}

/** Wrap the native app's two extension seams while leaving its Loop and tools intact. */
export async function createXiadieZCodeApp(input: XiadieHostOptions): Promise<XiadieZCodeHost> {
  if (input.enabled && (!input.assetsRoot || !input.moduleRoot || !input.installedPluginRoot ||
      !input.dataRoot || !input.pluginStorageRoot || !input.ownedProfileRoot)) {
    throw new Error("Enabled Xiadie requires trusted assets, module, installed-plugin, profile, plugin-storage, and data roots");
  }
  if (input.enabled) {
    validateOwnedProfile(input);
    const expectedStorage = realpathSync(input.pluginStorageRoot!);
    const configuredStorage = input.appOptions.pluginStorageRoot;
    if (typeof configuredStorage !== "string" || realpathSync(configuredStorage) !== expectedStorage) {
      throw new Error("Xiadie pluginStorageRoot must match the isolated native app plugin storage root");
    }
  }

  const gate = createGate(input);
  const nativeAppOptions = input.enabled
    ? {
        ...input.appOptions,
        env: {
          ...(input.appOptions.env as Record<string, string | undefined>),
          ZCODE_STORAGE_DIR: path.join(input.ownedProfileRoot!, "storage"),
        },
      }
    : input.appOptions;
  const app = await input.native.createZCodeApp({
    ...nativeAppOptions,
    executionPort: gate.executionPort,
    modelAdapter: gate.modelAdapter,
  });
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let activeOperation: object | undefined;
  let activeOperationName: string | undefined;
  const enterExclusive = (name: string): (() => void) => {
    if (closing) throw new Error("Xiadie host is closing or closed");
    if (activeOperation) throw new Error(`Enabled Xiadie only accepts idle native operations; ${activeOperationName} is in flight`);
    const token = {};
    activeOperation = token;
    activeOperationName = name;
    return () => {
      if (activeOperation === token) {
        activeOperation = undefined;
        activeOperationName = undefined;
      }
    };
  };

  const submitPrompt = async (prompt: unknown, options?: unknown): Promise<XiadieNativeTurnResult> => {
    if (!input.enabled) return app.submitPrompt(prompt, options);
    const release = enterExclusive("submitPrompt");
    try {
      if (isCompactCommand(prompt)) return await compactInFlight(options);
      gate.begin("turn", app.sessionId);
      return await app.submitPrompt(prompt, options);
    } finally {
      gate.clear();
      release();
    }
  };

  const resume = async (options?: unknown): Promise<unknown> => {
    if (!input.enabled) return app.resume ? app.resume(options) : Promise.resolve(undefined);
    const release = enterExclusive("resume");
    try {
      // Resume is a fresh approved-asset preflight. No stored packet/receipt is trusted;
      // the next submitted turn creates a new nonce and must pass the ordinary Hook gate.
      gate.preflight(app.sessionId, "resume");
      gate.clear();
      return await app.resume?.(options);
    } finally {
      gate.clear();
      release();
    }
  };

  const compactInFlight = async (options?: unknown): Promise<XiadieNativeTurnResult> => {
    if (!input.enabled) return app.submitPrompt("/compact", options);
    gate.begin("compact", app.sessionId);
    try {
      return await app.submitPrompt("/compact", options);
    } finally {
      gate.clear();
    }
  };

  const compact = async (options?: unknown): Promise<XiadieNativeTurnResult> => {
    if (!input.enabled) return app.submitPrompt("/compact", options);
    const release = enterExclusive("compact");
    try { return await compactInFlight(options); }
    finally { release(); }
  };

  const sendInput = async (prompt: unknown, options?: unknown): Promise<XiadieNativeSendInputResult> => {
    if (!input.enabled) return app.sendInput(prompt, options);
    const release = enterExclusive("sendInput");
    let completionOwnsRelease = false;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      gate.clear();
      release();
    };
    try {
      gate.begin("turn", app.sessionId);
      const result = await app.sendInput(prompt, withRequireIdle(options));
      if (result.kind !== "started_turn" || !isPromiseLike(result.completion)) {
        throw new Error(`Enabled Xiadie supports only idle native sendInput; native admission returned ${result.kind}`);
      }
      completionOwnsRelease = true;
      void result.completion.then(cleanup, cleanup);
      return result;
    } catch (error) {
      if (!completionOwnsRelease) cleanup();
      throw error;
    }
  };
  const readAdmissionFailures = (): readonly XiadieAdmissionFailure[] => gate.readAdmissionFailures();
  const readTranscriptDeliveries = (): readonly XiadieTranscriptDelivery[] => gate.readTranscriptDeliveries();
  const drainTranscripts = async (): Promise<readonly XiadieTranscriptDelivery[]> => {
    await gate.drainTranscripts();
    return readTranscriptDeliveries();
  };
  const close = (): Promise<void> => {
    if (!closePromise) {
      closing = true;
      closePromise = (async () => {
        try { await app.close?.(); }
        finally { await gate.closeTranscripts(); }
      })();
    }
    return closePromise;
  };
  const facade = createAppFacade(app, { submitPrompt, sendInput, resume, compact, readAdmissionFailures, close });
  Object.defineProperties(facade, {
    readTranscriptDeliveries: { value: readTranscriptDeliveries },
    drainTranscripts: { value: drainTranscripts },
  });
  return {
    app: facade,
    submitPrompt,
    sendInput,
    resume,
    compact,
    readAdmissionFailures,
    readTranscriptDeliveries,
    drainTranscripts,
    close,
  };
}

function createGate(input: XiadieHostOptions): {
  executionPort: XiadieExecutionPort;
  modelAdapter: XiadieModelAdapter;
  begin(kind: Ticket["kind"], sessionId: string): void;
  preflight(sessionId: string, operation?: string): Ticket;
  clear(): void;
  readAdmissionFailures(): readonly XiadieAdmissionFailure[];
  recordModelBlock: ModelBlockRecorder;
  readTranscriptDeliveries(): readonly XiadieTranscriptDelivery[];
  drainTranscripts(): Promise<void>;
  closeTranscripts(): Promise<void>;
} {
  let ticket: Ticket | undefined;
  const transcriptQueue = input.enabled && input.transcriptSink
    ? createTranscriptQueue({ sink: input.transcriptSink, maxPending: input.transcriptMaxPending ?? 32 })
    : undefined;
  const deliveries: XiadieTranscriptDelivery[] = [];
  const recordDelivery = (delivery: XiadieTranscriptDelivery): void => {
    deliveries.push(Object.freeze(delivery));
    if (deliveries.length > 64) deliveries.shift();
  };
  const readTranscriptDeliveries = (): readonly XiadieTranscriptDelivery[] => deliveries.map((delivery) => {
    if (!delivery.jobId || !transcriptQueue) return { ...delivery };
    const current = transcriptQueue.getStatus(delivery.jobId);
    if (!current) return { ...delivery, status: "unknown", code: "status_evicted" };
    return { ...delivery, status: current.status,
      ...(current.code ? { code: current.code } : {}),
      ...(current.receiptId ? { receiptId: current.receiptId } : {}),
    };
  });
  const captureOwnTranscript = (request: XiadieExecutionRequest, current: Ticket): void => {
    const scope = {
      ...(request.trace?.sessionId ? { sessionId: request.trace.sessionId } : {}),
      ...(request.trace?.turnId ? { turnId: request.trace.turnId } : {}),
    };
    try {
      const envelope = parseHookInput(request.stdin);
      const event = envelope.hookEventName ?? envelope.hook_event_name;
      const sessionId = envelope.sessionId ?? envelope.session_id;
      const turnId = envelope.turnId ?? envelope.turn_id;
      const transcriptPath = envelope.transcriptPath ?? envelope.transcript_path;
      const aliases = [
        [envelope.hookEventName, envelope.hook_event_name],
        [envelope.sessionId, envelope.session_id],
        [envelope.turnId, envelope.turn_id],
        [envelope.transcriptPath, envelope.transcript_path],
      ];
      if (aliases.some(([camel, snake]) => camel !== undefined && snake !== undefined && camel !== snake) ||
          event !== "UserPromptSubmit" || sessionId !== current.sessionId ||
          typeof sessionId !== "string" || typeof turnId !== "string" ||
          typeof transcriptPath !== "string" || typeof envelope.prompt !== "string" ||
          typeof request.trace?.attributes?.hookEventName !== "string" ||
          typeof request.trace.sessionId !== "string" || typeof request.trace.turnId !== "string") {
        throw new Error("invalid capture binding");
      }
      const ownedEnv = input.appOptions.env as Record<string, unknown>;
      const captured = captureTranscript({
        hookInput: { hookEventName: "UserPromptSubmit", sessionId, turnId, transcriptPath, prompt: envelope.prompt },
        trace: { hookEventName: request.trace.attributes.hookEventName, sessionId: request.trace.sessionId, turnId: request.trace.turnId },
        ownedTempRoot: String(ownedEnv.TEMP), sourcePin: TRANSCRIPT_SOURCE_PIN,
      });
      if (captured.status !== "captured") {
        recordDelivery({ ...scope, status: "unavailable", code: captured.code });
      } else if (!transcriptQueue) {
        recordDelivery({ ...scope, status: "unavailable", snapshotSha256: captured.capture.snapshotSha256, code: "sink_unconfigured" });
      } else {
        const admission = transcriptQueue.enqueue(captured.capture);
        recordDelivery({ ...scope, snapshotSha256: captured.capture.snapshotSha256,
          ...(admission.status === "queued"
            ? { status: "queued", jobId: admission.jobId }
            : { status: "unavailable", code: admission.status }),
        });
      }
    } catch {
      recordDelivery({ ...scope, status: "unavailable", code: "invalid_capture_binding" });
    }
  };
  const failures: XiadieAdmissionFailure[] = [];
  const recordFailure = (failure: XiadieAdmissionFailure): void => {
    failures.push(failure);
    if (failures.length > 64) failures.shift();
  };
  const recordModelBlock = (
    reasonCode: "model-receipt" | "compact-session",
    correlation: AdmissionCorrelation,
  ): void => {
    recordFailure({
      reasonCode,
      status: "blocked",
      timedOut: false,
      cancelled: false,
      stdoutSha256: sha256(""),
      stderrSha256: sha256(""),
      ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
      ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
      ...(correlation.nonce ? { nonce: correlation.nonce } : {}),
      ...(correlation.operation ? { operation: correlation.operation } : {}),
      ...(correlation.ticket ? { identity: { id: "xiadie", version: "v3", digest: correlation.ticket.characterDigest } } : {}),
    });
  };
  const preflight = (sessionId: string, operation = "turn"): Ticket => {
    if (!input.enabled) throw new Error("Xiadie is disabled");
    try {
      const character = loadCharacter(input.assetsRoot!);
      const nonce = randomBytes(24).toString("base64url");
      const packet = buildContextPacket(character, {
        scope: `zcode-session:${sessionId}`,
        version: `u06-turn:${nonce}`,
        max_tokens: 12_000,
        state: [{ source_refs: ["trusted-host:per-turn-nonce"], value: { kind: "turn-binding", nonce } }],
        evidence: [],
        content: [],
      });
      const rendered = renderContextPacket(packet);
      const next: Ticket = {
        kind: "turn",
        sessionId,
        nonce,
        packet,
        rendered,
        packetSha256: sha256(rendered),
        characterDigest: APPROVED_CHARACTER.contentSha256,
      };
      ticket = next;
      return next;
    } catch (error) {
      recordFailure({
        reasonCode: "host-before-turn",
        status: "blocked",
        timedOut: false,
        cancelled: false,
        stdoutSha256: sha256(""),
        stderrSha256: sha256(""),
        sessionId,
        operation: `${operation}-preflight`,
      });
      throw error;
    }
  };

  const begin = (kind: Ticket["kind"], sessionId: string): void => {
    if (ticket) throw new Error("Xiadie serial admission invariant was violated");
    const next = preflight(sessionId, kind);
    ticket = { ...next, kind };
  };

  const deny = (
    reasonCode: XiadieAdmissionFailure["reasonCode"],
    original: XiadieExecutionResult,
    correlation: AdmissionCorrelation = {},
  ): XiadieExecutionResult => {
    recordFailure({
      reasonCode,
      status: original.status,
      ...(original.exitCode === undefined ? {} : { exitCode: original.exitCode }),
      timedOut: original.timedOut,
      cancelled: original.cancelled,
      stdoutSha256: sha256(original.stdout.text),
      stderrSha256: sha256(original.stderr.text),
      ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
      ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
      ...(correlation.nonce ? { nonce: correlation.nonce } : {}),
      ...(correlation.operation ? { operation: correlation.operation } : {}),
      ...(correlation.ticket ? { identity: { id: "xiadie", version: "v3", digest: correlation.ticket.characterDigest } } : {}),
    });
    return {
      ...original,
      status: "completed",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      stdout: stream(JSON.stringify({ decision: "block", reason: `${GATE_BLOCK} ${reasonCode}` })),
      stderr: stream(""),
      completedAt: new Date(),
    };
  };

  const executionPort: XiadieExecutionPort = Object.create(input.executionPort) as XiadieExecutionPort;
  Object.defineProperty(executionPort, "run", {
    value: async (request: XiadieExecutionRequest, options?: unknown): Promise<XiadieExecutionResult> => {
      if (!input.enabled || !isOwnHookRequest(request, input.installedPluginRoot!, input.nodeExecutable ?? process.execPath)) {
        return input.executionPort.run.call(input.executionPort, request, options);
      }
      const current = ticket;
      if (!current || current.kind !== "turn" || request.trace?.attributes?.hookEventName !== "UserPromptSubmit") {
        return deny("missing-ticket", syntheticExecutionResult(), {
          ...(request.trace?.sessionId ? { sessionId: request.trace.sessionId } : {}),
          ...(request.trace?.turnId ? { turnId: request.trace.turnId } : {}),
          operation: "UserPromptSubmit",
        });
      }
      captureOwnTranscript(request, current);
      const original = await input.executionPort.run.call(input.executionPort, withTrustedHookEnv(request, input, current), options);
      try {
        current.receipt = validateHookResult(request, original, current).receipt;
      } catch {
        return deny("hook-receipt", original, {
          ...(request.trace?.sessionId ? { sessionId: request.trace.sessionId } : {}),
          ...(request.trace?.turnId ? { turnId: request.trace.turnId } : {}),
          nonce: current.nonce,
          operation: "UserPromptSubmit",
          ticket: current,
        });
      }
      return original;
    },
  });
  for (const name of ["start", "getBackgroundTask", "readBackgroundBashOutput", "cancelBackgroundTask", "close"] as const) {
    const method = input.executionPort[name];
    if (typeof method === "function") {
      Object.defineProperty(executionPort, name, {
        value: (...args: unknown[]) => method.apply(input.executionPort, args),
      });
    }
  }

  const guardAdapter: XiadieModelAdapter = Object.create(input.modelAdapter) as XiadieModelAdapter;
  Object.defineProperties(guardAdapter, {
    createModel: {
      value: (options: unknown) => wrapModel(input.modelAdapter.createModel.call(input.modelAdapter, options), input, () => ticket, recordModelBlock),
    },
    addStatusSink: { value: (sink: unknown) => input.modelAdapter.addStatusSink.call(input.modelAdapter, sink) },
    setModelIoFullRetentionEnabled: {
      value: (enabled: boolean) => input.modelAdapter.setModelIoFullRetentionEnabled.call(input.modelAdapter, enabled),
    },
  });

  return {
    executionPort,
    modelAdapter: guardAdapter,
    begin,
    preflight,
    clear: () => { ticket = undefined; },
    recordModelBlock,
    readAdmissionFailures: () => failures.map((failure) => ({ ...failure })),
    readTranscriptDeliveries,
    drainTranscripts: async () => { await transcriptQueue?.drain(); },
    closeTranscripts: async () => { await transcriptQueue?.close(); },
  };
}

function wrapModel(
  delegate: XiadieModel,
  input: XiadieHostOptions,
  getTicket: () => Ticket | undefined,
  recordModelBlock: ModelBlockRecorder,
): XiadieModel {
  const wrapped = Object.create(delegate) as XiadieModel;
  Object.defineProperties(wrapped, {
    bind: { value: (options?: unknown) => wrapModel(delegate.bind.call(delegate, options), input, getTicket, recordModelBlock) },
    generateText: {
      value: (request: XiadieModelRequest) => {
        enforceModelGate(request, input, getTicket(), recordModelBlock);
        return delegate.generateText.call(delegate, request);
      },
    },
    streamText: {
      value: (request: XiadieModelRequest) => {
        enforceModelGate(request, input, getTicket(), recordModelBlock);
        return delegate.streamText.call(delegate, request);
      },
    },
  });
  return wrapped;
}

function enforceModelGate(
  request: XiadieModelRequest,
  input: XiadieHostOptions,
  ticket: Ticket | undefined,
  recordModelBlock: ModelBlockRecorder,
): void {
  if (!input.enabled) return;
  const context = input.native.getCurrentModelInvocationContext();
  const operation = context?.modelCall?.operation;
  const compactTurnId = context?.traceContext?.turnId;
  if (operation === "context_compaction" && ticket?.kind === "compact" &&
      context?.traceContext?.sessionId === ticket.sessionId && typeof compactTurnId === "string" &&
      (!ticket.compactTurnId || ticket.compactTurnId === compactTurnId)) {
    ticket.compactTurnId = compactTurnId;
    return;
  }
  if (operation === "context_compaction" && ticket?.kind === "compact") {
    recordModelBlock("compact-session", {
      ...(context?.traceContext?.sessionId ? { sessionId: context.traceContext.sessionId } : {}),
      ...(context?.traceContext?.turnId ? { turnId: context.traceContext.turnId } : {}),
      nonce: ticket.nonce,
      operation,
      ticket,
    });
    throw new Error("Xiadie compact admission does not match the current native compact turn");
  }
  const receipt = ticket?.receipt;
  const trace = context?.traceContext;
  if (ticket?.kind !== "turn" || !receipt || !trace ||
      trace.sessionId !== receipt.sessionId || trace.turnId !== receipt.turnId ||
      !flattenText(request.messages).includes(ticket.rendered)) {
    recordModelBlock("model-receipt", {
      ...(trace?.sessionId ? { sessionId: trace.sessionId } : {}),
      ...(trace?.turnId ? { turnId: trace.turnId } : {}),
      ...(ticket?.nonce ? { nonce: ticket.nonce } : {}),
      ...(typeof operation === "string" ? { operation } : { operation: "model" }),
      ...(ticket ? { ticket } : {}),
    });
    throw new Error("Xiadie identity gate rejected model delegation: missing, stale, cross-turn, or incomplete packet receipt");
  }
}

function isOwnHookRequest(request: XiadieExecutionRequest, installedRoot: string, nodeExecutable: string): boolean {
  if (request.command.mode !== "argv" || request.command.args?.length !== 1 ||
      request.trace?.attributes?.hookEventName !== "UserPromptSubmit") return false;
  const args0 = request.command.args[0];
  if (typeof args0 !== "string") return false;
  const expected = path.resolve(installedRoot, HOOK_RELATIVE_PATH);
  return normalizePath(args0) === normalizePath(expected) &&
    (request.command.file === "node" || request.command.file === "node.exe" ||
      normalizePath(request.command.file ?? "") === normalizePath(nodeExecutable));
}

function withTrustedHookEnv(request: XiadieExecutionRequest, input: XiadieHostOptions, ticket: Ticket): XiadieExecutionRequest {
  const event = request.trace?.attributes?.hookEventName;
  return {
    ...request,
    command: { ...request.command, file: input.nodeExecutable ?? process.execPath },
    env: {
      ...request.env,
      set: {
        ...request.env?.set,
        XIA_DIE_APPROVED_ASSET_ROOT: input.assetsRoot!,
        XIA_DIE_HOST_MODULE_ROOT: input.moduleRoot!,
        XIA_DIE_TICKET_NONCE: ticket.nonce,
        XIA_DIE_HOOK_EVENT: String(event),
        XIA_DIE_PLUGIN_DATA_ROOT: input.dataRoot!,
      },
    },
  };
}

interface HookEnvelope {
  readonly prompt?: unknown;
  readonly hookEventName?: unknown;
  readonly hook_event_name?: unknown;
  readonly sessionId?: unknown;
  readonly session_id?: unknown;
  readonly turnId?: unknown;
  readonly turn_id?: unknown;
  readonly transcriptPath?: unknown;
  readonly transcript_path?: unknown;
}

function validateHookResult(
  request: XiadieExecutionRequest,
  result: XiadieExecutionResult,
  ticket: Ticket,
): { receipt: XiadieReceipt; input: HookEnvelope } {
  if (result.status !== "completed" || result.exitCode !== 0 || result.timedOut || result.cancelled ||
      result.stdout.truncated || result.stdout.bytes > MAX_HOOK_STDOUT_BYTES) {
    throw new Error("hook did not complete with bounded stdout");
  }
  const raw = result.stdout.text;
  const actualBytes = Buffer.byteLength(raw, "utf8");
  if (actualBytes !== result.stdout.bytes || actualBytes > MAX_HOOK_STDOUT_BYTES) throw new Error("hook stdout byte count is invalid");
  const input = parseHookInput(request.stdin);
  const event = input.hookEventName ?? input.hook_event_name;
  const sessionId = input.sessionId ?? input.session_id;
  const turnId = input.turnId ?? input.turn_id;
  if (event !== "UserPromptSubmit" || request.trace?.attributes?.hookEventName !== event ||
      typeof sessionId !== "string" || sessionId.length === 0 ||
      typeof turnId !== "string" || turnId.length === 0 ||
      request.trace?.sessionId !== sessionId || request.trace?.turnId !== turnId) {
    throw new Error("hook event/session/turn does not match the native trace");
  }
  const transcriptPath = input.transcriptPath ?? input.transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) throw new Error("native Hook transcript path is missing");
  const transcript = hashBoundedFile(transcriptPath, MAX_TRANSCRIPT_BYTES);
  let envelope: unknown;
  try { envelope = JSON.parse(raw) as unknown; } catch { throw new Error("hook output is not strict JSON"); }
  if (JSON.stringify(envelope) !== raw.trim() || !isPlainRecord(envelope) ||
      !sameKeys(envelope, ["additionalContext", "xiadieReceipt"]) ||
      envelope.additionalContext !== ticket.rendered || !isPlainRecord(envelope.xiadieReceipt)) {
    throw new Error("hook output schema or complete canonical packet is invalid");
  }
  const receipt = envelope.xiadieReceipt;
  const expectedKeys = ["version", "nonce", "event", "sessionId", "turnId", "packetSha256", "transcriptBytes", "transcriptSha256", "character"];
  if (!sameKeys(receipt, expectedKeys) || receipt.version !== 1 || receipt.nonce !== ticket.nonce ||
      receipt.event !== event || receipt.sessionId !== sessionId || receipt.turnId !== turnId ||
      receipt.packetSha256 !== ticket.packetSha256 || receipt.transcriptBytes !== transcript.bytes ||
      receipt.transcriptSha256 !== transcript.sha256 || !isPlainRecord(receipt.character) ||
      !sameKeys(receipt.character, ["id", "version", "contentSha256"]) || receipt.character.id !== "xiadie" ||
      receipt.character.version !== "v3" || receipt.character.contentSha256 !== ticket.characterDigest) {
    throw new Error("hook receipt is missing, stale, or does not match the native input");
  }
  return { receipt: receipt as unknown as XiadieReceipt, input };
}

function parseHookInput(input: XiadieExecutionRequest["stdin"]): HookEnvelope {
  if (typeof input === "undefined") throw new Error("native Hook input is missing");
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength > 128 * 1024) throw new Error("native Hook input exceeds its byte bound");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!isPlainRecord(value)) throw new Error("native Hook input is not an object");
  return value as HookEnvelope;
}

function hashBoundedFile(filename: string, limit: number): { bytes: number; sha256: string } {
  let descriptor: number | undefined;
  try {
    if (lstatSync(filename).isSymbolicLink()) throw new Error("transcript must not be a symlink");
    const canonical = realpathSync(filename);
    descriptor = openSync(canonical, "r");
    if (!fstatSync(descriptor).isFile()) throw new Error("transcript must be a regular file");
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(descriptor, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > limit) throw new Error("transcript exceeds its byte bound");
    return { bytes: count, sha256: sha256(buffer.subarray(0, count)) };
  } catch (error) {
    throw new Error("transcript could not be read within its bound", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function flattenText(messages: readonly unknown[]): string {
  const chunks: string[] = [];
  for (const message of messages) {
    if (!isPlainRecord(message)) continue;
    if (typeof message.content === "string") chunks.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isPlainRecord(block) && block.type === "text" && typeof block.text === "string") chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

function isCompactCommand(prompt: unknown): boolean {
  return prompt === "/compact" || (isPlainRecord(prompt) && prompt.text === "/compact");
}

function withRequireIdle(options: unknown): unknown {
  if (options === undefined) return { requireIdle: true };
  if (!isPlainRecord(options)) throw new Error("Enabled Xiadie sendInput options must be a plain native options object");
  return { ...options, requireIdle: true };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function validateOwnedProfile(input: XiadieHostOptions): void {
  const root = realpathSync(input.ownedProfileRoot!);
  const userConfig = input.appOptions.userConfigPath;
  const projectConfig = input.appOptions.projectConfigPath;
  if (input.appOptions.skipUserConfig === true || typeof userConfig !== "string" || typeof projectConfig !== "string") {
    throw new Error("Enabled Xiadie requires explicit, isolated user/project config paths and native user-config loading");
  }
  const userConfigPath = physicalPathInside(userConfig, root, "userConfigPath");
  if (!lstatSync(userConfigPath).isFile()) throw new Error("Xiadie userConfigPath must name an owned config file");
  physicalPathInside(projectConfig, root, "projectConfigPath");

  const env = input.appOptions.env;
  if (!isPlainRecord(env)) throw new Error("Enabled Xiadie requires an explicit owned native environment");
  for (const key of ["HOME", "USERPROFILE", "TEMP", "TMP"] as const) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`Enabled Xiadie requires ${key} inside the owned profile`);
    physicalPathInside(value, root, key);
  }
  const ownedStorageRoot = path.join(root, "storage");
  physicalPathInside(ownedStorageRoot, root, "owned storage root");
  const configuredStorageDir = env.ZCODE_STORAGE_DIR;
  if (configuredStorageDir !== undefined) {
    if (typeof configuredStorageDir !== "string" || !path.isAbsolute(configuredStorageDir) ||
        physicalPathInside(configuredStorageDir, root, "ZCODE_STORAGE_DIR") !== physicalPathInside(ownedStorageRoot, root, "owned storage root")) {
      throw new Error("Enabled Xiadie ZCODE_STORAGE_DIR must equal the owned profile storage root");
    }
  }
  for (const key of ["ZCODE_SESSION_DB_PATH", "ZCODE_SESSION_DB"] as const) {
    const value = env[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length === 0) throw new Error(`Enabled Xiadie ${key} must be an owned path`);
      physicalPathInside(value, root, key);
    }
  }

  const storage = physicalPathInside(input.pluginStorageRoot!, root, "pluginStorageRoot");
  const dataRoot = physicalPathInside(input.dataRoot!, root, "dataRoot");
  const installRoot = physicalPathInside(input.installedPluginRoot!, root, "installedPluginRoot");
  assertPhysicalChild(storage, dataRoot, "dataRoot", "data");
  assertPhysicalChild(storage, installRoot, "installedPluginRoot", "cache");
}

function physicalPathInside(candidate: string, root: string, label: string): string {
  const absolute = path.resolve(candidate);
  const canonicalRoot = realpathSync(root);
  let canonicalCandidate: string;
  try {
    canonicalCandidate = realpathSync(absolute);
  } catch {
    const parent = realpathSync(path.dirname(absolute));
    canonicalCandidate = path.join(parent, path.basename(absolute));
  }
  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    throw new Error(`Enabled Xiadie ${label} must remain inside its owned profile`);
  }
  return canonicalCandidate;
}

function assertPhysicalChild(root: string, candidate: string, label: string, requiredDirectory: string): void {
  const requiredBase = realpathSync(path.join(root, requiredDirectory));
  if (!isWithin(requiredBase, candidate)) {
    throw new Error(`Enabled Xiadie ${label} must remain under native plugin ${requiredDirectory} storage`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function stream(text: string): XiadieExecutionResult["stdout"] {
  return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
}

function syntheticExecutionResult(): XiadieExecutionResult {
  const now = new Date();
  return {
    status: "spawn_error",
    stdout: stream(""),
    stderr: stream(""),
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("/", "\\").toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function createAppFacade(
  app: XiadieNativeApp,
  guarded: {
    submitPrompt(prompt: unknown, options?: unknown): Promise<XiadieNativeTurnResult>;
    sendInput(input: unknown, options?: unknown): Promise<XiadieNativeSendInputResult>;
    resume(options?: unknown): Promise<unknown>;
    compact(options?: unknown): Promise<XiadieNativeTurnResult>;
    readAdmissionFailures(): readonly XiadieAdmissionFailure[];
    close(): Promise<void>;
  },
): XiadieNativeApp {
  const facade = Object.create(null) as XiadieNativeApp;
  const names = new Set<PropertyKey>();
  let current: object | null = app;
  while (current && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) names.add(key);
    current = Object.getPrototypeOf(current) as object | null;
  }
  for (const key of names) {
    if (key === "constructor") continue;
    if (key === "submitPrompt") {
      Object.defineProperty(facade, key, { value: guarded.submitPrompt });
      continue;
    }
    if (key === "sendInput") {
      Object.defineProperty(facade, key, { value: guarded.sendInput });
      continue;
    }
    if (key === "resume") {
      Object.defineProperty(facade, key, { value: guarded.resume });
      continue;
    }
    if (key === "compact") {
      Object.defineProperty(facade, key, { value: guarded.compact });
      continue;
    }
    if (key === "close") {
      Object.defineProperty(facade, key, { value: guarded.close });
      continue;
    }
    if (key === "readAdmissionFailures") {
      Object.defineProperty(facade, key, { value: guarded.readAdmissionFailures });
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(app, key) ?? findDescriptor(Object.getPrototypeOf(app), key);
    if (descriptor?.get) {
      Object.defineProperty(facade, key, {
        ...(descriptor.enumerable === undefined ? {} : { enumerable: descriptor.enumerable }),
        get: () => Reflect.get(app, key, app),
      });
    } else {
      const value = Reflect.get(app, key, app) as unknown;
      Object.defineProperty(facade, key, {
        ...(descriptor?.enumerable === undefined ? {} : { enumerable: descriptor.enumerable }),
        value: typeof value === "function" ? (...args: unknown[]) => value.apply(app, args) : value,
      });
    }
  }
  return facade;
}

function findDescriptor(prototype: object | null, key: PropertyKey): PropertyDescriptor | undefined {
  let current = prototype;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}
