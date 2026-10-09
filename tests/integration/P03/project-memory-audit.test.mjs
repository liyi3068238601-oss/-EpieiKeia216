import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openProjectMemoryAudit } from "./project-memory-audit.mjs";

const FILENAME = "p03-memory-audit.jsonl";
const CHILD_APPEND_SOURCE = [
  'import { closeSync, fsyncSync, writeSync } from "node:fs";',
  'const [helperUrl, profileRoot, dev, ino] = process.argv.slice(1);',
  'const { openProjectMemoryAudit } = await import(helperUrl);',
  'const descriptor = openProjectMemoryAudit(profileRoot, { dev: BigInt(dev), ino: BigInt(ino) });',
  'try { const bytes = Buffer.from("separate-process-host\\n"); writeSync(descriptor, bytes, 0, bytes.length, null); fsyncSync(descriptor); }',
  'finally { closeSync(descriptor); }',
].join("\n");

function fixture() {
  // UUID plus exclusive mkdir gives each test its own owned root. Keep it for review.
  const root = path.join(os.tmpdir(), `p03-memory-audit-${randomUUID()}`);
  mkdirSync(root);
  return { root, log: path.join(root, FILENAME) };
}

function appendLine(fd, value) {
  const raw = Buffer.from(`${value}\n`, "utf8");
  let offset = 0;
  while (offset < raw.length) {
    const written = writeSync(fd, raw, offset, raw.length - offset, null);
    assert.ok(written > 0, "append must make progress");
    offset += written;
  }
  fsyncSync(fd);
}

function sameFile(left, right) {
  assert.equal(left.dev, right.dev);
  assert.equal(left.ino, right.ino);
}

const privilegeErrors = new Set(["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"]);

test("first open is single-link regular; a later Host reopens after close and appends without losing bytes", () => {
  const { root, log } = fixture();
  const first = openProjectMemoryAudit(root);
  const firstStat = fstatSync(first);
  assert.ok(firstStat.isFile());
  assert.equal(firstStat.nlink, 1);
  sameFile(firstStat, lstatSync(log));
  const knownIdentity = lstatSync(log, { bigint: true });
  assert.throws(() => openProjectMemoryAudit(root, { dev: knownIdentity.dev, ino: knownIdentity.ino + 1n }),
    (error) => error.code === "P03_MEMORY_AUDIT_IDENTITY_CHANGED");
  appendLine(first, "first-host");
  closeSync(first);

  const second = openProjectMemoryAudit(root);
  try {
    appendLine(second, "resumed-host");
    assert.equal(readFileSync(log, "utf8"), "first-host\nresumed-host\n");
  } finally {
    closeSync(second);
  }
});

test("simultaneous Hosts receive distinct append descriptors for the same inode", () => {
  const { root, log } = fixture();
  const first = openProjectMemoryAudit(root);
  try {
    const second = openProjectMemoryAudit(root);
    try {
      assert.notEqual(first, second, "Host descriptors must not be shared");
      const firstStat = fstatSync(first);
      const secondStat = fstatSync(second);
      sameFile(firstStat, secondStat);
      assert.equal(firstStat.nlink, 1);
      assert.equal(lstatSync(log).nlink, 1);
      appendLine(first, "host-one");
      appendLine(second, "host-two");
      assert.equal(readFileSync(log, "utf8"), "host-one\nhost-two\n");
    } finally {
      closeSync(second);
    }
  } finally {
    closeSync(first);
  }
});

test("an existing audit file without this process's identity is refused with EEXIST and preserved", () => {
  const { root, log } = fixture();
  writeFileSync(log, "unknown-existing-bytes\n", { flag: "wx" });
  assert.throws(() => openProjectMemoryAudit(root), (error) => error.code === "EEXIST");
  assert.equal(readFileSync(log, "utf8"), "unknown-existing-bytes\n");
});

test("a parent-created audit file can be opened with its exact inode pin", () => {
  const { root, log } = fixture();
  writeFileSync(log, "parent-created-bytes\n", { flag: "wx" });
  const parentStat = lstatSync(log, { bigint: true });
  const descriptor = openProjectMemoryAudit(root, { dev: parentStat.dev, ino: parentStat.ino });
  try {
    appendLine(descriptor, "pinned-host");
    assert.equal(readFileSync(log, "utf8"), "parent-created-bytes\npinned-host\n");
  } finally {
    closeSync(descriptor);
  }
});

test("a separate Node process can append only with the parent's explicit inode pin", () => {
  const { root, log } = fixture();
  writeFileSync(log, "parent-seed-bytes\n", { flag: "wx" });
  const parentStat = lstatSync(log, { bigint: true });
  const helperUrl = new URL("./project-memory-audit.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    CHILD_APPEND_SOURCE,
    helperUrl,
    root,
    parentStat.dev.toString(10),
    parentStat.ino.toString(10),
  ], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
  assert.equal(readFileSync(log, "utf8"), "parent-seed-bytes\nseparate-process-host\n");
});

test("a wrong parent inode pin is rejected without changing the existing bytes", () => {
  const { root, log } = fixture();
  writeFileSync(log, "preserve-on-wrong-pin\n", { flag: "wx" });
  const actual = lstatSync(log, { bigint: true });
  assert.throws(() => openProjectMemoryAudit(root, { dev: actual.dev, ino: actual.ino + 1n }),
    (error) => error.code === "P03_MEMORY_AUDIT_IDENTITY_CHANGED");
  assert.equal(readFileSync(log, "utf8"), "preserve-on-wrong-pin\n");
});

test("parent identity pins require exactly nonnegative BigInt dev and ino", () => {
  const { root, log } = fixture();
  writeFileSync(log, "preserve-on-invalid-pin\n", { flag: "wx" });
  const actual = lstatSync(log, { bigint: true });
  const invalidPins = [
    { dev: actual.dev, ino: actual.ino, extra: 1n },
    { dev: Number(actual.dev), ino: actual.ino },
    { dev: actual.dev, ino: -1n },
  ];
  for (const pin of invalidPins) {
    assert.throws(() => openProjectMemoryAudit(root, pin),
      (error) => error.code === "P03_MEMORY_AUDIT_PARENT_IDENTITY_INVALID");
  }
  assert.equal(readFileSync(log, "utf8"), "preserve-on-invalid-pin\n");
});

test("a renamed audit file replaced at its path is rejected without truncation or deletion", () => {
  const { root, log } = fixture();
  const original = openProjectMemoryAudit(root);
  appendLine(original, "original-inode");
  closeSync(original);
  const renamed = `${log}.renamed`;
  renameSync(log, renamed);
  writeFileSync(log, "replacement-inode\n", { flag: "wx" });

  assert.throws(() => openProjectMemoryAudit(root), (error) => error.code === "P03_MEMORY_AUDIT_IDENTITY_CHANGED");
  assert.equal(readFileSync(renamed, "utf8"), "original-inode\n");
  assert.equal(readFileSync(log, "utf8"), "replacement-inode\n");
});

test("a parent-pinned inode replaced at its path is rejected without changing either file", () => {
  const { root, log } = fixture();
  writeFileSync(log, "parent-original-inode\n", { flag: "wx" });
  const originalStat = lstatSync(log, { bigint: true });
  const originalPath = `${log}.parent-original`;
  renameSync(log, originalPath);
  writeFileSync(log, "parent-replacement-inode\n", { flag: "wx" });

  assert.throws(() => openProjectMemoryAudit(root, { dev: originalStat.dev, ino: originalStat.ino }),
    (error) => error.code === "P03_MEMORY_AUDIT_IDENTITY_CHANGED");
  assert.equal(readFileSync(originalPath, "utf8"), "parent-original-inode\n");
  assert.equal(readFileSync(log, "utf8"), "parent-replacement-inode\n");
});

test("a hard-linked audit inode is refused when the platform permits creating a hard link", (t) => {
  const { root, log } = fixture();
  const first = openProjectMemoryAudit(root);
  appendLine(first, "single-link-before-test");
  closeSync(first);
  const alias = `${log}.hardlink`;
  try {
    linkSync(log, alias);
  } catch (error) {
    if (privilegeErrors.has(error.code)) {
      t.skip(`hard-link creation unavailable on this host (${error.code})`);
      return;
    }
    throw error;
  }
  assert.equal(lstatSync(log).nlink, 2);
  assert.throws(() => openProjectMemoryAudit(root), (error) => error.code === "P03_MEMORY_AUDIT_PATH_INVALID");
  assert.equal(readFileSync(log, "utf8"), "single-link-before-test\n");
  assert.equal(readFileSync(alias, "utf8"), "single-link-before-test\n");
});

test("a parent-pinned hard-linked audit inode is refused when the platform permits creating a hard link", (t) => {
  const { root, log } = fixture();
  writeFileSync(log, "parent-single-link-before-test\n", { flag: "wx" });
  const parentStat = lstatSync(log, { bigint: true });
  const alias = `${log}.parent-hardlink`;
  try {
    linkSync(log, alias);
  } catch (error) {
    if (privilegeErrors.has(error.code)) {
      t.skip(`hard-link creation unavailable on this host (${error.code})`);
      return;
    }
    throw error;
  }
  assert.equal(lstatSync(log).nlink, 2);
  assert.throws(() => openProjectMemoryAudit(root, { dev: parentStat.dev, ino: parentStat.ino }),
    (error) => error.code === "P03_MEMORY_AUDIT_PATH_INVALID");
  assert.equal(readFileSync(log, "utf8"), "parent-single-link-before-test\n");
  assert.equal(readFileSync(alias, "utf8"), "parent-single-link-before-test\n");
});

test("a symlink replacement is rejected and left untouched when the platform permits creating it", (t) => {
  const { root, log } = fixture();
  const first = openProjectMemoryAudit(root);
  appendLine(first, "original-file");
  closeSync(first);
  const original = `${log}.original`;
  const target = path.join(root, "symlink-target.txt");
  renameSync(log, original);
  writeFileSync(target, "symlink-target-bytes\n", { flag: "wx" });
  try {
    symlinkSync(target, log, "file");
  } catch (error) {
    if (privilegeErrors.has(error.code)) {
      t.skip(`symlink creation unavailable on this host (${error.code})`);
      return;
    }
    throw error;
  }

  assert.throws(() => openProjectMemoryAudit(root), (error) => error.code === "P03_MEMORY_AUDIT_PATH_INVALID");
  assert.ok(lstatSync(log).isSymbolicLink());
  assert.equal(readFileSync(original, "utf8"), "original-file\n");
  assert.equal(readFileSync(target, "utf8"), "symlink-target-bytes\n");
});
