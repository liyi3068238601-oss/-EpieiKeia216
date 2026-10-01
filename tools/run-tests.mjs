import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TESTS = Object.freeze({
  unit: Object.freeze({
    all: ["packages/contracts/test/json-value.test.mjs", "packages/character/test/schema.test.mjs"],
    tasks: Object.freeze({
      "P01-U03": ["packages/contracts/test/json-value.test.mjs"],
      "P01-U04": ["packages/character/test/schema.test.mjs"],
    }),
  }),
  contract: Object.freeze({
    all: ["packages/contracts/test/contracts.test.mjs", "packages/character/test/contract.test.mjs"],
    tasks: Object.freeze({
      "P01-U03": ["packages/contracts/test/contracts.test.mjs"],
      "P01-U04": ["packages/character/test/contract.test.mjs"],
    }),
  }),
  integration: Object.freeze({
    all: ["packages/contracts/test/import-boundaries.test.mjs", "packages/character/test/loader.test.mjs"],
    tasks: Object.freeze({
      "P01-U03": ["packages/contracts/test/import-boundaries.test.mjs"],
      "P01-U04": ["packages/character/test/loader.test.mjs"],
    }),
  }),
});

export function selectTests(suite, selectors = []) {
  const definition = TESTS[suite];
  if (definition === undefined) throw new Error(`unknown test suite: ${suite}`);
  const selected = selectors.filter((selector) => selector !== "--");
  if (selected.length === 0) return [...definition.all];

  const unknown = selected.filter((selector) => definition.tasks[selector] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `unknown task selector for ${suite}: ${unknown.join(", ")}; known: ${Object.keys(definition.tasks).join(", ")}`,
    );
  }
  return [...new Set(selected.flatMap((selector) => definition.tasks[selector]))];
}

function main(argv) {
  const [suite, ...selectors] = argv;
  if (suite === undefined) {
    console.error("usage: node tools/run-tests.mjs <unit|contract|integration> [task-id]");
    return 2;
  }

  let files;
  try {
    files = selectTests(suite, selectors);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
