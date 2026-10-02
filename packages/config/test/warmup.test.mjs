import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {patchReadOnlyWarmup, SOURCE_PIN} from "../desktop-build.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceRoot = path.resolve(repoRoot, "..", "..", "desktop-source");
const sourceFile = path.join(sourceRoot, "packages/services/src/zcode-agent/zcodeAgentService.ts");
const sourceRevision = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(sourceRevision, SOURCE_PIN, "Warmup behavior test must use the fixed read-only source pin");
const committedSource = execFileSync("git", [
  "-C",
  sourceRoot,
  "show",
  `${SOURCE_PIN}:packages/services/src/zcode-agent/zcodeAgentService.ts`,
], {
  encoding: "utf8",
});

const originalSource = fs.readFileSync(sourceFile, "utf8");
assert.equal(originalSource, committedSource, "Warmup behavior test must read the pinned source file contents");
const patchedSource = patchReadOnlyWarmup(originalSource);
const initializeStart = patchedSource.indexOf("    async initialize(params: ZCodeAgentWorkspaceTarget)");
const initializeEnd = patchedSource.indexOf("    async syncAppRuntimePreferences(", initializeStart);
assert.ok(initializeStart >= 0 && initializeEnd > initializeStart, "Pinned initialize method boundary changed");
const initializeMethod = patchedSource.slice(initializeStart, initializeEnd);
let moduleSequence = 0;

async function loadPatchedInitialize(stubs) {
  globalThis.__p01U08WarmupStubs = stubs;
  const source = `
    const __caseId = ${++moduleSequence};
    const {
      resolveWorkspaceKey,
      logger,
      getClient,
      getReadOnlyClient,
      isProviderNotReadyError,
      ZCODE_PROTOCOL_NAME,
      ZCODE_PROTOCOL_VERSION,
      ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
    } = globalThis.__p01U08WarmupStubs;
    const service = ({
      ${initializeMethod}
    });
    export default service.initialize;
  `;
  const transformed = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
  });
  const errors = (transformed.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], "The fixed patched initialize method must transpile without errors");
  const specifier = `data:text/javascript;base64,${Buffer.from(transformed.outputText).toString("base64")}`;
  return (await import(specifier)).default;
}

function makeStubs(getClient, getReadOnlyClient) {
  const logs = [];
  const stubs = {
    calls: {getClient: [], getReadOnlyClient: []},
    logs,
    resolveWorkspaceKey: () => "p01-u08-workspace",
    logger: {
      info: (...args) => logs.push({level: "info", args}),
      warn: (...args) => logs.push({level: "warn", args}),
    },
    getClient: async (...args) => {
      stubs.calls.getClient.push(args);
      return getClient(...args);
    },
    getReadOnlyClient: async (...args) => {
      stubs.calls.getReadOnlyClient.push(args);
      return getReadOnlyClient(...args);
    },
    isProviderNotReadyError: (error) => error?.code === "provider_not_ready",
    ZCODE_PROTOCOL_NAME: "zcode",
    ZCODE_PROTOCOL_VERSION: "test-version",
    ZCODE_AGENT_PROVIDER_NOT_READY_REASON: "provider_not_ready",
  };
  return stubs;
}

test("patchReadOnlyWarmup executes the fixed initialize source and keeps the ready path unchanged", async () => {
  const params = {workspacePath: "C:\\p01-warmup"};
  let readonlyCalls = 0;
  const stubs = makeStubs(
    async () => ({transportKind: "websocket"}),
    async () => {
      readonlyCalls += 1;
      return {transportKind: "stdio"};
    },
  );
  const initialize = await loadPatchedInitialize(stubs);
  const result = await initialize(params);

  assert.equal(result.available, true);
  assert.equal(result.transportKind, "websocket");
  assert.equal(stubs.calls.getClient.length, 1);
  assert.equal(stubs.calls.getClient[0][0], params);
  assert.equal(readonlyCalls, 0);
  assert.equal(stubs.calls.getReadOnlyClient.length, 0);
});

test("provider_not_ready alone falls back to the native read-only client", async () => {
  const params = {workspacePath: "C:\\p01-warmup"};
  const providerError = Object.assign(new Error("provider not configured"), {code: "provider_not_ready"});
  const stubs = makeStubs(
    async () => { throw providerError; },
    async () => ({transportKind: "stdio"}),
  );
  const initialize = await loadPatchedInitialize(stubs);
  const result = await initialize(params);

  assert.equal(result.available, true);
  assert.equal(result.transportKind, "stdio");
  assert.equal(stubs.calls.getClient.length, 1);
  assert.deepEqual(stubs.calls.getReadOnlyClient, [[params]]);
});

test("non-provider startup errors keep the existing failure path and do not fall back", async () => {
  const params = {workspacePath: "C:\\p01-warmup"};
  const startupError = new Error("unexpected startup failure");
  const stubs = makeStubs(
    async () => { throw startupError; },
    async () => ({transportKind: "stdio"}),
  );
  const initialize = await loadPatchedInitialize(stubs);
  const result = await initialize(params);

  assert.equal(result.available, false);
  assert.equal(result.reason, startupError.message);
  assert.equal(Object.hasOwn(result, "reasonCode"), false);
  assert.equal(stubs.calls.getClient.length, 1);
  assert.equal(stubs.calls.getReadOnlyClient.length, 0);
  assert.equal(stubs.logs.some((entry) => entry.level === "warn"), true);
});
