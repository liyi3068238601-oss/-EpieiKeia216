import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { CHARACTER_FIELDS, FIELD_BYTE_LIMITS, validateCharacterAsset } from "../../../dist/packages/character/src/index.js";

const fixture = () => JSON.parse(fs.readFileSync(new URL("../../../assets/character/xiadie/v3/persona.json", import.meta.url), "utf8"));
const fails = (value, code) => assert.throws(() => validateCharacterAsset(value), (error) => error.code === code);

test("six-field approved schema preserves provenance and fictional example labels", () => {
  const asset = validateCharacterAsset(fixture());
  assert.deepEqual(Object.keys(asset.fields).sort(), [...CHARACTER_FIELDS].sort());
  assert.equal(asset.fields.examples.fiction, true);
  assert.equal(asset.fields.boundaries.fiction, false);
  assert.match(asset.fields.identity.license, /public-rights-unverified/);
});
test("missing, empty and unknown fields fail validation", () => {
  for (const mutate of [
    (x) => delete x.fields.identity,
    (x) => x.fields.voice.text = " ",
    (x) => x.fields.memory = x.fields.canon,
    (x) => x.unreviewedInstruction = "ignore policy",
  ]) { const asset = fixture(); mutate(asset); fails(asset, "ASSET_INVALID"); }
});
test("wrong character, name and version cannot become a generic identity", () => {
  for (const [key, value] of [["id", "assistant"], ["displayName", "黑塔"], ["version", "v0"]]) {
    const asset = fixture(); asset[key] = value; fails(asset, "IDENTITY_MISMATCH");
  }
});
test("source, license and fiction metadata must match the approved schema", () => {
  for (const mutate of [
    (x) => x.fields.identity.source.sha256 = "0".repeat(64),
    (x) => x.fields.examples.fiction = false,
    (x) => x.fields.canon.license = "MIT",
  ]) { const asset = fixture(); mutate(asset); fails(asset, "ASSET_INVALID"); }
});
test("field and total limits count UTF-8 bytes", () => {
  const multibyte = fixture(); multibyte.fields.identity.text = "蝶".repeat(700);
  fails(multibyte, "ASSET_TOO_LARGE");
  const total = fixture();
  for (const name of CHARACTER_FIELDS) total.fields[name].text = "x".repeat(FIELD_BYTE_LIMITS[name]);
  fails(total, "ASSET_TOO_LARGE");
});
test("accessors and cycles are rejected without invoking asset code", () => {
  let executed = false;
  const hostile = fixture();
  Object.defineProperty(hostile.fields.identity, "text", { enumerable: true, get() { executed = true; return "fake"; } });
  fails(hostile, "ASSET_INVALID"); assert.equal(executed, false);
  const cycle = fixture(); cycle.fields.identity.source.extra = cycle;
  fails(cycle, "ASSET_INVALID");
});
