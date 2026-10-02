import assert from "node:assert/strict";
import {mkdtemp, mkdir, realpath, rm, symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {resolveDesktopBuildPaths} from "../desktop-build.mjs";

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "p01-u08-desktop-paths-"));
  t.after(async () => {
    const physicalTemp = await realpath(os.tmpdir());
    const physicalRoot = await realpath(root);
    assert.equal(path.dirname(physicalRoot), physicalTemp, "fixture cleanup must stay directly under the OS temp root");
    assert.ok(
      path.basename(physicalRoot).startsWith("p01-u08-desktop-paths-"),
      "fixture cleanup must target only this test's temporary directory",
    );
    await rm(physicalRoot, {recursive: true, force: false});
  });
  const source = path.join(root, "ReferenceSource");
  await mkdir(source);
  return {root, source};
}

test("rejects the same physical source root and existing or future descendants", async (t) => {
  const {source} = await makeFixture(t);
  const existingChild = path.join(source, "existing-child");
  await mkdir(existingChild);

  await assert.rejects(resolveDesktopBuildPaths(source, source), /outside the physical reference source tree/);
  await assert.rejects(
    resolveDesktopBuildPaths(source, existingChild),
    /outside the physical reference source tree/,
  );
  await assert.rejects(
    resolveDesktopBuildPaths(source, path.join(source, "future-child", "assembly")),
    /outside the physical reference source tree/,
  );
});

test("rejects a Windows case-variant alias of the source tree", {skip: process.platform !== "win32"}, async (t) => {
  const {source} = await makeFixture(t);
  const caseVariant = path.join(source.toLowerCase(), "future-child");

  await assert.rejects(
    resolveDesktopBuildPaths(source, source.toLowerCase()),
    /outside the physical reference source tree/,
  );
  await assert.rejects(
    resolveDesktopBuildPaths(source, caseVariant),
    /outside the physical reference source tree/,
  );
});

test("allows a prefix-adjacent sibling output directory", async (t) => {
  const {root, source} = await makeFixture(t);
  const sibling = path.join(root, `${path.basename(source)}-output`);
  const paths = await resolveDesktopBuildPaths(source, sibling);

  assert.equal(paths.source, await realpath(source));
  assert.equal(paths.assemblyRoot, sibling);
});

test("resolves an existing junction ancestor before checking containment", async (t) => {
  const {root, source} = await makeFixture(t);
  const alias = path.join(root, "reference-alias");
  await symlink(source, alias, "junction");

  await assert.rejects(
    resolveDesktopBuildPaths(source, path.join(alias, "future-output")),
    /outside the physical reference source tree/,
  );
});
