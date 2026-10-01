import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as CharacterApi from "../../../dist/packages/character/src/index.js";

const { loadCharacter, isApprovedCharacter, validateCharacterAsset, APPROVED_CHARACTER } = CharacterApi;
const cwd = process.cwd();
const review = path.join(cwd, ".runtime", "P01", "review-u04");
const fixtureRoot = path.join(review, "probe-fixtures");
const approvedAssets = path.join(cwd, "assets", "character");
const results = [];
const report = (name, fn) => {
  try { fn(); results.push({ name, result: "pass" }); }
  catch (e) { results.push({ name, result: "fail", error: String(e), code: e?.code ?? null }); }
};
const withFixture = (name, fn) => {
  const holder = fs.mkdtempSync(path.join(fixtureRoot, name + "-"));
  const root = path.join(holder, "assets");
  fs.cpSync(approvedAssets, root, { recursive: true });
  try { fn(root, holder); }
  finally {
    const resolved = path.resolve(holder);
    const rel = path.relative(fixtureRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel) || path.dirname(resolved) !== fixtureRoot) throw new Error("Fixture cleanup path escaped its review directory");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
};
const failCode = (fn, code) => assert.throws(fn, (error) => error?.code === code, "expected " + code);
const personaPath = (root) => path.join(root, "xiadie", "v3", "persona.json");
const manifestPath = (root) => path.join(root, "xiadie", "v3", "manifest.json");

fs.mkdirSync(fixtureRoot);
try {
  report("approved-loader-snapshot-is-deep-frozen-read-only-and-authorized", () => {
    const asset = loadCharacter(approvedAssets);
    assert.equal(asset.id, "xiadie");
    assert.equal(asset.version, "v3");
    assert.equal(Object.keys(asset.fields).length, 6);
    assert.equal(isApprovedCharacter(asset), true);
    assert.equal(Object.isFrozen(asset), true);
    assert.equal(Object.isFrozen(asset.fields), true);
    assert.equal(Object.isFrozen(asset.fields.identity.source), true);
    assert.equal(Object.hasOwn(asset, "write"), false);
    assert.throws(() => { asset.fields.identity.text = "changed"; }, TypeError);
    const parsed = JSON.parse(fs.readFileSync(personaPath(approvedAssets), "utf8"));
    const schemaOnly = validateCharacterAsset(parsed);
    assert.equal(isApprovedCharacter(schemaOnly), false);
    assert.equal(isApprovedCharacter(JSON.parse(JSON.stringify(asset))), false);
    assert.equal(Object.keys(CharacterApi).some((key) => /write|save|persist/i.test(key)), false);
  });
  report("missing-root-and-path-like-identity-fail-closed", () => {
    failCode(() => loadCharacter(path.join(fixtureRoot, "missing")), "ASSET_FILE_MISSING");
    failCode(() => loadCharacter(path.join(fixtureRoot, "missing"), "../xiadie", "v3"), "IDENTITY_MISMATCH");
    failCode(() => loadCharacter(path.join(fixtureRoot, "missing"), "xiadie", "../../v0"), "IDENTITY_MISMATCH");
  });
  report("wrongly-named-manifest-or-persona-rejects-loading", () => {
    withFixture("wrong-name", (root) => {
      fs.renameSync(manifestPath(root), manifestPath(root) + ".wrong");
      failCode(() => loadCharacter(root), "ASSET_FILE_MISSING");
    });
    withFixture("wrong-persona-name", (root) => {
      fs.renameSync(personaPath(root), personaPath(root) + ".wrong");
      failCode(() => loadCharacter(root), "ASSET_FILE_MISSING");
    });
  });
  report("tampered-content-and-self-reported-hash-cannot-get-approved", () => {
    withFixture("content-hash", (root) => {
      fs.writeFileSync(personaPath(root), "{}");
      failCode(() => loadCharacter(root), "ASSET_HASH_MISMATCH");
    });
    withFixture("manifest-hash", (root) => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath(root), "utf8"));
      manifest.contentSha256 = "0".repeat(64);
      fs.writeFileSync(manifestPath(root), JSON.stringify(manifest));
      failCode(() => loadCharacter(root), "ASSET_HASH_MISMATCH");
    });
    withFixture("self-reported-hash", (root) => {
      const original = fs.readFileSync(personaPath(root), "utf8");
      const altered = original.replace("遐蝶", "通用助手");
      fs.writeFileSync(personaPath(root), altered);
      const manifest = JSON.parse(fs.readFileSync(manifestPath(root), "utf8"));
      manifest.contentBytes = Buffer.byteLength(altered, "utf8");
      manifest.contentSha256 = createHash("sha256").update(altered).digest("hex");
      fs.writeFileSync(manifestPath(root), JSON.stringify(manifest));
      failCode(() => loadCharacter(root), "ASSET_HASH_MISMATCH");
    });
  });
  report("oversized-manifest-and-persona-reject-before-parse", () => {
    withFixture("large-manifest", (root) => {
      fs.writeFileSync(manifestPath(root), Buffer.alloc(4097));
      failCode(() => loadCharacter(root), "ASSET_TOO_LARGE");
    });
    withFixture("large-persona", (root) => {
      fs.writeFileSync(personaPath(root), Buffer.alloc(32769));
      failCode(() => loadCharacter(root), "ASSET_TOO_LARGE");
    });
  });
  report("schema-required-fields-and-utf8-byte-limits-reject", () => {
    const parsed = JSON.parse(fs.readFileSync(personaPath(approvedAssets), "utf8"));
    delete parsed.fields.identity;
    failCode(() => validateCharacterAsset(parsed), "ASSET_INVALID");
    const multibyte = JSON.parse(fs.readFileSync(personaPath(approvedAssets), "utf8"));
    multibyte.fields.identity.text = "蝶".repeat(700);
    failCode(() => validateCharacterAsset(multibyte), "ASSET_TOO_LARGE");
  });
  report("real-windows-directory-junction-is-rejected-with-outside-copy-intact", () => {
    withFixture("junction", (root, holder) => {
      const version = path.join(root, "xiadie", "v3");
      const outside = path.join(holder, "outside-version");
      fs.renameSync(version, outside);
      fs.symlinkSync(outside, version, "junction");
      assert.equal(fs.lstatSync(version).isSymbolicLink(), true);
      failCode(() => loadCharacter(root), "ASSET_PATH_ESCAPE");
      assert.equal(fs.existsSync(path.join(outside, "persona.json")), true);
    });
  });
} finally {
  const resolved = path.resolve(fixtureRoot);
  if (path.dirname(resolved) !== review) throw new Error("Refusing to clean fixture directory outside review root");
  fs.rmSync(resolved, { recursive: true, force: true });
}

const summary = {
  schema: "p01-u04-counterexample-results/v1",
  cwd,
  node: process.version,
  pinnedContentSha256: APPROVED_CHARACTER.contentSha256,
  apiExports: Object.keys(CharacterApi),
  junctionAttempted: true,
  fixtureRoot: "temporary; created and removed under .runtime/P01/review-u04",
  results,
  result: results.every((x) => x.result === "pass") ? "pass" : "needs_changes"
};
fs.writeFileSync(path.join(review, "counterexample-results.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(summary, null, 2));
if (summary.result !== "pass") process.exitCode = 1;