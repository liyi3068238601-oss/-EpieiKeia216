import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [suite, ...rawArgs] = process.argv.slice(2);
const args = rawArgs.filter((arg) => arg !== "--");
let command;

if (suite === "eval") {
  if (args.length !== 0 && !(args.length === 1 && args[0] === "mock")) {
    console.error("test:eval runs the local mock matrix. Real evaluation uses the explicit authorized relay.py entry point.");
    process.exitCode = 2;
  } else {
    command = ["-X", "utf8", "tests/evals/persona/relay.py", "mock"];
  }
} else if (suite === "e2e") {
  // desktop.py strictly validates its own candidate, output and suite arguments.
  // It has no real-provider mode and never reads the production credential file.
  command = ["-X", "utf8", "tests/integration/P01/desktop.py", ...args];
} else {
  console.error("usage: node tools/run-stage-tests.mjs <eval|e2e> [runner arguments]");
  process.exitCode = 2;
}

if (command !== undefined) {
  const result = spawnSync("python", command, { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
