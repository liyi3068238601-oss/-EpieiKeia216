// Thin test host: native bootstrap, provider adapter, persistence, Loop and executor.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const bootstrap = await import(pathToFileURL(spec.bootstrap_entry).href);
const registry = await bootstrap.startProcessProviderRegistryRuntime(process.env);
let app;
let detach;
let phase;
const results = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
async function setPacket(next) {
  phase = next;
  await writeFile(process.env.P00_PACKET_PATH, JSON.stringify({
    packet_version: `${spec.nonce}-${next}`, phase: next,
    identity_id: 'synthetic-xiadie', favorite_color: 'blue-orchid',
    provenance: 'original synthetic fixture; not user facts or a product persona',
  }));
}
async function open(sessionId) {
  app = await bootstrap.createZCodeApp({
    providerRegistry: registry.runtime.registryService,
    configuredDefaultModelSelection: registry.configuredDefaultModelSelection,
    env: process.env, version: '0.16.9',
    ...(sessionId ? { sessionId, resume: true } : {}),
    runtimeConfig: {
      workingDirectory: spec.fixture, mode: 'plan',
      toolDisallowlist: spec.disallowed_tools,
      ...(!sessionId ? { modelSelection: { providerId: 'p00-fixture', modelId: spec.model, options: { reasoningLevel: 'disabled' } } } : {}),
      memory: { extractionEnabled: false }, dynamicWorkflowEnabled: false,
      modelStreaming: 'on', presentationSurface: 'terminal',
    },
  });
  // Native execution state normalizes the plan alias to build + planEnabled.
  assert.equal(app.getMode(), 'build');
  assert.equal(app.runtime.getPlanEnabled(), true);
  assert.equal(app.runtime.isProjectMemoryEnabled(), false);
  detach = app.runtime.subscribeEvents({ onSessionEvent(event) { emit({ kind: 'session_event', phase, event }); } });
}
async function close() {
  detach?.(); detach = undefined;
  const closing = app; app = undefined;
  await closing?.close();
}
async function submit(next) {
  await setPacket(next);
  const prompt = next === 'compact' ? '/compact' : next === 'real'
    ? "Return the synthetic record's identity_id and favorite_color joined by one |. No commentary. Do not use tools."
    : `Synthetic P00 phase=${next}. Reply exactly U07_MOCK_OK after any injected tool result.`;
  const turn = await app.submitPrompt(prompt);
  assert.equal(app.runtime.getPlanEnabled(), true);
  const result = { phase: next, session_id: app.sessionId, mode: app.getMode(), plan_enabled: app.runtime.getPlanEnabled(), response: turn.response, event_types: turn.events.map(event => event.type) };
  results.push(result); emit({ kind: 'turn_result', ...result });
}
try {
  await setPacket(spec.mode === 'mock' ? 'new' : 'real');
  await open();
  if (spec.mode === 'mock') {
    await submit('new');
    await submit('compact');
    await submit('postcompact');
    await submit('tool_failure');
    await submit('permission');
    const sessionId = app.sessionId;
    await close();
    await setPacket('resume');
    await open(sessionId);
    await submit('resume');
  } else await submit('real');
  emit({ kind: 'host_result', results });
} finally {
  await close();
  await bootstrap.shutdownZCodeTelemetry();
  registry.dispose();
}
