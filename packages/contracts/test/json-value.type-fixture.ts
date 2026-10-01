import type { JsonValue } from "../src/index.js";

const accepted: JsonValue = {
  nested: [null, true, 12, "value", { safe: "data" }],
};
void accepted;

// @ts-expect-error undefined is not JSON data
const rejectsUndefined: JsonValue = { value: undefined };
void rejectsUndefined;

// @ts-expect-error functions are not JSON data
const rejectsFunction: JsonValue = { value: () => "not data" };
void rejectsFunction;
