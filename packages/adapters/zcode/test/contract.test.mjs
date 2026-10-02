import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");

test("Xiadie installs as a narrow ZCode process Hook without adding a Loop or command shell", async () => {
  const plugin = JSON.parse(await readFile(path.join(repositoryRoot, "plugins", "xiadie", ".zcode-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(await readFile(path.join(repositoryRoot, "plugins", "xiadie", "marketplace.json"), "utf8"));
  const hookConfig = JSON.parse(await readFile(path.join(repositoryRoot, "plugins", "xiadie", "hooks", "hooks.json"), "utf8"));

  assert.equal(plugin.name, "xiadie");
  assert.equal(plugin.version, "0.1.0");
  assert.deepEqual(Object.keys(marketplace.plugins[0]).sort(), ["name", "source", "version"]);
  assert.deepEqual(Object.keys(hookConfig.hooks), ["UserPromptSubmit"]);
  assert.equal(hookConfig.hooks.UserPromptSubmit.length, 1);
  const processHook = hookConfig.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(processHook.type, "process");
  assert.equal(processHook.command, "node");
  assert.deepEqual(processHook.args, ["${ZCODE_PLUGIN_ROOT}/hooks/context.mjs"]);
  assert.equal(processHook.timeoutMs, 8000);
  assert.equal(typeof processHook.shell, "undefined");
  assert.equal(typeof processHook.commandString, "undefined");
});

test("real Hook process rejects oversized stdin and conflicting JSON aliases before any injection", () => {
  const hookPath = path.join(repositoryRoot, "plugins", "xiadie", "hooks", "context.mjs");
  const processEnv = {
    PATH: process.env.PATH ?? "",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  };
  const oversized = spawnSync(process.execPath, [hookPath], {
    input: `{"hookEventName":"UserPromptSubmit","padding":"${"x".repeat(128 * 1024)}"}`,
    encoding: "utf8",
    env: processEnv,
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(oversized.error, undefined);
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, "");
  assert.match(oversized.stderr, /stdin exceeds its byte bound/);

  const conflictingAliases = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ hookEventName: "UserPromptSubmit", hook_event_name: "Stop" }),
    encoding: "utf8",
    env: processEnv,
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(conflictingAliases.error, undefined);
  assert.equal(conflictingAliases.status, 1);
  assert.equal(conflictingAliases.stdout, "");
  assert.match(conflictingAliases.stderr, /Hook aliases disagree/);
});
