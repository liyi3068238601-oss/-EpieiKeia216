import path from "node:path";
import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TESTS = Object.freeze({
  unit: Object.freeze({
    all: ["packages/projects/test/freshness.test.mjs", "packages/projects/test/project-memory-migration.test.mjs", "packages/projects/test/project-memory-policy.test.mjs", "packages/adapters/zcode/test/project-memory.test.mjs", "packages/adapters/zcode/test/project-memory-host.test.mjs", "packages/projects/test/registry.test.mjs", "packages/work/test/handoff-context.test.mjs", "packages/diagnostics/test/diagnostics.test.mjs", "packages/contracts/test/json-value.test.mjs", "packages/contracts/test/events.test.mjs", "packages/adapters/zcode/test/transcript.test.mjs", "packages/adapters/zcode/test/transcript-host.test.mjs", "packages/character/test/schema.test.mjs", "packages/context/test/context.test.mjs", "packages/adapters/zcode/test/host.test.mjs", "packages/application/test/turn-projection.test.mjs", "packages/application/evidence/test/evidence.test.mjs", "packages/application/recovery/test/recovery.test.mjs", "packages/config/test/profile.test.mjs", "packages/config/test/desktop-build-paths.test.mjs", "packages/config/test/warmup.test.mjs", "packages/secrets/test/credential.test.mjs", "packages/storage/events/test/events.test.mjs", "packages/storage/backup/test/backup.test.mjs", "tests/evals/persona/native.test.mjs", "tests/integration/P01/read-only-workspace.test.mjs", "tests/integration/P01/factory.test.mjs", "tests/integration/P01/electron-network-guard.test.mjs"],
    tasks: Object.freeze({
      "P03-U08": ["packages/projects/test/freshness.test.mjs"],
      "P03-U06": ["packages/projects/test/project-memory-migration.test.mjs"],
      "P03-U07": ["packages/work/test/handoff-context.test.mjs"],
      "P03-U05": ["packages/projects/test/project-memory-policy.test.mjs"],
      "P03-U04": ["packages/adapters/zcode/test/project-memory.test.mjs", "packages/adapters/zcode/test/project-memory-host.test.mjs", "packages/adapters/zcode/test/host.test.mjs", "packages/adapters/zcode/test/transcript-host.test.mjs"],
      "P03-U03": ["packages/projects/test/registry.test.mjs"],
      "P02-U09": ["packages/diagnostics/test/diagnostics.test.mjs"],
      "P01-U03": ["packages/contracts/test/json-value.test.mjs"],
      "P02-U03": ["packages/contracts/test/events.test.mjs"],
      "P02-U04": ["packages/adapters/zcode/test/transcript.test.mjs", "packages/adapters/zcode/test/transcript-host.test.mjs", "packages/adapters/zcode/test/host.test.mjs"],
      "P02-U05": ["packages/storage/events/test/events.test.mjs"],
      "P02-U08": ["packages/storage/backup/test/backup.test.mjs"],
      "P01-U04": ["packages/character/test/schema.test.mjs"],
      "P01-U05": ["packages/context/test/context.test.mjs"],
      "P01-U06": ["packages/adapters/zcode/test/host.test.mjs"],
      "P01-U07": ["packages/application/test/turn-projection.test.mjs"],
      "P02-U06": ["packages/application/evidence/test/evidence.test.mjs"],
      "P02-U07": ["packages/application/recovery/test/recovery.test.mjs"],
      "P01-U08": ["packages/config/test/profile.test.mjs", "packages/config/test/desktop-build-paths.test.mjs", "packages/config/test/warmup.test.mjs", "packages/secrets/test/credential.test.mjs"],
      "P01-U09": ["tests/evals/persona/native.test.mjs"],
      "P01-U10": ["tests/integration/P01/read-only-workspace.test.mjs", "tests/integration/P01/factory.test.mjs", "tests/integration/P01/electron-network-guard.test.mjs"],
    }),
  }),
  contract: Object.freeze({
    all: ["packages/contracts/test/contracts.test.mjs", "packages/character/test/contract.test.mjs", "packages/context/test/contract.test.mjs", "packages/adapters/zcode/test/contract.test.mjs"],
    tasks: Object.freeze({
      "P01-U03": ["packages/contracts/test/contracts.test.mjs"],
      "P02-U03": ["packages/contracts/test/contracts.test.mjs"],
      "P01-U04": ["packages/character/test/contract.test.mjs"],
      "P01-U05": ["packages/context/test/contract.test.mjs"],
      "P01-U06": ["packages/adapters/zcode/test/contract.test.mjs"],
    }),
  }),
  integration: Object.freeze({
    all: ["packages/contracts/test/import-boundaries.test.mjs", "packages/character/test/loader.test.mjs", "packages/context/test/integration.test.mjs", "packages/adapters/zcode/test/native.integration.test.mjs", "packages/application/test/native-projection.integration.test.mjs", "tests/integration/P02/native.integration.test.mjs", "tests/integration/P03/native.integration.test.mjs", "tests/integration/P03/reader-parent-acl.test.mjs"],
    tasks: Object.freeze({
      "P03-U09": ["tests/integration/P03/native.integration.test.mjs", "tests/integration/P03/reader-parent-acl.test.mjs"],
      "P01-U03": ["packages/contracts/test/import-boundaries.test.mjs"],
      "P01-U04": ["packages/character/test/loader.test.mjs"],
      "P01-U05": ["packages/context/test/integration.test.mjs"],
      "P01-U06": ["packages/adapters/zcode/test/native.integration.test.mjs"],
      "P01-U07": ["packages/application/test/native-projection.integration.test.mjs"],
      "P02-U10": ["tests/integration/P02/native.integration.test.mjs"],
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
  for (const file of files) {
    try {
      if (statSync(path.join(root, file)).isFile()) continue;
    } catch { /* Report the declared fixture rather than accepting a partial suite. */ }
    console.error(`test file is missing: ${file}`);
    return 1;
  }
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
