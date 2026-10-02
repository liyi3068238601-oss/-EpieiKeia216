// Reuses the pinned Desktop; tests existing local history, not no-key import.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const spec = JSON.parse(await readFile(process.argv[2], 'utf8'));
const {_electron} = createRequire(import.meta.url)(spec.playwright);
const exec = promisify(execFile);
const snapshots = [];
let app;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function capture(page, name) {
  await writeFile(`${spec.out}/${name}.txt`, await page.locator('body').innerText());
}
async function settingsPage(first) {
  await first.keyboard.press('Control+,');
  for (let attempt = 0; attempt < 150; attempt++) {
    for (const page of app.windows()) if (await page.getByTestId('settings-page').count()) return page;
    await sleep(100);
  }
  throw new Error('Native settings did not open');
}
async function ready(first) {
  await first.waitForLoadState('domcontentloaded');
  for (let attempt = 0; attempt < 250; attempt++) {
    const api = first.getByTestId('login-use-api-key-button');
    if (await api.count()) {
      await api.click();
      assert.equal(await first.locator('input[type="password"]').inputValue(), '');
      await first.getByRole('button', {name:/暂时跳过|Skip for now|Skip/i}).click();
      await api.waitFor({state:'detached'});
    }
    if (await first.getByTestId('onboarding-page').count()) {
      await first.getByRole('button', {name:/^(跳过|Skip)$/}).click();
    } else if (await first.getByRole('button', {name:/^(Send|发送)$/}).count()) return;
    await sleep(100);
  }
  throw new Error('No-Key native workspace did not become ready');
}
async function verifyHistory(first, launch) {
  const title = first.getByText(spec.user_marker, {exact:true}).first();
  await title.waitFor({timeout:25000});
  await title.click();
  await first.getByText(spec.assistant_marker, {exact:true}).waitFor({timeout:25000});
  assert.ok((await first.locator('body').innerText()).includes(spec.user_marker));
  await capture(first, `launch-${launch}-history`);
}
try {
  for (let launch=1; launch<=2; launch++) {
    app = await _electron.launch({executablePath:spec.electron, cwd:spec.launch_cwd,
      args:['-r', spec.guard, spec.desktop, '--disable-background-networking', '--open-workspace', spec.workspace], env:spec.env, timeout:45000});
    app.process().stdout?.on('data', data => process.stdout.write(data));
    app.process().stderr?.on('data', data => process.stderr.write(data));
    assert.equal(await app.evaluate(() => globalThis.__p01Guard), true);
    const first = await app.firstWindow({timeout:40000});
    await ready(first);
    const settings = await settingsPage(first);
    await settings.getByTestId('settings-locale-select-trigger').waitFor();
    await capture(settings, `launch-${launch}-settings`);
    const back = settings.getByTestId('settings-back-button');
    if (await back.count()) await back.click();
    else if (settings !== first) await settings.close();
    else await first.keyboard.press('Escape');
    await verifyHistory(first, launch);
    const paths = await app.evaluate(({app, BrowserWindow}) => ({
      home:app.getPath('home'), userData:app.getPath('userData'), sessionData:app.getPath('sessionData'),
      main_pid:process.pid, visible:BrowserWindow.getAllWindows().some(w=>w.isVisible()),
      debug:app.commandLine.getSwitchValue('remote-debugging-port')}));
    assert.equal(paths.visible, false);
    assert.equal(paths.home, spec.env.HOME);
    assert.equal(paths.userData, spec.env.ZCODE_DESKTOP_USER_DATA_DIR);
    assert.equal(paths.sessionData, spec.env.ZCODE_DESKTOP_SESSION_DATA_DIR);
    assert.equal(paths.debug, '0');
    const guards = (await readFile(`${spec.out}/network.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
    const hostPids = guards.filter(x=>x.kind==='utility_fork' && x.pid===paths.main_pid).map(x=>x.child_pid);
    const pids = [paths.main_pid, ...hostPids];
    const {stdout} = await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile','-Command',
      `@(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in @(${pids.join(',')}) } | Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress`],
      {windowsHide:true, env:spec.env, timeout:10000});
    const listeners = stdout.trim() ? JSON.parse(stdout) : [];
    const owned = Array.isArray(listeners) ? listeners : [listeners];
    assert.ok(owned.length>=2);
    assert.ok(owned.every(x=>['127.0.0.1','::1'].includes(x.LocalAddress) && !spec.occupied_ports_before.includes(x.LocalPort)));
    snapshots.push({launch, settings:true, history_visible:true, paths, listeners:owned});
    await app.close(); app=undefined;
  }
  await writeFile(`${spec.out}/ui-result.json`, JSON.stringify({passed:true, snapshots,
    runtime:'Actual Electron Desktop with owned read-only warmup adaptation; native stored-history UI',
    visual_acceptance:'NOT_RUN: functional DOM validation; no visual design claim'}, null, 2));
} catch (error) {
  if (app) for (const [i,page] of app.windows().entries()) await capture(page, `failure-window-${i}`).catch(()=>{});
  throw error;
} finally { await app?.close(); }
