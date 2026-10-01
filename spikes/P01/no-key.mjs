// Isolated native control-plane experiment; this is not a desktop UI test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import net from 'node:net';

const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(homedir(), spec.home);
assert.equal(process.env.ZCODE_SESSION_DB_PATH, spec.db);
assert.equal(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, spec.personal);
assert.equal(process.env.HOME, undefined);

// Instrument the isolated child before loading native code. Not an OS sandbox.
const networkAttempts = [];
net.Socket.prototype.connect = function () {
  networkAttempts.push('connect');
  throw new Error('P01 no-Key fixture: network disabled');
};
globalThis.fetch = async function () {
  networkAttempts.push('fetch');
  throw new Error('P01 no-Key fixture: network disabled');
};

const load = path => import(pathToFileURL(resolve(path)).href);
const bootstrap = await load(spec.bootstrap);
const { ProviderSettingsFacade } = await load(spec.provider);
const { SqliteSessionStore } = await load(spec.storage);
let registry;
let store;
let result;
try {
  // A synthetic local record, explicitly seeded without a model or user data.
  store = await SqliteSessionStore.openStartup({ dbPath: spec.db });
  await store.createSession({ id: 'p01-synthetic-record', projectID: 'p01-fixture',
    slug: 'p01-local', title: 'P01 synthetic local record',
    directory: spec.fixture, version: '0.16.9' });
  store.close();
  store = await SqliteSessionStore.openStartup({ dbPath: spec.db });
  const sessions = await store.listSessions({ projectID: 'p01-fixture' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'p01-synthetic-record');
  assert.equal(await store.getSession('missing-synthetic-record'), null);

  registry = await bootstrap.startProcessProviderRegistryRuntime(process.env);
  const facade = new ProviderSettingsFacade(registry.runtime.registryService);
  const initial = facade.getView();
  const initialConfig = await registry.runtime.configService.read();
  assert.equal(initialConfig.personalProviders.toJSON().length, 0);
  const created = await registry.runtime.configService.createPersonalProvider({
    providerName: 'P01 empty-key local fixture',
  });
  await registry.runtime.registryService.refresh('p01-local-settings-save');
  const saved = facade.getView();
  const config = await registry.runtime.configService.read();
  const rule = config.personalProviders.getRule(created.providerId);
  assert.ok(rule);
  assert.equal(rule.providerName, 'P01 empty-key local fixture');
  assert.ok(!rule.config.access.toJSON().apiKey);
  registry.dispose(); registry = undefined;
  registry = await bootstrap.startProcessProviderRegistryRuntime(process.env);
  const reloaded = await registry.runtime.configService.read();
  assert.equal(reloaded.personalProviders.getRule(created.providerId).providerName,
    'P01 empty-key local fixture');
  await registry.runtime.configService.deletePersonalProvider(created.providerId);
  await registry.runtime.registryService.refresh('p01-local-settings-delete');
  assert.equal((await registry.runtime.configService.read()).personalProviders.toJSON().length, 0);
  result = { type: 'no_key_control_plane', passed: true,
    native_settings_facade: true, local_provider_save_reload_delete: true,
    local_record_read_after_reopen: true, missing_record_returns_null: true,
    initial_view_revision: initial.revision, saved_view_revision: saved.revision,
    no_session_runtime_created: true,
    model_requests: 0, desktop_ui: 'NOT_RUN; control-plane proof only',
  };
} finally {
  store?.close(); registry?.dispose();
  await bootstrap.shutdownZCodeTelemetry();
}
assert.deepEqual(networkAttempts, []);
process.stdout.write(JSON.stringify({ ...result, network_attempts: networkAttempts.length }) + '\n');
