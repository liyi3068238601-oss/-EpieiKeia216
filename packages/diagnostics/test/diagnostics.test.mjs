import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const experimentParent = path.join(repositoryRoot, ".runtime", "P02", "experiments", "u09");
const ACCEPTED_NATIVE_PIN = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
const RECOVERY_SOURCE = "xiadie.recovery/v1";
const RECEIPT_SOURCE = "zcode-hook";
const SCOPE = Object.freeze({
  sessionId: "session-u09-canary",
  turnId: "turn-u09-canary",
  runId: "run-u09-canary",
  taskId: "task-u09-canary",
});
const ATTEMPT_ID = "attempt-u09-canary";
const LEAK_CANARIES = Object.freeze([
  "U09_SECRET_KEY_CANARY_sk-test-0123456789",
  "U09_HIDDEN_REASONING_CANARY",
  "U09_UNRELATED_LIFE_CANARY",
  "U09_EVENT_PAYLOAD_CANARY",
  "U09_RAW_TRANSCRIPT_CANARY",
  "U09_ARTIFACT_PATH_CANARY",
  "U09_STDOUT_CANARY",
  "U09_STDERR_CANARY",
]);
const FORBIDDEN_KEYS = new Set([
  "sessionId", "turnId", "runId", "taskId", "attemptId", "eventId", "operationId", "toolCallId",
  "source", "sourcePin", "historicalLocator", "temporaryLocator", "rawSha256", "snapshotSha256",
  "payload", "text", "reply", "argv", "cwd", "stdin", "locator", "errorMessage",
]);

const { buildTurnDiagnostics } = await import(new URL("../../../dist/packages/diagnostics/src/index.js", import.meta.url).href);
const { openEventStore } = await import(new URL("../../../dist/packages/storage/events/src/index.js", import.meta.url).href);
const { normalizeRuntimeEvent, canonicalizeJson } = await import(new URL("../../../dist/packages/contracts/src/events.js", import.meta.url).href);
const {
  OWNED_ARTIFACT_INTEGRITY_PROFILE,
  buildEvidenceReport,
  createLocalEvidenceReader,
  runOwnedNode,
} = await import(new URL("../../../dist/packages/application/evidence/src/index.js", import.meta.url).href);

test("synthetic ordinary attempt exports only exact-scope U05 rows and masked capture summaries", async (t) => {
  const fixture = await makeFixture(t, "ordinary-turn");
  const capture = await makeCapture(fixture, SCOPE, ACCEPTED_NATIVE_PIN);
  const capturedFact = await appendEvent(fixture, {
    eventId: "U09_EVENT_PAYLOAD_CANARY_CAPTURED",
    kind: "fact",
    payload: { text: LEAK_CANARIES[3], apiKey: LEAK_CANARIES[0], hidden_reasoning: LEAK_CANARIES[1] },
    sourcePin: ACCEPTED_NATIVE_PIN,
    capture: capture.value,
  });
  await rm(capture.rawPath);
  await appendEvent(fixture, {
    eventId: "U09_RECOVERY_EVENT_CANARY",
    source: RECOVERY_SOURCE,
    kind: "fact",
    payload: { note: LEAK_CANARIES[2] },
    sourcePin: RECOVERY_SOURCE,
  });
  const terminal = await appendEvent(fixture, {
    eventId: "U09_TERMINAL_EVENT_CANARY",
    kind: "success",
    payload: { response: LEAK_CANARIES[1], command: LEAK_CANARIES[6] },
    sourcePin: "untrusted-source-pin-U09-CANARY",
  });

  for (const [field, value] of Object.entries({
    sessionId: "other-session-u09",
    turnId: "other-turn-u09",
    runId: "other-run-u09",
    taskId: "other-task-u09",
  })) {
    await appendEvent(fixture, {
      eventId: `excluded-${field}-${randomUUID()}`,
      kind: "fact",
      payload: { text: `excluded-${field}` },
      scope: { ...SCOPE, [field]: value },
      sourcePin: ACCEPTED_NATIVE_PIN,
    });
  }
  await appendEvent(fixture, {
    eventId: "excluded-old-attempt-u09",
    kind: "fact",
    payload: { text: "excluded-old-attempt" },
    attemptId: "other-attempt-u09",
    sourcePin: ACCEPTED_NATIVE_PIN,
  });

  const result = await buildTurnDiagnostics({ scope: SCOPE, attemptId: ATTEMPT_ID, store: fixture.store });
  assert.equal(result.status, "built");
  const report = result.report;
  assert.equal(report.lifecycle, "success");
  assert.ok(report.terminalEventRef);
  assert.deepEqual(report.pageScan, { facts: "complete", observations: "complete" });
  assert.equal(report.turnSeal, "unavailable");
  assert.deepEqual(report.evidenceReports, []);
  assert.equal(report.facts.length, 3, "same-turn rows from other scope/attempt must be excluded");
  assert.equal(report.observations.length, 3);
  assert.equal(report.captures.length, 1);
  assert.equal(report.captures[0].rawSource.currentValidation, "NOT_VERIFIED");
  assert.equal(report.captures[0].rawSource.bytes, capture.rawBytes);
  assertShaRef(report.captures[0].rawSource.historicalSha256Ref);
  assert.equal(report.sourceVersion.acceptedNative40Pin, ACCEPTED_NATIVE_PIN);
  assert.equal(report.sourceVersion.adapter, "recovery-v1");
  assert.ok(report.sourceVersion.otherSourcePins.length >= 1);
  for (const reference of report.sourceVersion.otherSourcePins) assertShaRef(reference);

  const capturedSummary = report.facts.find(({ eventRef }) => eventRef === report.captures[0].eventRef);
  assert.ok(capturedSummary, "a capture and its fact must share one report-local event reference");
  const capturedObservation = report.observations.find(({ eventRef }) => eventRef === capturedSummary.eventRef);
  assert.ok(capturedObservation, "the matching observation must reuse the same event reference");
  assertShaRef(capturedSummary.eventRef);
  assertShaRef(capturedObservation.observationRef);
  assertShaRef(report.scopeRefs.session);
  assertShaRef(report.scopeRefs.turn);
  assertShaRef(report.scopeRefs.run);
  assertShaRef(report.scopeRefs.task);
  assertShaRef(report.attemptRef);
  assert.equal(report.terminalEventRef, report.facts.find(({ kind }) => kind === "success")?.eventRef);
  assertSafeAllowlist(report, [...LEAK_CANARIES, capturedFact.event.eventId, terminal.event.eventId]);

  const secondReport = (await buildTurnDiagnostics({ scope: SCOPE, attemptId: ATTEMPT_ID, store: fixture.store })).report;
  assert.notEqual(secondReport.scopeRefs.session, report.scopeRefs.session,
    "references must be stable inside one export and salted differently across exports");
  assert.notEqual(secondReport.terminalEventRef, report.terminalEventRef);
  fixture.success();
});

test("real U05 default pagination crosses 256 rows with complete facts and observation references", async (t) => {
  const fixture = await makeFixture(t, "default-pagination");
  for (let index = 0; index < 257; index += 1) {
    await appendEvent(fixture, {
      eventId: `default-page-fact-${index}`,
      kind: "fact",
      payload: { ordinal: index },
      sourcePin: ACCEPTED_NATIVE_PIN,
    });
  }
  await appendEvent(fixture, {
    eventId: "default-page-terminal-success",
    kind: "success",
    payload: { result: "synthetic-complete" },
    sourcePin: ACCEPTED_NATIVE_PIN,
  });

  const result = await buildTurnDiagnostics({ scope: SCOPE, attemptId: ATTEMPT_ID, store: fixture.store });
  assert.equal(result.status, "built");
  const report = result.report;
  assert.deepEqual(report.pageScan, { facts: "complete", observations: "complete" });
  assert.equal(report.lifecycle, "success");
  assert.equal(report.facts.length, 258);
  assert.equal(report.observations.length, 258);
  assert.equal(report.turnSeal, "unavailable");
  assert.deepEqual(
    report.facts.map(({ eventRef }) => eventRef),
    report.observations.map(({ eventRef }) => eventRef),
    "each stored fact must reuse its opaque event reference in observation summaries across page boundaries",
  );
  for (const fact of report.facts) assertShaRef(fact.eventRef);
  fixture.success();
});

test("an actual owned Node/Git U06 report joins its committed SQLite writer receipt; mismatches reject", async (t) => {
  const fixture = await makeFixture(t, "owned-evidence");
  const { evidenceReport, receiptEventId, sourceCommit, scope } = await makeOwnedEvidenceReport(fixture);
  await appendEvent(fixture, {
    kind: "success", payload: { text: "terminal canary" }, sourcePin: ACCEPTED_NATIVE_PIN, scope,
  });

  const input = { scope, attemptId: ATTEMPT_ID, store: fixture.store, evidenceReports: [evidenceReport] };
  const result = await buildTurnDiagnostics(input);
  assert.equal(result.status, "built");
  const report = result.report;
  const evidence = report.evidenceReports[0];
  assert.equal(evidence.profile, OWNED_ARTIFACT_INTEGRITY_PROFILE);
  assert.equal(evidence.execution.status, "passed");
  assert.equal(evidence.toolReceipt.status, "verified");
  assert.equal(evidence.artifact.status, "verified");
  assert.equal(evidence.sourceRevision, "verified");
  assert.equal(evidence.profileResult, "passed");
  assert.ok(Number.isSafeInteger(evidence.execution.exitCode));
  assert.equal(evidence.execution.exitCode, 0);
  assertShaRef(evidence.operationRef);
  assertShaRef(evidence.toolCallRef);
  assertShaRef(evidence.toolReceipt.eventRef);
  assertShaRef(evidence.toolReceipt.canonicalHashRef);
  assertShaRef(evidence.artifact.artifactRef);
  assertShaRef(evidence.artifact.sha256Ref);
  assert.deepEqual(Object.keys(evidence.execution.stdout).sort(), ["bytes", "sha256Ref"]);
  assert.deepEqual(Object.keys(evidence.execution.stderr).sort(), ["bytes", "sha256Ref"]);
  const receiptFact = report.facts.find(({ kind }) => kind === "operation_receipt");
  assert.ok(receiptFact);
  assert.equal(receiptFact.eventRef, evidence.toolReceipt.eventRef);
  assert.equal(receiptFact.commitSequence, evidence.toolReceipt.commitSequence);
  assert.equal(report.lifecycle, "success");
  assert.equal(report.turnSeal, "unavailable");
  assertSafeAllowlist(report, [...LEAK_CANARIES, receiptEventId, sourceCommit, fixture.artifactPath,
    evidenceReport.operationId, evidenceReport.toolCallId]);

  const mismatchCases = [
    ...["sessionId", "turnId", "runId", "taskId"].map((field) => ({
      label: field,
      report: { ...structuredClone(evidenceReport), scope: { ...evidenceReport.scope, [field]: `wrong-${field}` } },
    })),
    { label: "attemptId", report: { ...structuredClone(evidenceReport), attemptId: "wrong-attempt" } },
  ];
  for (const variant of mismatchCases) {
    const rejected = await buildTurnDiagnostics({ ...input, evidenceReports: [variant.report] });
    assert.deepEqual(rejected, { status: "rejected", code: "EVIDENCE_SCOPE_MISMATCH" }, variant.label);
  }

  const next = (await buildTurnDiagnostics(input)).report;
  assert.notEqual(next.evidenceReports[0].toolReceipt.eventRef, evidence.toolReceipt.eventRef,
    "the same receipt identity must not correlate across independent report salts");
  fixture.success();
});

test("corrupt writer receipt and bounded or stalled pagination degrade to partial, unsealed reports", async (t) => {
  await t.test("SQLite rejects a corrupted writer receipt without exporting its error", async (t) => {
    const fixture = await makeFixture(t, "corrupt-writer-receipt");
    const written = await appendEvent(fixture, {
      eventId: "U09_CORRUPTED_WRITER_RECEIPT_CANARY",
      kind: "fact",
      payload: { text: LEAK_CANARIES[3] },
      sourcePin: ACCEPTED_NATIVE_PIN,
    });
    await fixture.store.close();
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.prepare("UPDATE event_receipts SET canonical_hash = ? WHERE source = ? AND event_id = ?")
        .run("f".repeat(64), written.event.source, written.event.eventId);
    } finally {
      database.close();
    }
    fixture.replaceStore(openEventStore({ path: fixture.databasePath, readOnly: true }));

    const result = await buildTurnDiagnostics({ scope: SCOPE, attemptId: ATTEMPT_ID, store: fixture.store });
    assert.equal(result.status, "built");
    assert.equal(result.report.pageScan.facts, "partial");
    assert.equal(result.report.pageScan.observations, "partial");
    assert.equal(result.report.lifecycle, "unavailable");
    assert.ok(result.report.codes.includes("EVENT_STORE_CORRUPT"));
    assertSafeAllowlist(result.report, [...LEAK_CANARIES, written.event.eventId, "first event receipt does not match its fact"]);
    fixture.success();
  });

  await t.test("page cap and a non-advancing cursor are reported as partial", async (t) => {
    const cappedFixture = await makeFixture(t, "page-cap");
    for (let index = 0; index < 33; index += 1) {
      await appendEvent(cappedFixture, {
        eventId: `page-cap-${index}`,
        kind: "fact",
        payload: { ordinal: index },
        sourcePin: ACCEPTED_NATIVE_PIN,
      });
    }
    const capped = await buildTurnDiagnostics({
      scope: SCOPE,
      attemptId: ATTEMPT_ID,
      store: constrainPageSize(cappedFixture.store, 1),
    });
    assert.equal(capped.status, "built");
    assert.deepEqual(capped.report.pageScan, { facts: "partial", observations: "partial" });
    assert.ok(capped.report.codes.includes("PAGE_LIMIT"));
    assert.equal(capped.report.lifecycle, "unavailable");
    assert.equal(capped.report.turnSeal, "unavailable");
    cappedFixture.success();

    const stalledFixture = await makeFixture(t, "stalled-cursor");
    await appendEvent(stalledFixture, { kind: "fact", payload: { ordinal: 1 }, sourcePin: ACCEPTED_NATIVE_PIN });
    const stalled = await buildTurnDiagnostics({
      scope: SCOPE,
      attemptId: ATTEMPT_ID,
      store: stallCursor(stalledFixture.store),
    });
    assert.equal(stalled.status, "built");
    assert.deepEqual(stalled.report.pageScan, { facts: "partial", observations: "partial" });
    assert.ok(stalled.report.codes.includes("CURSOR_STALLED"));
    assert.equal(stalled.report.lifecycle, "unavailable");
    assert.equal(stalled.report.turnSeal, "unavailable");
    stalledFixture.success();
  });

  await t.test("found U06 receipt outside a partial facts scan stays unverified", async (t) => {
    const fixture = await makeFixture(t, "receipt-outside-page");
    const { evidenceReport, receiptEventId, scope } = await makeOwnedEvidenceReport(fixture, {
      receiptPrecedingFacts: 33,
    });
    const receiptLookup = fixture.store.queryReceipt({ source: RECEIPT_SOURCE, eventId: receiptEventId });
    assert.equal(receiptLookup.status, "found", "the actual U05 receipt lookup should find the committed receipt");

    const result = await buildTurnDiagnostics({
      scope,
      attemptId: ATTEMPT_ID,
      store: constrainPageSize(fixture.store, 1),
      evidenceReports: [evidenceReport],
    });
    assert.equal(result.status, "built");
    const report = result.report;
    const evidence = report.evidenceReports[0];
    assert.deepEqual(report.pageScan, { facts: "partial", observations: "partial" });
    assert.equal(report.lifecycle, "unavailable");
    assert.equal(report.turnSeal, "unavailable");
    assert.equal(report.facts.some(({ kind }) => kind === "operation_receipt"), false,
      "the target receipt fact must remain outside the scanned page window");
    assert.equal(evidence.toolReceipt.status, "unverified");
    assert.equal(evidence.toolReceipt.eventRef, null);
    assert.equal(evidence.toolReceipt.commitSequence, null);
    assert.equal(evidence.toolReceipt.canonicalHashRef, null);
    assert.ok(evidence.codes.includes("TOOL_RECEIPT_UNVERIFIED"));
    assert.ok(report.codes.includes("TOOL_RECEIPT_UNVERIFIED"));
    assertSafeAllowlist(report, [...LEAK_CANARIES, receiptEventId, evidenceReport.operationId, evidenceReport.toolCallId]);
    fixture.success();
  });
});

async function makeFixture(t, prefix) {
  await mkdir(experimentParent, { recursive: true });
  const parentInfo = await lstat(experimentParent);
  assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "U09 experiment root must be a physical directory");
  const physicalParent = await realpath(experimentParent);
  const directory = await mkdtemp(path.join(physicalParent, `${prefix}-`));
  const physicalDirectory = await realpath(directory);
  assertContained(physicalParent, physicalDirectory);
  const databasePath = path.join(physicalDirectory, "events.sqlite");
  let store = openEventStore({ path: databasePath });
  let successful = false;
  t.after(async () => {
    await store.close().catch(() => {});
    if (successful) await removeOwnedFixture(physicalDirectory);
    else console.error(`P02-U09 failed fixture preserved at ${physicalDirectory}`);
  });
  return {
    directory: physicalDirectory,
    databasePath,
    get store() { return store; },
    replaceStore(next) { store = next; },
    success() { successful = true; },
  };
}

async function removeOwnedFixture(target) {
  const physicalParent = await realpath(experimentParent);
  const absoluteTarget = path.resolve(target);
  const targetInfo = await lstat(absoluteTarget).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (targetInfo === undefined) return;
  assert.ok(targetInfo.isDirectory() && !targetInfo.isSymbolicLink(), "cleanup target must be an owned physical fixture");
  const physicalTarget = await realpath(absoluteTarget);
  assertContained(physicalParent, physicalTarget);
  await rm(physicalTarget, { recursive: true, force: true });
}

function assertContained(parent, target) {
  const relative = path.relative(parent, target);
  assert.ok(relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "U09 fixture cleanup must stay below its owned experiment root");
}

async function appendEvent(fixture, options) {
  const eventId = options.eventId ?? `u09-event-${randomUUID()}`;
  const source = options.source ?? RECEIPT_SOURCE;
  const scope = Object.freeze({ ...SCOPE, ...(options.scope ?? {}) });
  const event = normalizeRuntimeEvent({
    source,
    eventId,
    scope,
    attemptId: options.attemptId ?? ATTEMPT_ID,
    operationId: options.operationId ?? (options.kind === "operation_intent" || options.kind === "operation_receipt" ? "u09-operation" : null),
    kind: options.kind ?? "fact",
    occurredAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    sourceSequence: ++eventSequence,
    payload: options.payload ?? { fixture: "U09", canary: LEAK_CANARIES[3] },
  });
  const admission = fixture.store.append({
    event,
    origin: makeEventOrigin(eventId, options.sourcePin ?? ACCEPTED_NATIVE_PIN),
    ...(options.capture === undefined ? {} : { capture: options.capture }),
  });
  assert.equal(admission.status, "queued", `U05 append admission was ${admission.status}`);
  const completion = await admission.completion;
  assert.ok(completion.status === "committed" || completion.status === "duplicate",
    `U05 append completed as ${completion.status}`);
  return { event, completion, observationKey: admission.observationKey };
}

let eventSequence = 0;

function makeEventOrigin(eventId, sourcePin) {
  return {
    sourcePin,
    historicalLocator: `u09-owned-source/${eventId}`,
    rawSha256: sha256(Buffer.from(`origin:${eventId}`, "utf8")),
    rawBytes: 128,
    extent: "single-event-envelope",
    rawRetained: false,
  };
}

async function makeCapture(fixture, scope, sourcePin) {
  const rawPath = path.join(fixture.directory, "U09_RAW_TRANSCRIPT_CANARY.jsonl");
  const rawContent = Buffer.from(`${LEAK_CANARIES[4]}\n`, "utf8");
  const messageText = LEAK_CANARIES[4];
  await writeFile(rawPath, rawContent, { flag: "wx" });
  const snapshot = {
    schemaVersion: 1,
    redactionVersion: "full-mask-v1",
    messages: [{
      role: "user",
      text: "[REDACTED]",
      textBytes: Buffer.byteLength(messageText, "utf8"),
      textSha256: sha256(Buffer.from(messageText, "utf8")),
    }],
  };
  const capture = {
    schemaVersion: 1,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    hookEventName: "UserPromptSubmit",
    origin: {
      temporaryLocator: path.basename(rawPath),
      locatorUse: "historical-only",
      rawBytes: rawContent.byteLength,
      rawSha256: sha256(rawContent),
      sourcePin,
      extent: "current-message",
      rawRetained: false,
    },
    snapshot,
    snapshotSha256: sha256(Buffer.from(canonicalizeJson(snapshot), "utf8")),
  };
  return { value: capture, rawPath, rawBytes: rawContent.byteLength };
}

async function makeOwnedEvidenceReport(fixture, { receiptPrecedingFacts = 0 } = {}) {
  const sourceRoot = path.join(fixture.directory, "source-repository");
  const artifactRoot = path.join(fixture.directory, LEAK_CANARIES[5]);
  const artifactPath = path.join(artifactRoot, "result.txt");
  const artifactLocator = "result.txt";
  const artifactContent = Buffer.from("synthetic U09 artifact bytes", "utf8");
  await mkdir(sourceRoot);
  await mkdir(artifactRoot);
  await writeFile(path.join(sourceRoot, "writer.mjs"), [
    'import { writeFile } from "node:fs/promises";',
    'const [output] = process.argv.slice(2);',
    'await writeFile(output, "synthetic U09 artifact bytes", "utf8");',
    `process.stdout.write(${JSON.stringify(LEAK_CANARIES[6])});`,
    `process.stderr.write(${JSON.stringify(LEAK_CANARIES[7])});`,
    "",
  ].join("\n"), "utf8");
  git(sourceRoot, ["init", "--quiet"]);
  git(sourceRoot, ["config", "user.name", "P02 U09 owned fixture"]);
  git(sourceRoot, ["config", "user.email", "p02-u09-fixture@example.invalid"]);
  git(sourceRoot, ["add", "writer.mjs"]);
  git(sourceRoot, ["commit", "--quiet", "-m", "U09 owned evidence fixture"]);
  const sourceCommit = git(sourceRoot, ["rev-parse", "HEAD"]);

  const run = await runOwnedNode({
    repositoryRoot: sourceRoot,
    expectedSourceCommit: sourceCommit,
    script: "writer.mjs",
    args: [artifactPath],
  });
  assert.equal(run.status, "exited");
  assert.equal(run.exitCode, 0);
  assert.ok(Number.isSafeInteger(run.processId));
  assert.equal(sha256(await readFile(artifactPath)), sha256(artifactContent));

  const scope = Object.freeze({ ...SCOPE, runId: run.runId });

  for (let index = 0; index < receiptPrecedingFacts; index += 1) {
    await appendEvent(fixture, {
      eventId: `receipt-prefix-${index}`,
      kind: "fact",
      payload: { ordinal: index },
      sourcePin: ACCEPTED_NATIVE_PIN,
      scope,
    });
  }

  const operationId = "U09_OPERATION_ID_CANARY";
  const toolCallId = "U09_TOOL_CALL_ID_CANARY";
  const receiptEventId = "U09_OPERATION_RECEIPT_EVENT_CANARY";
  const observedAt = new Date().toISOString();
  const event = normalizeRuntimeEvent({
    source: RECEIPT_SOURCE,
    eventId: receiptEventId,
    scope,
    attemptId: ATTEMPT_ID,
    operationId,
    kind: "operation_receipt",
    occurredAt: observedAt,
    observedAt,
    sourceSequence: ++eventSequence,
    payload: {
      operationId,
      status: "success",
      observedAt,
      result: {
        profile: OWNED_ARTIFACT_INTEGRITY_PROFILE,
        runId: run.runId,
        processId: run.processId,
        toolCallId,
        sourceCommitAtLaunch: run.sourceCommitAtLaunch,
        artifact: {
          locator: artifactLocator,
          bytes: artifactContent.byteLength,
          sha256: sha256(artifactContent),
        },
      },
    },
  });
  const admission = fixture.store.append({
    event,
    origin: makeEventOrigin(receiptEventId, ACCEPTED_NATIVE_PIN),
  });
  assert.equal(admission.status, "queued");
  const completion = await admission.completion;
  assert.equal(completion.status, "committed");

  const reader = await createLocalEvidenceReader({
    repositoryRoot: sourceRoot,
    artifactRoot,
    expectedReceiptSource: RECEIPT_SOURCE,
    eventStore: fixture.store,
  });
  const evidenceReport = await buildEvidenceReport({
    run,
    scope,
    attemptId: ATTEMPT_ID,
    operationId,
    toolCallId,
    artifactLocator,
  }, reader);
  assert.equal(evidenceReport.execution.status, "passed");
  assert.equal(evidenceReport.toolReceipt.status, "verified");
  assert.equal(evidenceReport.artifact.status, "verified");
  assert.equal(evidenceReport.sourceRevision.status, "verified");
  assert.equal(evidenceReport.profileResult.status, "passed");
  return { evidenceReport, receiptEventId, sourceCommit, artifactPath, scope };
}

function assertShaRef(value) {
  assert.match(value, /^[a-f0-9]{64}$/);
}

function assertSafeAllowlist(report, canaries = []) {
  const serialized = JSON.stringify(report);
  for (const canary of canaries) assert.equal(serialized.includes(canary), false, `diagnostics leaked ${canary}`);
  walkKeys(report);
  function walkKeys(value) {
    if (Array.isArray(value)) {
      for (const item of value) walkKeys(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(FORBIDDEN_KEYS.has(key), false, `diagnostics exported forbidden field ${key}`);
      walkKeys(child);
    }
  }
}

function constrainPageSize(store, pageSize) {
  return Object.freeze({
    read(query = {}) { return store.read({ ...query, limit: pageSize }); },
    readObservations(query = {}) { return store.readObservations({ ...query, limit: pageSize }); },
    queryReceipt(identity, observationKey) { return store.queryReceipt(identity, observationKey); },
  });
}

function stallCursor(store) {
  return Object.freeze({
    read(query = {}) {
      const page = store.read(query);
      return { ...page, hasMore: true, nextAfterCommitSequence: query.afterCommitSequence ?? 0 };
    },
    readObservations(query = {}) {
      const page = store.readObservations(query);
      return { ...page, hasMore: true, nextAfterCommitSequence: query.afterCommitSequence ?? 0 };
    },
    queryReceipt(identity, observationKey) { return store.queryReceipt(identity, observationKey); },
  });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.error, undefined, `owned Git fixture command should start: ${args[0]}`);
  assert.equal(result.status, 0, `owned Git fixture command should succeed: ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
