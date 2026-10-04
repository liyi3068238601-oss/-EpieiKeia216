import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { openEventStore } from "../../../dist/packages/storage/events/src/index.js";
import { buildTurnDiagnostics } from "../../../dist/packages/diagnostics/src/index.js";
import { backupAndMigrateEventStore, restoreEventStoreBackup } from "../../../dist/packages/storage/backup/src/index.js";

const NATIVE_SOURCE = "zcode.native/v1";
const TRANSCRIPT_SOURCE = "xiadie.transcript/v1";
const FULL_SCOPE_KEYS = ["sessionId", "turnId", "runId", "taskId"];
const NO_ADMISSION_ALLOWED = new Set(["disabled_native", "no_key", "pro_denied"]);
const SCENARIOS = new Set([
  "success", "read_success", "read_failure", "cancel_recovery", "disabled_native",
  "pro_denied", "no_key", "no_dsh", "offline",
]);
const PAGE_SIZE = 256;
const MAX_PAGES = 1024;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--backup-restore") {
      if (values.has(key)) throw new Error("duplicate_argument");
      values.set(key, true);
      continue;
    }
    if (!["--profile-root", "--scenario", "--output"].includes(key) || values.has(key)) {
      throw new Error("invalid_arguments");
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) throw new Error("invalid_arguments");
    values.set(key, value);
    index += 1;
  }
  const profileRoot = values.get("--profile-root");
  const scenario = values.get("--scenario");
  const output = values.get("--output");
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot) ||
      typeof output !== "string" || !path.isAbsolute(output) ||
      typeof scenario !== "string" || !SCENARIOS.has(scenario)) throw new Error("invalid_arguments");
  return { profileRoot, scenario, output, backupRestore: values.get("--backup-restore") === true };
}

function fullBoundScope(scope) {
  return scope !== null && typeof scope === "object" && !Array.isArray(scope) &&
    Object.keys(scope).sort().join("\0") === [...FULL_SCOPE_KEYS].sort().join("\0") &&
    FULL_SCOPE_KEYS.every((key) => typeof scope[key] === "string" && scope[key].length > 0);
}

function sameScope(left, right) {
  return fullBoundScope(left) && fullBoundScope(right) &&
    FULL_SCOPE_KEYS.every((key) => left[key] === right[key]);
}

function sameAttempt(left, right) {
  return left.source === right.source && left.eventId === right.eventId &&
    left.attemptId === right.attemptId && sameScope(left.scope, right.scope);
}

function exactTarget(event, target) {
  return event.attemptId === target.attemptId && sameScope(event.scope, target.scope);
}

async function listLedgerFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name === "event-ledger.sqlite") throw new Error("ledger_link_rejected");
        continue;
      }
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && entry.name === "event-ledger.sqlite") {
        const metadata = await lstat(file);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("ledger_file_type_rejected");
        files.push(await realpath(file));
      }
    }
  }
  await visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function readPages(store, methodName) {
  const items = [];
  let afterCommitSequence = 0;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = store[methodName]({ afterCommitSequence, limit: PAGE_SIZE });
    if (!page || !Array.isArray(page.items)) throw new Error("ledger_page_invalid");
    items.push(...page.items);
    if (page.hasMore !== true) return items;
    if (!Number.isSafeInteger(page.nextAfterCommitSequence) || page.nextAfterCommitSequence <= afterCommitSequence) {
      throw new Error("ledger_cursor_stalled");
    }
    afterCommitSequence = page.nextAfterCommitSequence;
  }
  throw new Error("ledger_page_limit");
}

function scopeAttemptKey(scope, attemptId) {
  return JSON.stringify([scope.sessionId, scope.turnId, scope.runId, scope.taskId, attemptId]);
}

function ensureMaskedCapture(capture, target) {
  if (!capture || capture.schemaVersion !== 1 || capture.sessionId !== target.scope.sessionId ||
      capture.turnId !== target.scope.turnId || capture.hookEventName !== "UserPromptSubmit" ||
      capture.origin?.locatorUse !== "historical-only" || capture.origin?.rawRetained !== false ||
      typeof capture.origin?.temporaryLocator !== "string" || path.isAbsolute(capture.origin.temporaryLocator) ||
      capture.snapshot?.schemaVersion !== 1 || capture.snapshot?.redactionVersion !== "full-mask-v1" ||
      !Array.isArray(capture.snapshot.messages) || capture.snapshot.messages.length !== 1 ||
      capture.snapshot.messages[0]?.role !== "user" || capture.snapshot.messages[0]?.text !== "[REDACTED]" ||
      !Number.isSafeInteger(capture.snapshot.messages[0]?.textBytes) ||
      !/^[a-f0-9]{64}$/i.test(capture.snapshot.messages[0]?.textSha256 ?? "")) {
    throw new Error("transcript_capture_not_fully_masked");
  }
}

function receiptForObservation(store, event, observations) {
  const matching = observations.filter((observation) => sameAttempt(observation.event, event));
  for (const observation of matching) {
    if (!["accepted", "duplicate", "redelivery_resequenced"].includes(observation.disposition)) continue;
    const receipt = store.queryReceipt(
      { source: event.source, eventId: event.eventId }, observation.observationKey,
    );
    if (receipt.status === "found" && receipt.firstReceipt?.source === event.source &&
        receipt.firstReceipt?.eventId === event.eventId &&
        receipt.firstReceipt?.commitSequence <= observation.commitSequence &&
        receipt.observation?.observationKey === observation.observationKey &&
        receipt.observation?.commitSequence === observation.commitSequence &&
        receipt.observation?.disposition === observation.disposition) return receipt;
  }
  return null;
}

function assertAllowlistedDiagnostics(report, profileRoot) {
  if (report.schemaVersion !== 1 || report.redactionPolicy !== "turn-diagnostics-allowlist/v2" ||
      report.pageScan?.facts !== "complete" || report.pageScan?.observations !== "complete" ||
      report.turnSeal !== "unavailable" || report.captures.length === 0 ||
      report.captures.some((capture) => capture.rawSource?.currentValidation !== "NOT_VERIFIED")) {
    throw new Error("diagnostics_allowlist_contract_failed");
  }
  const serialized = JSON.stringify(report);
  const forbiddenKeys = new Set([
    "temporaryLocator", "historicalLocator", "rawSha256", "sourcePath", "profilePath",
    "transcriptPath", "prompt", "response", "text", "snapshot", "origin",
  ]);
  const containsForbiddenKey = (value) => {
    if (value === null || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) => forbiddenKeys.has(key) || containsForbiddenKey(child));
  };
  if (serialized.includes(profileRoot) || serialized.includes("temporaryLocator") ||
      serialized.includes("historicalLocator") || serialized.includes("P02_PRIVATE_PROMPT_CANARY") ||
      containsForbiddenKey(report)) {
    throw new Error("diagnostics_raw_source_export_detected");
  }
}

async function verifyBackupRestore(databasePath, scenarioOutput) {
  const maintenanceRoot = path.join(scenarioOutput, "ledger-maintenance");
  const backupDirectory = path.join(maintenanceRoot, "backups");
  const restoreDirectory = path.join(maintenanceRoot, "restored-root");
  await mkdir(backupDirectory, { recursive: true });
  const snapshot = await backupAndMigrateEventStore({ databasePath, backupDirectory });
  const restored = await restoreEventStoreBackup({ backupPath: snapshot.backupPath, destinationDirectory: restoreDirectory });
  if (!isDeepStrictEqual(snapshot.sourceVerification, snapshot.backupVerification) ||
      !isDeepStrictEqual(snapshot.sourceVerification, restored.verification)) {
    throw new Error("backup_restore_verification_mismatch");
  }
  return {
    passed: true,
    mode: snapshot.mode,
    backupPath: snapshot.backupPath,
    backupSha256: snapshot.backupSha256,
    restoredDatabasePath: restored.databasePath,
    restoredDatabaseSha256: restored.databaseSha256,
    verification: restored.verification,
  };
}

async function verifyDatabase(databasePath, profileRoot, scenario, scenarioOutput, backupRestore) {
  const store = openEventStore({ path: databasePath, readOnly: true });
  let backup = null;
  try {
    const facts = readPages(store, "read");
    const observations = readPages(store, "readObservations");
    const nativeFacts = facts.filter((row) => row.event.source === NATIVE_SOURCE);
    const transcriptFacts = facts.filter((row) => row.event.source === TRANSCRIPT_SOURCE);
    const malformedNative = nativeFacts.filter((row) => !fullBoundScope(row.event.scope) ||
      typeof row.event.attemptId !== "string" || row.event.attemptId.length === 0);
    if (malformedNative.length > 0) throw new Error("native_scope_or_attempt_incomplete");

    const groups = new Map();
    for (const row of nativeFacts) {
      const event = row.event;
      const key = scopeAttemptKey(event.scope, event.attemptId);
      const group = groups.get(key) ?? { scope: event.scope, attemptId: event.attemptId, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    const admitted = [...groups.values()].filter((group) =>
      group.rows.some((row) => row.event.payload?.nativeType === "turn_started"));
    if (groups.size !== admitted.length) throw new Error("native_records_without_admitted_turn");

    const transcriptOrphans = transcriptFacts.filter((row) => !admitted.some((target) => exactTarget(row.event, target)));
    if (transcriptOrphans.length > 0) throw new Error("transcript_without_native_attempt");

    const turns = [];
    for (const target of admitted) {
      const targetNative = target.rows.filter((row) => exactTarget(row.event, target));
      const targetTranscripts = transcriptFacts.filter((row) => exactTarget(row.event, target));
      const targetObservations = observations.filter((row) => exactTarget(row.event, target));
      const nativeReceiptsVerified = targetNative.every((row) => receiptForObservation(store, row.event, observations));
      const transcriptReceiptsVerified = targetTranscripts.length > 0 &&
        targetTranscripts.every((row) => receiptForObservation(store, row.event, observations));
      if (!nativeReceiptsVerified || !transcriptReceiptsVerified) throw new Error("committed_writer_receipt_missing");

      const captures = targetObservations.filter((row) => row.event.source === TRANSCRIPT_SOURCE && row.capture !== undefined);
      if (captures.length === 0) throw new Error("masked_transcript_capture_missing");
      for (const row of captures) ensureMaskedCapture(row.capture, target);
      if (captures.length !== targetTranscripts.length) throw new Error("transcript_capture_event_mismatch");

      const terminalRows = targetNative.filter((row) => ["cancel", "success", "failure"].includes(row.event.kind));
      if (terminalRows.length === 0) throw new Error("committed_native_terminal_missing");
      const terminal = terminalRows[0];
      const terminalReceiptVerified = Boolean(receiptForObservation(store, terminal.event, observations));
      if (!terminalReceiptVerified) throw new Error("committed_native_terminal_receipt_missing");

      const toolRows = targetNative.filter((row) => ["tool_call_started", "tool_call_result", "tool_call_error"].includes(row.event.payload?.nativeType));
      const candidateSources = [targetTranscripts[0], ...(toolRows.length ? [toolRows.at(-1)] : [])];
      const candidate = { candidateId: "P02_DESKTOP_REFERENCE_ANNOTATION_CANARY", scope: target.scope, attemptId: target.attemptId,
        sources: candidateSources.map(({ event }) => ({ source: event.source, eventId: event.eventId })) };
      const diagnostics = await buildTurnDiagnostics({ scope: target.scope, attemptId: target.attemptId, store, memoryCandidates: [candidate] });
      if (diagnostics.status !== "built") throw new Error("turn_diagnostics_rejected");
      const report = diagnostics.report;
      assertAllowlistedDiagnostics(report, profileRoot);
      if (report.lifecycle !== terminal.event.kind || report.captures.length < captures.length) {
        throw new Error("diagnostics_attempt_projection_mismatch");
      }
      const factBySequence = new Map(report.facts.map((fact) => [fact.commitSequence, fact]));
      if (targetTranscripts.some((row) => factBySequence.get(row.commitSequence)?.category !== "message") ||
          toolRows.some((row) => factBySequence.get(row.commitSequence)?.category !== "tool" ||
            factBySequence.get(row.commitSequence)?.nativeType !== row.event.payload.nativeType ||
            factBySequence.get(row.commitSequence)?.tool?.status !== row.event.payload.toolStatus) ||
          report.memoryCandidates[0]?.kind !== "reference-annotation" || report.memoryCandidates[0]?.sourceStatus !== "matched" ||
          candidateSources.some((row, index) => report.memoryCandidates[0]?.sources[index]?.eventRef !== factBySequence.get(row.commitSequence)?.eventRef) ||
          JSON.stringify(report).includes(candidate.candidateId)) {
        throw new Error("diagnostics_source_associations_mismatch");
      }
      turns.push({
        scopeRefs: report.scopeRefs,
        attemptRef: report.attemptRef,
        lifecycle: report.lifecycle,
        nativeEventCount: targetNative.length,
        transcriptEventCount: targetTranscripts.length,
        captureCount: captures.length,
        nativeReceiptsVerified,
        transcriptReceiptsVerified,
        terminalReceiptVerified,
        diagnostics: report,
      });
    }

    if (admitted.length === 0 && !NO_ADMISSION_ALLOWED.has(scenario)) {
      throw new Error("expected_native_turn_not_admitted");
    }
    if (backupRestore && scenario === "success") {
      if (admitted.length === 0 || nativeFacts.length === 0) throw new Error("success_backup_without_native_turn");
      await store.close();
      backup = await verifyBackupRestore(databasePath, scenarioOutput);
    }
    return {
      passed: true,
      databaseRelativePath: path.relative(profileRoot, databasePath).split(path.sep).join("/"),
      databaseBytes: (await lstat(databasePath)).size,
      databaseSha256: sha256(await readFile(databasePath)),
      admission: admitted.length > 0 ? "admitted" : "not_admitted",
      admittedTurns: turns,
      nativeEventCount: nativeFacts.length,
      transcriptEventCount: transcriptFacts.length,
      factCount: facts.length,
      observationCount: observations.length,
      backupRestore: backup,
      temporarySourceBoundary: "Locator is historical provenance only; U09 currentValidation remains NOT_VERIFIED and no temporary source path was read.",
    };
  } finally {
    await store.close();
  }
}

export async function verifyScenario({ profileRoot: profileRootInput, scenario, output, backupRestore = false }) {
  if (!path.isAbsolute(profileRootInput) || !path.isAbsolute(output) || !SCENARIOS.has(scenario)) {
    throw new Error("invalid_arguments");
  }
  const outputPath = path.resolve(output);
  const profileRoot = path.resolve(profileRootInput);
  let databaseResults = [];
  let admission = "ledger_absent";
  let passed = false;
  let failureCode;
  try {
    const rootStat = await lstat(profileRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("profile_root_invalid");
    const physicalRoot = await realpath(profileRoot);
    if (physicalRoot !== profileRoot) throw new Error("profile_root_not_physical");
    const files = await listLedgerFiles(physicalRoot);
    if (files.length > 1) throw new Error("multiple_event_ledgers_found");
    if (files.length === 0) {
      if (!NO_ADMISSION_ALLOWED.has(scenario)) throw new Error("expected_event_ledger_missing");
      admission = "ledger_absent_not_admitted_allowed";
      passed = true;
    } else {
      const scenarioOutput = path.dirname(profileRoot);
      databaseResults = [await verifyDatabase(files[0], physicalRoot, scenario, scenarioOutput, backupRestore)];
      admission = databaseResults[0].admission;
      passed = true;
    }
  } catch (error) {
    failureCode = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "ledger_verification_failed";
  }
  const report = {
    schemaVersion: 1,
    scenario,
    profileRoot: "owned-profile-redacted",
    ledgerCount: databaseResults.length,
    admission,
    databases: databaseResults,
    admitted_turns: databaseResults.reduce((total, item) => total + item.admittedTurns.length, 0),
    backup_restore: databaseResults.find((item) => item.backupRestore)?.backupRestore ?? null,
    passed,
    ...(failureCode ? { failure_code: failureCode } : {}),
    qualificationBoundary: "Electron UI with pinned fixed Node CLI; durable host and SQLite ledger are in the wrapped CLI protocol process, not Electron main. P01 sidecar remains UI correlation evidence.",
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  try {
    const args = parseArgs(process.argv.slice(2));
    output = args.output;
    const report = await verifyScenario({
      profileRoot: args.profileRoot,
      scenario: args.scenario,
      output: args.output,
      backupRestore: args.backupRestore,
    });
    process.stdout.write(JSON.stringify({ passed: report.passed, admission: report.admission,
      admittedTurns: report.databases[0]?.admittedTurns.length ?? 0, backupRestore: report.backup_restore?.passed ?? null }) + "\n");
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "ledger_verification_failed";
    if (output && path.isAbsolute(output)) {
      try {
        await writeFile(output, `${JSON.stringify({ schemaVersion: 1, passed: false, failure_code: code })}\n`,
          { encoding: "utf8", flag: "wx" });
      } catch { /* preserve the original verification error */ }
    }
    process.stderr.write(`P02_LEDGER_VERIFY_FAILED:${code}\n`);
    process.exitCode = 1;
  }
}
