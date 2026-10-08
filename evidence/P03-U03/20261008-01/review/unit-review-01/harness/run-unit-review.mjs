import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const authorRoot = "E:\\Xiadie\\Xiadie\\.runtime\\P03\\worktrees\\u03";
const sourceRunner = await import(pathToFileURL(authorRoot + "/tools/run-tests.mjs").href);
const selected = sourceRunner.selectTests("unit", ["P03-U03"]);
if (JSON.stringify(selected) !== JSON.stringify(["packages/projects/test/registry.test.mjs"])) {
  throw new Error(`unexpected committed selector mapping: ${JSON.stringify(selected)}`);
}
const result = spawnSync(process.execPath, ["--test", "E:\\Xiadie\\Xiadie\\.runtime\\P03\\reviews\\u03-20261008\\unit-review-01\\harness\\registry.test.mjs"], {
  cwd: authorRoot, stdio: "inherit", windowsHide: true,
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
