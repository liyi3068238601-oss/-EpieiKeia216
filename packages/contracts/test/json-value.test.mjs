import assert from "node:assert/strict";
import test from "node:test";

import { isJsonValue } from "../../../dist/packages/contracts/src/index.js";

test("accepts ordinary JSON values and shared non-cyclic references", () => {
  const shared = { value: 3 };
  assert.equal(
    isJsonValue({ items: [null, true, "text", -0, shared, shared] }),
    true,
  );
  assert.equal(isJsonValue(Object.assign(Object.create(null), { ok: 1 })), true);
});

test("rejects values JSON.stringify would omit, coerce, or fail to encode", () => {
  assert.equal(isJsonValue(undefined), false);
  assert.equal(isJsonValue(Number.NaN), false);
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false);
  assert.equal(isJsonValue(1n), false);
  assert.equal(isJsonValue(() => undefined), false);
  assert.equal(isJsonValue(Symbol("secret")), false);
  assert.equal(isJsonValue(new Date()), false);
  assert.equal(isJsonValue(new Map()), false);
});

test("rejects cycles, sparse arrays, accessors, symbols, and hidden fields", () => {
  const cycle = {};
  cycle.self = cycle;

  const sparse = [];
  sparse.length = 1;

  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });

  const hidden = {};
  Object.defineProperty(hidden, "value", { value: 1 });

  const symbolKey = { [Symbol("key")]: "value" };
  assert.equal(isJsonValue(cycle), false);
  assert.equal(isJsonValue(sparse), false);
  assert.equal(isJsonValue(accessor), false);
  assert.equal(isJsonValue(hidden), false);
  assert.equal(isJsonValue(symbolKey), false);
});
