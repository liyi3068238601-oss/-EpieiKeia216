import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [worktree, outputPath] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const databasePath = path.join(here, "missing-command.sqlite");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const moduleUrl = (relative) => pathToFileURL(path.join(worktree, "dist", relative)).href;
const { openEventStore } = await import(moduleUrl("packages/storage/events/src/index.js"));
const { normalizeRuntimeEvent } = await import(moduleUrl("packages/contracts/src/events.js"));
const {
  OWNED_ARTIFACT_INTEGRITY_PROFILE, buildEvidenceReport, createLocalEvidenceReader, runOwnedNode,
} = await import(moduleUrl("packages/application/evidence/src/index.js"));
const { buildTurnDiagnostics } = await import(moduleUrl("packages/diagnostics/src/index.js"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8", shell: false }).trim();
const run = await runOwnedNode({ repositoryRoot: worktree, expectedSourceCommit: commit,
  script: "tools/check-import-boundaries.mjs", args: [] });
assert.equal(run.status, "exited");
assert.equal(run.exitCode, 0);
const scope = Object.freeze({ sessionId: "review-u09-session", turnId: "review-u09-turn", runId: run.runId, taskId: "review-u09-task" });
const attemptId = "review-u09-attempt";
const operationId = `review-u09-operation-${randomUUID()}`;
const toolCallId = `review-u09-tool-${randomUUID()}`;
const artifactRoot = path.join(here, "artifact-root");
await mkdir(artifactRoot, { recursive: true });
const artifactLocator = "synthetic-result.txt";
const artifactBytes = Buffer.from("review-only synthetic artifact", "utf8");
await writeFile(path.join(artifactRoot, artifactLocator), artifactBytes, { flag: "wx" });

const observedAt = new Date().toISOString();
const eventId = `review-u09-receipt-${randomUUID()}`;
const event = normalizeRuntimeEvent({
  source: "zcode-hook", eventId, scope, attemptId, operationId, kind: "operation_receipt",
  occurredAt: observedAt, observedAt, sourceSequence: 1,
  payload: { operationId, status: "success", observedAt, result: {
    profile: OWNED_ARTIFACT_INTEGRITY_PROFILE, runId: run.runId, processId: run.processId,
    toolCallId, sourceCommitAtLaunch: run.sourceCommitAtLaunch,
    artifact: { locator: artifactLocator, bytes: artifactBytes.byteLength, sha256: sha256(artifactBytes) },
    // Deliberately omit result.command from the SQLite-committed receipt.
  } },
});
const store = openEventStore({ path: databasePath });
let report;
try {
  const admission = store.append({ event, origin: {
    sourcePin: "29628c9acdb81b703bbd4080c207a0e7ce5e276e",
    historicalLocator: `review-u09-owned/${eventId}`, rawSha256: sha256(Buffer.from(`origin:${eventId}`, "utf8")),
    rawBytes: 64, extent: "single-event-envelope", rawRetained: false,
  } });
  assert.equal(admission.status, "queued");
  assert.equal((await admission.completion).status, "committed");
  const reader = await createLocalEvidenceReader({ repositoryRoot: worktree, artifactRoot,
    expectedReceiptSource: "zcode-hook", eventStore: store });
  const evidenceReport = await buildEvidenceReport({ run, scope, attemptId, operationId, toolCallId, artifactLocator }, reader);
  const built = await buildTurnDiagnostics({ scope, attemptId, store, evidenceReports: [evidenceReport] });
  assert.equal(built.status, "built");
  const evidence = built.report.evidenceReports[0];
  assert.equal(evidence.execution.command.status, "unverified");
  assert.ok(built.report.codes.includes("COMMAND_NOT_VERIFIED"));
  assert.equal(evidence.toolReceipt.status, "verified");
  const serialized = JSON.stringify(built.report);
  assert.equal(serialized.includes("tools/check-import-boundaries.mjs"), false);
  assert.equal(serialized.includes(run.command.scriptSha256), false);
  report = {
    result: "missing receipt command is explicitly downgraded",
    diagnosticsCommandStatus: evidence.execution.command.status,
    diagnosticCode: "COMMAND_NOT_VERIFIED",
    evidenceToolReceiptStatus: evidence.toolReceipt.status,
    rawCommandAbsent: !serialized.includes("tools/check-import-boundaries.mjs"),
    rawScriptHashAbsent: !serialized.includes(run.command.scriptSha256),
  };
} finally {
  await store.close();
}
const db = await readFile(databasePath);
report.database = { bytes: db.byteLength, sha256: sha256(db) };
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(report)}\n`);