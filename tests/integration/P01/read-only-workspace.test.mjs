import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createReadOnlyWorkspaceFileSystemPort } from "./read-only-workspace.mjs";

async function fixture(t) {
  const parent = realpathSync.native(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, "xiadie-u10-fs-"));
  t.after(async () => {
    const resolved = realpathSync.native(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("xiadie-u10-fs-"));
    await rm(resolved, { recursive: true, force: true });
  });
  const workspace = path.join(directory, "workspace");
  const outside = path.join(directory, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(workspace, "allowed.txt"), "READ_ONLY_MARKER");
  await writeFile(path.join(outside, "private.txt"), "OUTSIDE_MARKER");
  const calls = [];
  const base = {
    label: "native-port",
    async readTextFile(request) { calls.push(request.path); return readFile(request.path, "utf8"); },
    async writeTextFile() { calls.push("write"); throw new Error("should never delegate write"); },
  };
  const port = createReadOnlyWorkspaceFileSystemPort(base, workspace, ({ code, message }) => Object.assign(new Error(message), { code }));
  return { workspace, outside, calls, port };
}

test("candidate filesystem delegates bounded reads and preserves native missing-file failure", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.port.readTextFile({ path: path.join(f.workspace, "allowed.txt") }), "READ_ONLY_MARKER");
  assert.equal(f.port.label, "native-port");
  await assert.rejects(f.port.readTextFile({ path: path.join(f.workspace, "missing.txt") }), { code: "ENOENT" });
  assert.equal(f.calls.length, 2);
});

test("candidate filesystem rejects writes, siblings, traversal and relative paths before delegation", async (t) => {
  const f = await fixture(t);
  for (const request of [
    { path: path.join(f.outside, "private.txt") },
    { path: path.join(f.workspace, "..", "outside", "private.txt") },
    { path: "allowed.txt" },
    { path: 7 },
  ]) await assert.rejects(f.port.readTextFile(request), { code: "permission_denied" });
  await assert.rejects(f.port.writeTextFile({ path: path.join(f.workspace, "allowed.txt"), text: "changed" }), { code: "permission_denied" });
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(path.join(f.workspace, "allowed.txt"), "utf8"), "READ_ONLY_MARKER");
});

test("candidate filesystem rejects an escaping directory link on every read", async (t) => {
  const f = await fixture(t);
  await symlink(f.outside, path.join(f.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.port.readTextFile({ path: path.join(f.workspace, "escape", "private.txt") }), { code: "permission_denied" });
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(path.join(f.outside, "private.txt"), "utf8"), "OUTSIDE_MARKER");
});

test("the pinned native FileSystemPort reads through the candidate boundary", async (t) => {
  const f = await fixture(t);
  const source = process.env.P01_U10_ZCODE_SOURCE ?? "E:/Xiadie/Xiadie/.runtime/P01/desktop-source";
  const load = (file) => import(pathToFileURL(path.join(source, file)).href);
  const { register } = await load("node_modules/tsx/dist/esm/api/index.mjs");
  register();
  const { createNodeFileSystemAdapter } = await load("apps/zcode-cli/packages/adapters/dist/fs/index.js");
  const { createFileSystemError } = await load("apps/zcode-cli/packages/contracts/dist/interfaces/file-system.port.js");
  const port = createReadOnlyWorkspaceFileSystemPort(createNodeFileSystemAdapter({ textSearchEngine: "javascript" }), f.workspace, createFileSystemError);
  const read = await port.readTextFile({ path: path.join(f.workspace, "allowed.txt") });
  assert.equal(read.content, "READ_ONLY_MARKER");
  assert.equal(read.truncated, false);
  await assert.rejects(port.readTextFile({ path: path.join(f.workspace, "missing.txt") }), { code: "not_found" });
  await assert.rejects(port.readTextFile({ path: path.join(f.outside, "private.txt") }), { code: "permission_denied" });
});
