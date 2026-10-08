import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildHostVariant } from '../worktrees/u02-source-probe/spikes/P03/make-host-variant.mjs';
const result = await buildHostVariant({ repositoryRoot: 'E:\\Xiadie\\Xiadie\\.runtime\\P03\\worktrees\\u02-source-probe', outputDir: process.argv[2] });
const mod = await import(pathToFileURL(result.hostPath).href);
assert.equal(typeof mod.createXiadieZCodeApp, 'function');
execFileSync(process.execPath, ['--check', result.hookPath]);
console.log(JSON.stringify({ result: 'pass', hostPath: result.hostPath, hookPath: result.hookPath, inputs: result.manifest.inputs, outputs: result.manifest.outputs, exports: Object.keys(mod), limitation: 'Build/import/syntax only; Native runtime acceptance pending' }, null, 2));
