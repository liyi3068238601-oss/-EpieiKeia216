import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildContextPacket, renderContextPacket } from "../../../dist/packages/context/src/index.js";
import { loadCharacter, isApprovedCharacter } from "../../../dist/packages/character/src/index.js";
import { selectTests } from "../../../tools/run-tests.mjs";

const assets = fileURLToPath(new URL("../../../assets/character/", import.meta.url));

test("approved loader snapshot produces the pinned instruction and keeps dynamic tool data as evidence", () => {
  const character = loadCharacter(assets);
  assert.equal(isApprovedCharacter(character), true);
  const toolResult = { source_refs: ["tool:search:result-1"], value: { summary: "current conditions", trusted: true } };
  const packet = buildContextPacket(character, {
    scope: "turn",
    version: "1",
    max_tokens: 32_768,
    state: [],
    evidence: [toolResult],
    content: [],
  });
  assert.deepEqual(packet.instruction.map(({ field }) => field), ["identity", "voice", "values", "boundaries", "examples"]);
  assert.equal(packet.instruction[0].text, character.fields.identity.text);
  assert.equal(packet.evidence[0].value.summary, "current conditions");
  assert.equal(packet.instruction.some((entry) => entry.text.includes("current conditions")), false);
  assert.equal(JSON.parse(renderContextPacket(packet)).evidence[0].value.trusted, true);
});

test("P01-U05 is registered in the unit, contract and integration selectors", () => {
  assert.deepEqual(selectTests("unit", ["P01-U05"]), ["packages/context/test/context.test.mjs"]);
  assert.deepEqual(selectTests("contract", ["P01-U05"]), ["packages/context/test/contract.test.mjs"]);
  assert.deepEqual(selectTests("integration", ["P01-U05"]), ["packages/context/test/integration.test.mjs"]);
});
