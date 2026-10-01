import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("character public types deny identity, provenance and file-write mutation", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const fixture = fileURLToPath(new URL("readonly.type-fixture.ts", import.meta.url));
  const program = ts.createProgram({ rootNames: [fixture], options: { ...parsed.options, noEmit: true } });
  const messages = ts.getPreEmitDiagnostics(program).map((x) => ts.flattenDiagnosticMessageText(x.messageText, "\n"));
  assert.deepEqual(messages, []);
});
