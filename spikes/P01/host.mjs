// Pinned private-workspace bootstrap seam; no replacement model/agent Loop.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const load = p => import(pathToFileURL(p).href);
const bootstrap = await load(spec.bootstrap);
const { createNodeFileSystemAdapter } = await load(spec.fs_adapter);
const { createFileSystemError } = await load(spec.contracts);
const baseFs = createNodeFileSystemAdapter();
const allowedRoots = [await realpath(spec.fixture)];
function contained(path, root) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}
const fsAudit = [];
const readMethods = new Set(['stat', 'readTextFile', 'readBinaryFile', 'readTextFileRange']);
const fsPort = new Proxy(baseFs, { get(target, name) {
  const method = target[name];
  if (typeof method !== 'function') return method;
  return async (request, ...rest) => {
    const absolute = resolve(request.path);
    let canonical = absolute;
    try { canonical = await realpath(absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const allowed = readMethods.has(name) && allowedRoots.some(r => contained(absolute, r) && contained(canonical, r));
    fsAudit.push({ method: name, allowed });
    if (!allowed) throw createFileSystemError({ code: 'permission_denied', message: 'P01 read-only fixture scope denied' });
    return method.call(target, request, ...rest);
  };
}});
const registry = await bootstrap.startProcessProviderRegistryRuntime(process.env);
let app;
let detach;
let phase;
const turns = [];
const observed = [];
const nativeToolNames = new Map();
const emit = x => process.stdout.write(JSON.stringify(x) + '\n');
async function setPhase(value) {
  phase = value;
  await writeFile(process.env.P01_PACKET_PATH, JSON.stringify({ phase, fixture: spec.fixture,
    identity_id: 'xiadie', version: 'P01-research-v3',
    role_instructions: spec.role,
    source_kind: 'user-approved role; fictional setting, not user history',
  }));
}
async function open(sessionId, pluginEnabled = true) {
  const config = JSON.parse(await readFile(spec.user_config, 'utf8'));
  config.plugins.enabled = pluginEnabled;
  await writeFile(spec.user_config, JSON.stringify(config));
  app = await bootstrap.createZCodeApp({
    providerRegistry: registry.runtime.registryService,
    configuredDefaultModelSelection: registry.configuredDefaultModelSelection,
    env: process.env, version: '0.16.9', fileSystemPort: fsPort,
    userConfigPath: spec.user_config, projectConfigPath: spec.project_config,
    ...(sessionId ? { sessionId, resume: true } : {}),
    runtimeConfig: { workingDirectory: spec.fixture, mode: 'plan',
      toolDisallowlist: spec.disallowed_tools,
      ...(!sessionId ? { modelSelection: { providerId: 'p01-fixture', modelId: spec.model,
        options: { reasoningLevel: 'disabled' } } } : {}),
      memory: { extractionEnabled: false }, dynamicWorkflowEnabled: false,
      modelStreaming: 'on', presentationSurface: 'terminal',
    },
  });
  assert.equal(app.runtime.getPlanEnabled(), true);
  assert.equal(app.runtime.isProjectMemoryEnabled(), false);
  detach = app.runtime.subscribeEvents({ onSessionEvent(event) {
    const p = event.payload ?? {};
    if (p.toolCallId && p.toolName) nativeToolNames.set(p.toolCallId, p.toolName);
    const receipt = { type: 'native_event', phase, event_type: event.type, sequence: event.sequenceNumber,
      turn_id: event.turnId, tool_call_id: p.toolCallId, tool_name: p.toolName,
      result: p.result ? { success: p.result.success, content: p.result.content?.slice(0, 1500),
        error_type: p.result.error?.type } : undefined,
      error_type: p.error?.type,
    };
    if (p.toolCallId && ['tool_call_result', 'tool_call_error', 'hook_run_blocked'].includes(event.type)) {
      // Synchronous append makes the genuine terminal event available before
      // the native Loop can send its next model request. No model text is read.
      appendFileSync(process.env.P01_NATIVE_TOOL_RECEIPTS, JSON.stringify({ phase,
        event_type: event.type, sequence: event.sequenceNumber, turn_id: event.turnId,
        tool_call_id: p.toolCallId, tool_name: nativeToolNames.get(p.toolCallId),
        result_success: p.result?.success,
      }) + '\n');
    }
    observed.push(receipt); emit(receipt);
  } });
}
async function close() {
  detach?.(); detach = undefined;
  const closing = app; app = undefined;
  await closing?.close();
}
async function submit(next, prompt) {
  await setPhase(next);
  const eventStart = observed.length;
  const result = await app.submitPrompt(prompt);
  const turn = { phase: next, session_id: app.sessionId, response: result.response,
    observed_events: observed.slice(eventStart),
    events: result.events.map(e => ({ type: e.type, tool_call_id: e.payload?.toolCallId,
      tool_name: e.payload?.toolName, success: e.payload?.result?.success,
      error_type: e.payload?.error?.type })),
  };
  turns.push(turn); emit({ type: 'turn_result', ...turn });
  return turn;
}
try {
  await setPhase(spec.mode === 'mock' ? 'read-ok' : 'real-read');
  await open();
  if (spec.mode === 'mock') {
    await submit('read-ok', 'Synthetic P01 phase=read-ok. Read only the fixture, then report its value.');
    await submit('read-fail', 'Synthetic P01 phase=read-fail. Read the missing fixture and report failure honestly.');
    await submit('scope-denied', 'Synthetic P01 phase=scope-denied. Attempt the synthetic out-of-scope path; do not bypass denials.');
    await submit('symlink-denied', 'Synthetic P01 phase=symlink-denied. Attempt the synthetic symlink; do not bypass denials.');
    await submit('compact', '/compact');
    const sessionId = app.sessionId;
    await close(); await setPhase('resume'); await open(sessionId);
    await submit('resume', 'Synthetic P01 phase=resume. Read the fixture again after native resume.');
    await close(); await setPhase('disabled'); await open(undefined, false);
    await submit('disabled', 'Synthetic P01 phase=disabled. Read the fixture using native tools.');
  } else {
    await submit('real-read', `请用Read读取这个合成文件：${spec.fixture}/readme.txt。读到后用一句话说出你的对话身份和文件中的值；工具失败就如实报告，不要猜测。`);
  }
  emit({ type: 'host_result', turns, fs_audit: fsAudit, no_second_loop: true });
} finally {
  await close(); registry.dispose(); await bootstrap.shutdownZCodeTelemetry();
}
