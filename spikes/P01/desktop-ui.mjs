// Automate the actual pinned Electron Desktop; no substitute settings page.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const require = createRequire(import.meta.url);
const { _electron } = require(spec.playwright);
const snapshots = [];
const captures = [];
let app;
async function checkpoint(page, name) {
  await writeFile(`${spec.out}/${name}.txt`, await page.locator('body').innerText());
  const window = await app.browserWindow(page);
  let timer;
  try {
    const png = await Promise.race([
      window.evaluate(async win => (await win.webContents.capturePage(undefined,
        { stayHidden: true, stayAwake: true })).toPNG().toString('base64')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native hidden capture timed out')), 10000); }),
    ]);
    assert.ok(png, 'Native hidden-window capture was empty');
    await writeFile(`${spec.out}/${name}.png`, Buffer.from(png, 'base64'));
    captures.push({ checkpoint: name, status: 'captured; visual review required' });
  } catch (error) {
    // U02's native DOM/settings persistence proof is separate from visual
    // rendering. Preserve this limitation; no screenshot/visual pass is claimed.
    captures.push({ checkpoint: name, status: 'NOT_RUN', reason: error.message });
  } finally { clearTimeout(timer); }
}
async function openSettings(initial) {
  await initial.keyboard.press('Control+,');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (await page.getByTestId('settings-page').count()) return page;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Actual SettingsPage did not become reachable');
}
try {
  for (let launch = 1; launch <= 2; launch++) {
    app = await _electron.launch({ executablePath: spec.electron, cwd: spec.desktop,
      args: ['-r', spec.guard, spec.desktop, '--disable-background-networking'], env: spec.env, timeout: 45000 });
    app.process().stdout?.on('data', data => process.stdout.write(data));
    app.process().stderr?.on('data', data => process.stderr.write(data));
    assert.equal(await app.evaluate(() => globalThis.__p01Guard), true, 'main preload guard did not load');
    const first = await app.firstWindow({ timeout: 40000 });
    await first.waitForLoadState('domcontentloaded');
    await first.getByTestId('login-use-api-key-button').waitFor({ timeout: 40000 });
    await checkpoint(first, `launch-${launch}-entry`);
    if (await first.getByTestId('login-use-api-key-button').count()) {
      await first.getByTestId('login-use-api-key-button').click();
      const input = first.locator('input[type="password"]');
      assert.equal(await input.inputValue(), '', 'fresh profile unexpectedly has a key');
      await first.getByRole('button', { name: /暂时跳过|Skip for now|Skip/i }).click();
      await first.getByTestId('login-use-api-key-button').waitFor({ state: 'detached' });
    }
    // Fresh native profiles show a three-step local onboarding screen after
    // skipping Key. Skip each step without migrations, memories or agents.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await first.getByTestId('onboarding-page').count()) {
        await first.getByRole('button', { name: /^(跳过|Skip)$/ }).click();
        await new Promise(r => setTimeout(r, 150));
        continue;
      }
      if (await first.getByTestId('workspace-list').count()) break;
      try {
        const local = JSON.parse(await readFile(spec.settings_file, 'utf8'));
        if (local.onboardingOccupation && !await first.getByTestId('onboarding-page').count()) break;
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    await first.getByRole('button', { name: /^(Send|发送)$/ }).first().waitFor({ timeout: 20000 });
    const settings = await openSettings(first);
    const trigger = settings.getByTestId('settings-locale-select-trigger');
    await trigger.waitFor();
    if (launch === 1) {
      await trigger.click();
      await settings.locator('[data-testid^="settings-locale-select-item"][data-testid$="en-US"]').click();
      const deadline = Date.now() + 10000;
      let saved;
      while (Date.now() < deadline) {
        try { saved = JSON.parse(await readFile(spec.settings_file, 'utf8')); } catch {}
        if (saved?.localePreference === 'en-US') break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(saved?.localePreference, 'en-US', 'UI language choice did not persist to native setting.json');
    }
    assert.match(await trigger.innerText(), /English/i, 'native Settings did not read the saved language');
    const persisted = JSON.parse(await readFile(spec.settings_file, 'utf8'));
    assert.equal(persisted.localePreference, 'en-US');
    await checkpoint(settings, `launch-${launch}-settings`);
    const paths = await app.evaluate(({ app, BrowserWindow }) => ({ home: app.getPath('home'),
      userData: app.getPath('userData'), sessionData: app.getPath('sessionData'),
      main_pid: process.pid, remote_debugging_port_switch: app.commandLine.getSwitchValue('remote-debugging-port'),
      visible: BrowserWindow.getAllWindows().some(w => w.isVisible()) }));
    assert.equal(paths.visible, false, 'test window became visible');
    assert.equal(paths.home, spec.env.ZCODE_DESKTOP_HOME_DIR);
    assert.equal(paths.userData, spec.env.ZCODE_DESKTOP_USER_DATA_DIR);
    assert.equal(paths.sessionData, spec.env.ZCODE_DESKTOP_SESSION_DATA_DIR);
    assert.equal(paths.remote_debugging_port_switch, '0', 'native fixed ZCode debugging port was not disabled');
    const guards = (await readFile(`${spec.out}/network.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
    const hostPids = guards.filter(q => q.kind === 'utility_fork' && q.pid === paths.main_pid).map(q => q.child_pid);
    assert.ok(hostPids.length, 'Native Host utility process was not observed');
    assert.ok(hostPids.every(pid => guards.some(q => q.kind === 'guard_loaded' && q.pid === pid)), 'Utility egress guard was not loaded');
    const pids = [paths.main_pid, ...hostPids];
    const { stdout } = await execFileAsync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile','-Command',
      `@(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in @(${pids.join(',')}) } | Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress`],
      { windowsHide: true, env: spec.env, timeout: 10000 });
    const listeners = stdout.trim() ? JSON.parse(stdout) : [];
    const ownListeners = Array.isArray(listeners) ? listeners : [listeners];
    assert.ok(ownListeners.length >= 2, 'Dynamic inspector/CDP listeners were not observed');
    assert.ok(ownListeners.every(q => !spec.occupied_ports_before.includes(q.LocalPort)), 'An experiment port overlaps an existing listener');
    assert.ok(ownListeners.every(q => ['127.0.0.1','::1'].includes(q.LocalAddress)), 'An experiment listener is not loopback-only');
    snapshots.push({ launch, actual_settings_page: true, localePreference: persisted.localePreference,
      locale: persisted.locale, paths, listeners: ownListeners, url: settings.url() });
    await app.close(); app = undefined;
  }
  await writeFile(`${spec.out}/ui-result.json`, JSON.stringify({ passed: true, snapshots, captures,
    visual_acceptance: 'NOT_RUN; functional DOM/settings evidence only' }, null, 2));
  console.log(JSON.stringify({ type: 'actual_desktop_ui', passed: true, launches: 2 }));
} catch (error) {
  if (app) {
    for (const [index, page] of app.windows().entries()) {
      try { await checkpoint(page, `failure-window-${index}`); } catch {}
    }
  }
  throw error;
} finally { await app?.close(); }
