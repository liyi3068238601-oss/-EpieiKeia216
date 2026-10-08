import assert from "node:assert/strict";
import { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openProjectMemoryAudit } from "./project-memory-audit.mjs";

const FILENAME = "p03-memory-audit.jsonl";

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
