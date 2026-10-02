import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const driverPath = fileURLToPath(import.meta.url);
const driverDir = path.dirname(driverPath);
const resultSchema = "p01-u10-desktop-ui/v1";
const execFileAsync = promisify(execFile);

function requireAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`invalid_${name}`);
  return value;
}

function validateSpec(spec) {
  const keys = new Set([
    "candidate", "desktop", "electron", "playwright", "guard", "workspace", "out", "env",
    "scenario_id", "flow", "prompt", "expected_reply", "partial_reply", "model", "target_model",
    "profile_paths", "gate_mode", "relay_origin", "occupied_ports_before", "history_markers",
    "cancel_file",
  ]);
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || Object.keys(spec).some((key) => !keys.has(key))) {
    throw new Error("invalid_spec");
  }
  for (const key of ["candidate", "desktop", "electron", "playwright", "guard", "workspace", "out"]) {
    requireAbsolute(spec[key], key);
  }
  if (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env)) throw new Error("invalid_env");
  if (!/^[a-z0-9_]+$/.test(spec.scenario_id) || !["reply", "cancel_recovery", "no_key", "offline", "pro_denied"].includes(spec.flow)) {
    throw new Error("invalid_flow");
  }
  if (spec.gate_mode !== "enabled" && spec.gate_mode !== "disabled") throw new Error("invalid_gate_mode");
  return spec;
}

const specPath = process.argv[2];
if (process.argv.length !== 3 || !path.isAbsolute(specPath)) throw new Error("usage");
const spec = validateSpec(JSON.parse(await readFile(specPath, "utf8")));
const { _electron } = createRequire(driverPath)(spec.playwright);
let app;
const result = {
  schema: resultSchema,
  scenario_id: spec.scenario_id,
  status: "running",
  gate_mode: spec.gate_mode,
  flow: spec.flow,
  ui_actions: [],
  user_visible_reply: null,
  error_banner: null,
  model_selection: { expected: spec.model ?? null, pro_item_available: null, selected: null },
  desktop: null,
};

async function saveJson(name, value) {
  await writeFile(path.join(spec.out, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function snapshot(page, name) {
  const body = await page.locator("body").innerText();
  await writeFile(path.join(spec.out, `${name}.txt`), `${body}\n`, { flag: "wx" });
  return body;
}

async function descendantProcesses(rootPid) {
  const powershell = path.join(spec.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-Command", command], {
    cwd: spec.candidate,
    env: spec.env,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const children = new Map();
  for (const item of processes) {
    const parent = Number(item.ParentProcessId);
    if (!Number.isInteger(parent)) continue;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  const descendants = [];
  const seen = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length) {
    const parent = pending.pop();
    for (const item of children.get(parent) ?? []) {
      const pid = Number(item.ProcessId);
      if (!Number.isInteger(pid) || seen.has(pid)) continue;
      seen.add(pid);
      pending.push(pid);
      descendants.push({ pid, parent_pid: parent, name: String(item.Name ?? "unknown") });
    }
  }
  return descendants;
}

async function openSettings(initial) {
  await initial.keyboard.press("Control+,");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (await page.getByTestId("settings-page").count()) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("settings_page_unavailable");
}

async function readyWorkspace(first) {
  await first.waitForLoadState("domcontentloaded");
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const composer = first.getByTestId("v4-composer-input");
    if (await composer.isVisible().catch(() => false)) return;

    const apiKeyPage = first.getByTestId("login-use-api-key-button");
    if (await apiKeyPage.isVisible().catch(() => false)) {
      await apiKeyPage.click();
      const password = first.locator("input[type='password']");
      assert.equal(await password.inputValue(), "", "fresh owned profile unexpectedly contains a saved API key");
      await first.getByRole("button", { name: /暂时跳过|Skip for now|Skip/i }).click();
      await apiKeyPage.waitFor({ state: "detached" });
      result.ui_actions.push("skipped-key-onboarding-with-empty-password");
      continue;
    }

    const onboarding = first.getByTestId("onboarding-page");
    if (await onboarding.isVisible().catch(() => false)) {
      const skip = first.getByRole("button", { name: /^(跳过|Skip)$/ });
      if (!(await skip.isVisible().catch(() => false)) || !(await skip.isEnabled().catch(() => false))) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      const heading = await onboarding.getByRole("heading", { level: 1 }).innerText().catch(() => "");
      await skip.click();
      result.ui_actions.push("skipped-local-onboarding-step");
      const stepDeadline = Date.now() + 15_000;
      while (Date.now() < stepDeadline) {
        if (await composer.isVisible().catch(() => false)) return;
        if (!(await onboarding.isVisible().catch(() => false))) break;
        const nextHeading = await onboarding.getByRole("heading", { level: 1 }).innerText().catch(() => "");
        if (nextHeading && nextHeading !== heading) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("composer_not_ready_after_onboarding");
}

async function selectModel(page, model) {
  if (!model) return false;
  const trigger = page.getByTestId("chat-model-select-trigger");
  if (!(await trigger.count())) return false;
  await trigger.click();
  const item = page.getByTestId(`chat-model-select-item-${model}`);
  const available = await item.count() > 0;
  if (model === "deepseek-v4-pro") result.model_selection.pro_item_available = available;
  if (available && await item.isEnabled()) {
    await item.click();
    result.model_selection.selected = model;
    return true;
  }
  return false;
}

async function send(page, prompt) {
  const input = page.getByTestId("v4-composer-input");
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await input.fill(prompt);
  result.ui_actions.push("filled-v4-composer-input");
  const button = page.getByTestId("v4-composer-send");
  await button.waitFor({ state: "visible", timeout: 10_000 });
  if (await button.isEnabled()) {
    await button.click();
    result.ui_actions.push("clicked-v4-composer-send");
    return { button_enabled: true };
  }
  await input.press("Enter");
  result.ui_actions.push("pressed-enter-with-send-disabled");
  return { button_enabled: false };
}

async function waitForVisibleText(page, text, timeout = 45_000) {
  const assistantRows = page.locator('[data-testid^="v4-row-"][class*="group/assistant-row"]');
  const assistantReply = assistantRows.filter({ hasText: text }).last();
  await assistantReply.waitFor({ state: "visible", timeout });
  const visibleAssistantText = await assistantReply.innerText();
  assert.ok(visibleAssistantText.includes(text), "expected text was not in an assistant response row");
  await page.getByTestId("v4-stop").waitFor({ state: "detached", timeout: 20_000 });
  const body = await snapshot(page, `ui-${spec.scenario_id}-final`);
  assert.ok(body.includes(text), "verified assistant response was not present in the renderer snapshot");
  result.user_visible_reply = text;
}

async function waitForVisibleAssistantText(page, text, timeout = 15_000) {
  const assistantRows = page.locator('[data-testid^="v4-row-"][class*="group/assistant-row"]');
  const partial = assistantRows.filter({ hasText: text }).last();
  await partial.waitFor({ state: "visible", timeout });
  assert.ok((await partial.innerText()).includes(text), "streamed text was not in an assistant response row");
}

async function waitForError(page) {
  const banner = page.getByTestId("chat-error-banner");
  await banner.waitFor({ state: "visible", timeout: 30_000 });
  const errorCode = await banner.getAttribute("data-error-code");
  result.error_banner = { visible: true, error_code: errorCode ?? null };
  await snapshot(page, `ui-${spec.scenario_id}-error`);
}

async function inspectHistory(page) {
  if (!Array.isArray(spec.history_markers) || spec.history_markers.length !== 2) throw new Error("history_markers_missing");
  const userMarker = page.getByText(spec.history_markers[0], { exact: true }).first();
  await userMarker.waitFor({ state: "visible", timeout: 25_000 });
  await userMarker.click();
  await page.getByText(spec.history_markers[1], { exact: true }).waitFor({ state: "visible", timeout: 25_000 });
  result.ui_actions.push("opened-native-synthetic-history-in-renderer");
  await snapshot(page, `ui-${spec.scenario_id}-history`);
}

async function inspectSettings(page) {
  const settings = await openSettings(page);
  await settings.getByTestId("settings-locale-select-trigger").waitFor({ state: "visible", timeout: 15_000 });
  result.ui_actions.push("opened-native-settings-page");
  await snapshot(settings, `ui-${spec.scenario_id}-settings`);
  const back = settings.getByTestId("settings-back-button");
  if (await back.count()) await back.click();
  else if (settings !== page) await settings.close();
  else await page.keyboard.press("Escape");
}

try {
  app = await _electron.launch({
    executablePath: spec.electron,
    cwd: spec.candidate,
    args: ["-r", spec.guard, spec.desktop, "--disable-background-networking", "--open-workspace", spec.workspace],
    env: spec.env,
    timeout: 45_000,
  });
  await writeFile(path.join(spec.out, "desktop-main.pid"), `${app.process().pid}\n`, { flag: "wx" });
  if (typeof spec.cancel_file === "string" && path.isAbsolute(spec.cancel_file)) {
    const cancelTimer = setInterval(async () => {
      if (!app || !existsSync(spec.cancel_file)) return;
      clearInterval(cancelTimer);
      await app.close().catch(() => {});
      app = undefined;
      process.exit(124);
    }, 200);
    cancelTimer.unref();
  }
  app.process().stdout?.on("data", (data) => process.stdout.write(data));
  app.process().stderr?.on("data", (data) => process.stderr.write(data));
  const first = await app.firstWindow({ timeout: 45_000 });
  await readyWorkspace(first);
  assert.equal(await app.evaluate(() => globalThis.__p01Guard), true, "Electron main-process guard did not load");
  const desktop = await app.evaluate(({ app: nativeApp, BrowserWindow }) => ({
    main_pid: process.pid,
    cwd: process.cwd(),
    home: nativeApp.getPath("home"),
    userData: nativeApp.getPath("userData"),
    sessionData: nativeApp.getPath("sessionData"),
    visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    remote_debugging_port: nativeApp.commandLine.getSwitchValue("remote-debugging-port"),
  }));
  assert.equal(desktop.cwd, spec.candidate, "Electron did not inherit candidateRoot cwd");
  assert.equal(desktop.visible, false, "the test Electron window became visible");
  assert.equal(desktop.remote_debugging_port, "0", "Desktop fixed inspector port was not disabled");
  assert.equal(desktop.home, spec.profile_paths.home);
  assert.equal(desktop.userData, spec.profile_paths.user_data);
  assert.equal(desktop.sessionData, spec.profile_paths.session_data);
  result.desktop = desktop;
  result.desktop.descendant_processes = await descendantProcesses(desktop.main_pid);
  await snapshot(first, `ui-${spec.scenario_id}-entry`);

  if (spec.flow === "reply") {
    if (spec.model) await selectModel(first, spec.model);
    await send(first, spec.prompt);
    await waitForVisibleText(first, spec.expected_reply);
  } else if (spec.flow === "cancel_recovery") {
    await selectModel(first, "deepseek-flash");
    await send(first, spec.prompt);
    const stop = first.getByTestId("v4-stop");
    await stop.waitFor({ state: "visible", timeout: 20_000 });
    await waitForVisibleAssistantText(first, spec.partial_reply, 15_000);
    result.ui_actions.push("observed-streaming-partial-in-renderer");
    await stop.click();
    result.ui_actions.push("clicked-native-stop-button");
    await stop.waitFor({ state: "detached", timeout: 20_000 });
    await send(first, "请恢复后简短回应，不要复述我刚才的要求。");
    await waitForVisibleText(first, spec.expected_reply, 30_000);
  } else if (spec.flow === "no_key") {
    await inspectHistory(first);
    await first.getByTestId("conversation-new-task").click();
    result.ui_actions.push("clicked-new-conversation-task");
    const sendResult = await send(first, spec.prompt);
    result.no_key_send_button_enabled = sendResult.button_enabled;
    if (sendResult.button_enabled) {
      await waitForError(first);
    } else {
      result.error_banner = { visible: false, refused_by_disabled_control: true };
      await snapshot(first, `ui-${spec.scenario_id}-send-disabled`);
    }
    await inspectSettings(first);
  } else if (spec.flow === "offline") {
    if (spec.history_markers) {
      await inspectHistory(first);
      await first.getByTestId("conversation-new-task").click();
      result.ui_actions.push("clicked-new-conversation-task");
    }
    await selectModel(first, "deepseek-flash");
    await send(first, spec.prompt);
    await waitForError(first);
    await inspectSettings(first);
    if (spec.history_markers) await inspectHistory(first);
  } else if (spec.flow === "pro_denied") {
    const selected = await selectModel(first, "deepseek-v4-pro");
    result.model_selection.pro_selected = selected;
    if (selected) {
      await send(first, spec.prompt);
      await waitForError(first);
    } else {
      await snapshot(first, `ui-${spec.scenario_id}-pro-unavailable`);
    }
  }

  result.desktop.descendant_processes = await descendantProcesses(result.desktop.main_pid);
  result.status = "completed";
  result.passed = true;
  await saveJson("ui-result.json", result);
  process.stdout.write(`${JSON.stringify({ kind: "p01_u10_ui_result", scenario_id: spec.scenario_id, passed: true })}\n`);
} catch (error) {
  result.status = "failed";
  result.passed = false;
  result.failure_code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "ui_assertion_failed";
  const firstLine = error instanceof Error ? error.message.split(/\r?\n/u, 1)[0] : "unknown_failure";
  result.failure_details = {
    name: error instanceof Error && ["Error", "TypeError", "RangeError", "AssertionError", "TimeoutError"].includes(error.name)
      ? error.name : "Unknown",
    code: error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? error.code : "unknown",
    operator: error && typeof error.operator === "string" && /^[a-z]+$/u.test(error.operator) ? error.operator : null,
    message: firstLine.slice(0, 240),
    stack: error instanceof Error && typeof error.stack === "string"
      ? error.stack.split(/\r?\n/u).slice(0, 8).join("\n").slice(0, 1600) : null,
    windows: app?.windows().length ?? 0,
  };
  if (result.desktop?.main_pid) {
    result.desktop.descendant_processes = await descendantProcesses(result.desktop.main_pid).catch(() => []);
  }
  if (app) {
    for (const [index, page] of app.windows().entries()) {
      await snapshot(page, `ui-${spec.scenario_id}-failure-window-${index}`).catch(() => {});
    }
  }
  await saveJson("ui-result.json", result).catch(() => {});
  process.stderr.write(`P01_U10_UI_FAILED:${result.failure_code}\n`);
  process.exitCode = 1;
} finally {
  await app?.close();
}
