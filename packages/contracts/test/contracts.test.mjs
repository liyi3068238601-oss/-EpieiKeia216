import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDir, "../../..");

test("JsonValue admits JSON data and rejects values outside the contract", () => {
  const configPath = resolve(testDir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined, "contract test tsconfig must load");

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
  );
  assert.deepEqual(parsed.errors, [], "contract test tsconfig must parse");

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const location = diagnostic.file?.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    return {
      code: diagnostic.code,
      file: diagnostic.file?.fileName,
      line: location === undefined ? undefined : location.line + 1,
      message,
    };
  });

  assert.deepEqual(diagnostics, [], JSON.stringify({ projectRoot, diagnostics }));
});
