import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { openSQLiteConnection, type SQLiteConnection } from "../../events/src/sqlite.js";
import {
  canonicalizeEventFacts,
  canonicalizeJson,
} from "../../../contracts/src/events.js";
import type { JsonValue } from "../../../contracts/src/json-value.js";
import { openEventStore } from "../../events/src/index.js";
import { EVENT_STORE_SCHEMA_V1, EVENT_STORE_SCHEMA_VERSION } from "../../../../migrations/001-event-store.js";

const SQLITE_BUSY_TIMEOUT_MS = 180;
const PAGE_SIZE = 256;
const DEFAULT_DEADLINE_MS = 30_000;
const MAX_DEADLINE_MS = 30_000;
const HEX_256 = /^[a-f0-9]{64}$/;
const FINAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.sqlite$/i;

export type BackupMaintenanceCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_SCHEMA"
  | "UNSUPPORTED_FUTURE_SCHEMA"
  | "BUSY"
  | "FULL"
  | "READONLY"
  | "CORRUPT_DATABASE"
  | "BACKUP_FAILED"
  | "BACKUP_DEADLINE"
  | "PUBLISH_CONFLICT"
  | "MIGRATION_FAILED"
  | "RESTORE_FAILED"
  | "UNRESOLVED_TRANSACTION";

export type BackupMaintenanceStage =
  | "preflight"
  | "lock"
  | "backup"
  | "validate-backup"
  | "publish"
  | "migrate"
  | "restore-source"
  | "restore-backup"
  | "restore-publish";

export class BackupMaintenanceError extends Error {
  readonly code: BackupMaintenanceCode;
  readonly stage: BackupMaintenanceStage;

  constructor(
    code: BackupMaintenanceCode,
    stage: BackupMaintenanceStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupMaintenanceError";
    this.code = code;
    this.stage = stage;
  }
}

export interface BackupAndMigrateOptions {
  readonly databasePath: string;
  readonly backupDirectory: string;
  readonly backupName?: string;
  readonly deadlineMs?: number;
}

export type BackupMode = "initialize-empty-v0-to-v1" | "snapshot-v1-only";

export interface ContentDigest {
  readonly count: number;
  readonly sha256: string;
}

export interface DatabaseVerification {
  readonly schemaVersion: number;
  readonly integrityCheck: "ok";
  readonly foreignKeyCheck: "ok";
  readonly facts: ContentDigest;
  readonly observations: ContentDigest;
  readonly origins: ContentDigest;
  readonly receipts: ContentDigest;
  readonly captures: ContentDigest;
  readonly materials: ContentDigest;
}

export interface BackupAndMigrateReport {
  readonly mode: BackupMode;
  readonly sourceSchemaVersion: 0 | 1;
  readonly schemaVersion: 1;
  readonly backupPath: string;
  readonly backupSha256: string;
  readonly sourceVerification: DatabaseVerification;
  readonly backupVerification: DatabaseVerification;
}

export interface RestoreBackupOptions {
  readonly backupPath: string;
  readonly destinationDirectory: string;
  readonly deadlineMs?: number;
}

export interface RestoreBackupReport {
  readonly backupPath: string;
  readonly backupSha256: string;
  readonly destinationDirectory: string;
  readonly databasePath: string;
  readonly databaseSha256: string;
  readonly schemaVersion: 0 | 1;
  readonly verification: DatabaseVerification;
}

interface NormalizedDeadline {
  readonly value: number;
}

interface DatabaseHeader {
  readonly userVersion: number;
  readonly journalMode: string;
  readonly userObjects: number;
}

interface InternalVerification extends DatabaseVerification {
  readonly userVersion: 0 | 1;
}

interface DigestBuilder {
  add(value: JsonValue): void;
  finish(): ContentDigest;
}

/** Backs up an event store before initializing an empty v0 file. Existing v1 stores are snapshot-only. */
export async function backupAndMigrateEventStore(input: BackupAndMigrateOptions): Promise<BackupAndMigrateReport> {
  const options = normalizeBackupOptions(input);
  let header: DatabaseHeader;
  try {
    header = inspectHeader(options.databasePath, "preflight");
    assertSupportedHeader(header, true, "preflight");
    await assertExistingDirectory(options.backupDirectory, "preflight");
  } catch (error) {
    throw asMaintenanceError(error, "preflight", "CORRUPT_DATABASE");
  }

  const backupPath = path.join(options.backupDirectory, options.backupName);
  const coordinator = openCoordinator(options.databasePath, "lock");
  let transactionOpen = false;
  let tempDirectory: string | undefined;
  let backupPublished = false;
  let migrationCommitted = false;
  let operationFailed = false;
  try {
    try {
      coordinator.exec("BEGIN IMMEDIATE");
      transactionOpen = coordinator.isTransaction;
      if (!transactionOpen) {
        throw maintenanceError("UNRESOLVED_TRANSACTION", "lock", "SQLite did not enter the maintenance transaction");
      }
    } catch (error) {
      throw asMaintenanceError(error, "lock", "BUSY");
    }

    const lockedHeader = inspectHeader(options.databasePath, "lock");
    assertSupportedHeader(lockedHeader, true, "lock");
    if (lockedHeader.userVersion !== header.userVersion || lockedHeader.journalMode !== header.journalMode) {
      throw maintenanceError("UNSUPPORTED_SCHEMA", "lock", "database changed between preflight and maintenance lock");
    }

    const sourceVerification = await verifyDatabase(options.databasePath, "lock");
    if (sourceVerification.userVersion !== header.userVersion) {
      throw maintenanceError("UNSUPPORTED_SCHEMA", "lock", "database schema changed during maintenance preflight");
    }
    tempDirectory = await mkdtemp(path.join(options.backupDirectory, ".p02-snapshot-"));
    const stagedBackupPath = path.join(tempDirectory, "snapshot.sqlite");

    const backupSource = openReadOnly(options.databasePath, "backup");
    let backupFailure: unknown;
    let deadlineExceeded = false;
    const startedAt = performance.now();
    try {
      await backupSource.backup(stagedBackupPath, {
        progress: () => {
          if (performance.now() - startedAt >= options.deadline.value) {
            deadlineExceeded = true;
            throw new Error("cooperative SQLite backup deadline reached");
          }
          return 100;
        },
      });
      if (performance.now() - startedAt >= options.deadline.value) {
        deadlineExceeded = true;
        throw new Error("SQLite backup completed after its deadline");
      }
    } catch (error) {
      backupFailure = error;
    }
    try {
      backupSource.close();
    } catch (error) {
      backupFailure ??= error;
    }
    if (backupFailure !== undefined) {
      throw maintenanceError(
        deadlineExceeded ? "BACKUP_DEADLINE" : "BACKUP_FAILED",
        "backup",
        deadlineExceeded ? "SQLite backup exceeded its cooperative deadline" : "SQLite backup did not complete",
        backupFailure,
      );
    }

    let backupVerification: InternalVerification;
    try {
      backupVerification = await verifyDatabase(stagedBackupPath, "validate-backup");
      assertSameContent(sourceVerification, backupVerification, "validate-backup");
    } catch (error) {
      throw asMaintenanceError(error, "validate-backup", "CORRUPT_DATABASE");
    }

    let backupSha256: string;
    try {
      backupSha256 = await fileSha256(stagedBackupPath);
      await publishNoClobber(stagedBackupPath, backupPath, "publish");
      backupPublished = true;
    } catch (error) {
      throw asMaintenanceError(error, "publish", "PUBLISH_CONFLICT");
    }

    if (header.userVersion === 0) {
      try {
        coordinator.exec(EVENT_STORE_SCHEMA_V1);
        coordinator.exec("PRAGMA user_version = 1");
        coordinator.exec("COMMIT");
        transactionOpen = coordinator.isTransaction;
        if (transactionOpen) {
          throw maintenanceError("UNRESOLVED_TRANSACTION", "migrate", "SQLite remained in a transaction after migration commit");
        }
        migrationCommitted = true;
      } catch (error) {
        let active = true;
        try { active = coordinator.isTransaction; } catch { /* Reread verification below resolves the outcome. */ }
        if (active) {
          try {
            coordinator.exec("ROLLBACK");
            active = coordinator.isTransaction;
          } catch { /* The read-only verification below determines whether commit took effect. */ }
        }
        transactionOpen = active;
        if (active) {
          throw maintenanceError("UNRESOLVED_TRANSACTION", "migrate", "migration transaction could not be resolved", error);
        }
        const outcome = await readMigrationOutcome(options.databasePath);
        if (outcome === "verified-v1") migrationCommitted = true;
        else if (outcome === "verified-empty-v0") throw asMaintenanceError(error, "migrate", "MIGRATION_FAILED");
        else {
          throw maintenanceError("UNRESOLVED_TRANSACTION", "migrate", "migration commit outcome could not be verified", error);
        }
      }
    } else {
      try {
        coordinator.exec("COMMIT");
        transactionOpen = coordinator.isTransaction;
        if (transactionOpen) throw maintenanceError("UNRESOLVED_TRANSACTION", "migrate", "maintenance lock did not release");
      } catch (error) {
        let active = true;
        try { active = coordinator.isTransaction; } catch { /* Preserve unresolved status. */ }
        transactionOpen = active;
        if (active) throw asMaintenanceError(error, "migrate", "UNRESOLVED_TRANSACTION");
        if (await readMigrationOutcome(options.databasePath) !== "verified-v1") {
          throw maintenanceError("UNRESOLVED_TRANSACTION", "migrate", "maintenance commit outcome could not be verified", error);
        }
      }
    }

    if (!migrationCommitted && header.userVersion === 0) {
      throw maintenanceError("MIGRATION_FAILED", "migrate", "v0 initialization did not reach a verified v1 commit");
    }
    return Object.freeze({
      mode: header.userVersion === 0 ? "initialize-empty-v0-to-v1" : "snapshot-v1-only",
      sourceSchemaVersion: header.userVersion,
      schemaVersion: 1,
      backupPath,
      backupSha256,
      sourceVerification,
      backupVerification,
    });
  } catch (error) {
    operationFailed = true;
    if (transactionOpen) {
      let active = true;
      try { active = coordinator.isTransaction; } catch { /* Still attempt rollback. */ }
      if (active) {
        try {
          coordinator.exec("ROLLBACK");
          active = coordinator.isTransaction;
        } catch { /* Report unresolved transaction below. */ }
      }
      transactionOpen = active;
      if (active) {
        throw maintenanceError("UNRESOLVED_TRANSACTION", stageFor(error, "migrate"), "maintenance transaction could not be rolled back", error);
      }
    }
    if (error instanceof BackupMaintenanceError) throw error;
    throw asMaintenanceError(error, backupPublished ? "migrate" : "backup", "BACKUP_FAILED");
  } finally {
    try {
      coordinator.close();
    } catch (error) {
      if (!operationFailed) {
        operationFailed = true;
        throw maintenanceError("UNRESOLVED_TRANSACTION", "migrate", "SQLite maintenance connection did not close cleanly", error);
      }
    }
    if (!operationFailed && tempDirectory !== undefined) {
      await removeOwnedTempDirectory(tempDirectory, options.backupDirectory);
    }
  }
}

/** Restores a verified backup into a newly created directory using SQLite's online backup API. */
export async function restoreEventStoreBackup(input: RestoreBackupOptions): Promise<RestoreBackupReport> {
  const options = normalizeRestoreOptions(input);
  let sourceVerification: InternalVerification;
  let backupSha256: string;
  try {
    await assertExistingFile(options.backupPath, "restore-source");
    sourceVerification = await verifyDatabase(options.backupPath, "restore-source");
    backupSha256 = await fileSha256(options.backupPath);
    await assertNewDirectoryTarget(options.destinationDirectory, "restore-source");
  } catch (error) {
    throw asMaintenanceError(error, "restore-source", "CORRUPT_DATABASE");
  }

  const parentDirectory = path.dirname(options.destinationDirectory);
  await assertExistingDirectory(parentDirectory, "restore-source");
  try {
    await mkdir(options.destinationDirectory);
  } catch (error) {
    throw asMaintenanceError(error, "restore-publish", "PUBLISH_CONFLICT");
  }

  let published = false;
  let restoreSucceeded = false;
  const stageDirectory = path.join(options.destinationDirectory, ".p02-restore-stage");
  const stagedPath = path.join(stageDirectory, "restored.sqlite");
  const databasePath = path.join(options.destinationDirectory, "events.sqlite");
  try {
    await mkdir(stageDirectory);
    const source = openReadOnly(options.backupPath, "restore-backup");
    let failure: unknown;
    let deadlineExceeded = false;
    const startedAt = performance.now();
    try {
      await source.backup(stagedPath, {
        progress: () => {
          if (performance.now() - startedAt >= options.deadline.value) {
            deadlineExceeded = true;
            throw new Error("cooperative SQLite restore deadline reached");
          }
          return 100;
        },
      });
      if (performance.now() - startedAt >= options.deadline.value) {
        deadlineExceeded = true;
        throw new Error("SQLite restore completed after its deadline");
      }
    } catch (error) {
      failure = error;
    }
    try { source.close(); } catch (error) { failure ??= error; }
    if (failure !== undefined) {
      throw maintenanceError(deadlineExceeded ? "BACKUP_DEADLINE" : "RESTORE_FAILED", "restore-backup",
        deadlineExceeded ? "SQLite restore exceeded its cooperative deadline" : "SQLite restore backup did not complete", failure);
    }

    let restoredVerification: InternalVerification;
    try {
      restoredVerification = await verifyDatabase(stagedPath, "restore-backup");
      assertSameContent(sourceVerification, restoredVerification, "restore-backup");
    } catch (error) {
      throw asMaintenanceError(error, "restore-backup", "CORRUPT_DATABASE");
    }
    const databaseSha256 = await fileSha256(stagedPath);
    try {
      await publishNoClobber(stagedPath, databasePath, "restore-publish");
      published = true;
    } catch (error) {
      throw asMaintenanceError(error, "restore-publish", "PUBLISH_CONFLICT");
    }

    const report = Object.freeze({
      backupPath: options.backupPath,
      backupSha256,
      destinationDirectory: options.destinationDirectory,
      databasePath,
      databaseSha256,
      schemaVersion: sourceVerification.userVersion,
      verification: restoredVerification,
    });
    restoreSucceeded = true;
    return report;
  } catch (error) {
    if (error instanceof BackupMaintenanceError) throw error;
    throw asMaintenanceError(error, published ? "restore-publish" : "restore-backup", "RESTORE_FAILED");
  } finally {
    if (restoreSucceeded) {
      await removeOwnedTempDirectory(stageDirectory, options.destinationDirectory);
    }
  }
}

function normalizeBackupOptions(value: BackupAndMigrateOptions): Required<BackupAndMigrateOptions> & { deadline: NormalizedDeadline } {
  if (!hasExactFields(value, ["databasePath", "backupDirectory"], ["backupName", "deadlineMs"])) {
    throw maintenanceError("INVALID_INPUT", "preflight", "backup options contain invalid fields");
  }
  const databasePath = normalizeFilePath(value.databasePath, "databasePath");
  const backupDirectory = normalizeFilePath(value.backupDirectory, "backupDirectory");
  if (databasePath === backupDirectory || isPathInside(backupDirectory, databasePath)) {
    throw maintenanceError("INVALID_INPUT", "preflight", "backup directory must not contain the source database");
  }
  const backupName = value.backupName ?? `events-${new Date().toISOString().replaceAll(":", "-")}.sqlite`;
  if (typeof backupName !== "string" || !FINAL_NAME_PATTERN.test(backupName) || backupName.includes("..")) {
    throw maintenanceError("INVALID_INPUT", "preflight", "backupName must be a safe .sqlite basename");
  }
  const deadlineMs = normalizeDeadline(value.deadlineMs, "preflight");
  return Object.freeze({ databasePath, backupDirectory, backupName, deadlineMs, deadline: { value: deadlineMs } });
}

function normalizeRestoreOptions(value: RestoreBackupOptions): Required<RestoreBackupOptions> & { deadline: NormalizedDeadline } {
  if (!hasExactFields(value, ["backupPath", "destinationDirectory"], ["deadlineMs"])) {
    throw maintenanceError("INVALID_INPUT", "restore-source", "restore options contain invalid fields");
  }
  const backupPath = normalizeFilePath(value.backupPath, "backupPath");
  const destinationDirectory = normalizeFilePath(value.destinationDirectory, "destinationDirectory");
  if (path.dirname(destinationDirectory) === destinationDirectory || isPathInside(destinationDirectory, backupPath)) {
    throw maintenanceError("INVALID_INPUT", "restore-source", "destination must be a new non-root directory separate from the backup");
  }
  const deadlineMs = normalizeDeadline(value.deadlineMs, "restore-source");
  return Object.freeze({ backupPath, destinationDirectory, deadlineMs, deadline: { value: deadlineMs } });
}

function normalizeDeadline(value: number | undefined, stage: BackupMaintenanceStage): number {
  const deadlineMs = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) {
    throw maintenanceError("INVALID_INPUT", stage, `deadlineMs must be an integer from 1 through ${MAX_DEADLINE_MS}`);
  }
  return deadlineMs;
}

function normalizeFilePath(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw maintenanceError("INVALID_INPUT", "preflight", `${label} must be a non-empty filesystem path`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw maintenanceError("INVALID_INPUT", "preflight", `${label} cannot be a filesystem root`);
  }
  return resolved;
}

function inspectHeader(databasePath: string, stage: BackupMaintenanceStage): DatabaseHeader {
  const database = openReadOnly(databasePath, stage);
  try {
    const userVersion = pragmaInteger(database, "user_version", stage);
    const journalMode = String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase();
    const objects = listUserObjects(database);
    return Object.freeze({ userVersion, journalMode, userObjects: objects.length });
  } finally {
    database.close();
  }
}

function assertSupportedHeader(header: DatabaseHeader, requireWalForV1: boolean, stage: BackupMaintenanceStage): void {
  if (header.userVersion > EVENT_STORE_SCHEMA_VERSION) {
    throw maintenanceError("UNSUPPORTED_FUTURE_SCHEMA", stage, `schema version ${header.userVersion} is newer than supported version 1`);
  }
  if (header.userVersion < 0 || header.userVersion > 1) {
    throw maintenanceError("UNSUPPORTED_SCHEMA", stage, `schema version ${header.userVersion} is unsupported`);
  }
  if (header.userVersion === 0 && header.userObjects !== 0) {
    throw maintenanceError("UNSUPPORTED_SCHEMA", stage, "schema version 0 database contains user objects; initialization was refused");
  }
  if (header.userVersion === 1 && requireWalForV1 && header.journalMode !== "wal") {
    throw maintenanceError("UNSUPPORTED_SCHEMA", stage, "schema version 1 database is not in WAL mode");
  }
}

async function verifyDatabase(databasePath: string, stage: BackupMaintenanceStage): Promise<InternalVerification> {
  const database = openReadOnly(databasePath, stage);
  try {
    const userVersion = pragmaInteger(database, "user_version", stage);
    const journalMode = String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase();
    const objects = listUserObjects(database);
    const header = Object.freeze({ userVersion, journalMode, userObjects: objects.length });
    assertSupportedHeader(header, false, stage);
    if (userVersion === 0) return verifyEmptyV0(database, stage);
    assertSchemaV1(database, objects, stage);
    return await verifyV1(databasePath, database, stage);
  } catch (error) {
    throw asMaintenanceError(error, stage, "CORRUPT_DATABASE");
  } finally {
    database.close();
  }
}

function verifyEmptyV0(database: SQLiteConnection, stage: BackupMaintenanceStage): InternalVerification {
  const objects = listUserObjects(database);
  if (objects.length !== 0) throw maintenanceError("UNSUPPORTED_SCHEMA", stage, "schema version 0 database is not empty");
  const integrityCheck = readIntegrityCheck(database, stage);
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length !== 0) throw maintenanceError("CORRUPT_DATABASE", stage, "schema version 0 database has foreign key violations");
  const empty = emptyDigest();
  return Object.freeze({
    userVersion: 0,
    schemaVersion: 0,
    integrityCheck,
    foreignKeyCheck: "ok",
    facts: empty,
    observations: empty,
    origins: empty,
    receipts: empty,
    captures: empty,
    materials: empty,
  });
}

async function verifyV1(databasePath: string, database: SQLiteConnection, stage: BackupMaintenanceStage): Promise<InternalVerification> {
  const integrityCheck = readIntegrityCheck(database, stage);
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw maintenanceError("CORRUPT_DATABASE", stage, "event store has foreign key violations");
  }

  const store = openEventStore({ path: databasePath, readOnly: true });
  try {
    const factDigest = createDigestBuilder();
    const observationDigest = createDigestBuilder();
    const receiptDigest = createDigestBuilder();
    const captureDigest = createDigestBuilder();
    let factCount = 0;
    let observationCount = 0;
    let captureCount = 0;
    let afterFact = 0;
    while (true) {
      const previousCursor = afterFact;
      const page = store.read({ afterCommitSequence: previousCursor, limit: PAGE_SIZE });
      if (page.items.length === 0 && page.hasMore) {
        throw maintenanceError("CORRUPT_DATABASE", stage, "fact pagination did not advance");
      }
      for (const item of page.items) {
        const event = item.event;
        const identity = { source: event.source, eventId: event.eventId };
        const canonicalFacts = canonicalizeEventFacts(event);
        const receipt = store.queryReceipt(identity);
        if (receipt.status !== "found" || receipt.firstReceipt === undefined ||
            receipt.firstReceipt.source !== identity.source || receipt.firstReceipt.eventId !== identity.eventId ||
            receipt.firstReceipt.canonicalHash !== sha256(canonicalFacts) ||
            receipt.firstReceipt.commitSequence !== item.commitSequence) {
          throw maintenanceError("CORRUPT_DATABASE", stage, "first event receipt does not match the stored fact");
        }
        factDigest.add({ commitSequence: item.commitSequence, event: event as unknown as JsonValue });
        receiptDigest.add(receipt.firstReceipt as unknown as JsonValue);
        factCount += 1;
        afterFact = item.commitSequence;
      }
      if (!page.hasMore) break;
      if (page.nextAfterCommitSequence === null || page.nextAfterCommitSequence <= previousCursor ||
          page.nextAfterCommitSequence !== afterFact) {
        throw maintenanceError("CORRUPT_DATABASE", stage, "fact pagination cursor is invalid");
      }
    }

    let afterObservation = 0;
    while (true) {
      const previousCursor = afterObservation;
      const page = store.readObservations({ afterCommitSequence: previousCursor, limit: PAGE_SIZE });
      if (page.items.length === 0 && page.hasMore) {
        throw maintenanceError("CORRUPT_DATABASE", stage, "observation pagination did not advance");
      }
      for (const observation of page.items) {
        observationDigest.add(observation as unknown as JsonValue);
        observationCount += 1;
        if (observation.capture !== undefined) {
          captureDigest.add({
            observationKey: observation.observationKey,
            capture: observation.capture as unknown as JsonValue,
          });
          captureCount += 1;
        }
        afterObservation = observation.commitSequence;
      }
      if (!page.hasMore) break;
      if (page.nextAfterCommitSequence === null || page.nextAfterCommitSequence <= previousCursor ||
          page.nextAfterCommitSequence !== afterObservation) {
        throw maintenanceError("CORRUPT_DATABASE", stage, "observation pagination cursor is invalid");
      }
    }

    const eventCount = pragmaCount(database, "events", stage);
    const observationRows = pragmaCount(database, "event_observations", stage);
    const originCount = pragmaCount(database, "event_origins", stage);
    const receiptCount = pragmaCount(database, "event_receipts", stage);
    const materialCount = pragmaCount(database, "transcript_materials", stage);
    if (eventCount !== factCount || observationRows !== observationCount || originCount !== factCount ||
        receiptCount !== factCount || materialCount !== captureCount) {
      throw maintenanceError("CORRUPT_DATABASE", stage, "event store row counts do not match validated projections");
    }

    const originDigest = verifyOrigins(database, stage, factCount);
    const materialDigest = verifyMaterials(database, stage, materialCount);
    validateWriterState(database, observationCount, stage);
    return Object.freeze({
      userVersion: 1,
      schemaVersion: 1,
      integrityCheck,
      foreignKeyCheck: "ok",
      facts: factDigest.finish(),
      observations: observationDigest.finish(),
      origins: originDigest,
      receipts: receiptDigest.finish(),
      captures: captureDigest.finish(),
      materials: materialDigest,
    });
  } finally {
    await store.close();
  }
}

function verifyOrigins(database: SQLiteConnection, stage: BackupMaintenanceStage, expectedCount: number): ContentDigest {
  const digest = createDigestBuilder();
  const rows = database.prepare(`
    SELECT eo.source, eo.event_id, eo.first_observation_key,
           e.first_commit_sequence, ob.commit_sequence, ob.disposition
    FROM event_origins AS eo
    JOIN events AS e ON e.source = eo.source AND e.event_id = eo.event_id
    LEFT JOIN event_observations AS ob
      ON ob.source = eo.source AND ob.event_id = eo.event_id
     AND ob.observation_key = eo.first_observation_key
    ORDER BY eo.source, eo.event_id
  `).all() as unknown as Record<string, unknown>[];
  if (rows.length !== expectedCount) throw maintenanceError("CORRUPT_DATABASE", stage, "first-origin count does not match facts");
  for (const row of rows) {
    if (row.commit_sequence !== row.first_commit_sequence || row.disposition !== "accepted") {
      throw maintenanceError("CORRUPT_DATABASE", stage, "first-origin reference does not identify the first accepted observation");
    }
    digest.add({
      source: requireText(row.source, "origin.source", stage),
      eventId: requireText(row.event_id, "origin.event_id", stage),
      firstObservationKey: requireText(row.first_observation_key, "origin.first_observation_key", stage),
      firstCommitSequence: requireInteger(row.first_commit_sequence, "origin.first_commit_sequence", stage),
    });
  }
  return digest.finish();
}

function verifyMaterials(database: SQLiteConnection, stage: BackupMaintenanceStage, expectedCount: number): ContentDigest {
  const digest = createDigestBuilder();
  const rows = database.prepare(`
    SELECT observation_key, schema_version, session_id, turn_id, hook_event_name,
           capture_origin_json, snapshot_json, snapshot_sha256
    FROM transcript_materials ORDER BY observation_key
  `).all() as unknown as Record<string, unknown>[];
  if (rows.length !== expectedCount) throw maintenanceError("CORRUPT_DATABASE", stage, "material count does not match captures");
  for (const row of rows) {
    const bytes = row.snapshot_json;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 4096) {
      throw maintenanceError("CORRUPT_DATABASE", stage, "transcript material snapshot is not a bounded blob");
    }
    const snapshotSha256 = requireText(row.snapshot_sha256, "material.snapshot_sha256", stage).toLowerCase();
    const blobSha256 = createHash("sha256").update(bytes).digest("hex");
    if (!HEX_256.test(snapshotSha256) || !HEX_256.test(blobSha256)) {
      throw maintenanceError("CORRUPT_DATABASE", stage, "transcript material contains an invalid digest");
    }
    digest.add({
      observationKey: requireText(row.observation_key, "material.observation_key", stage),
      schemaVersion: requireInteger(row.schema_version, "material.schema_version", stage),
      sessionId: requireText(row.session_id, "material.session_id", stage),
      turnId: requireText(row.turn_id, "material.turn_id", stage),
      hookEventName: requireText(row.hook_event_name, "material.hook_event_name", stage),
      captureOriginJson: requireText(row.capture_origin_json, "material.capture_origin_json", stage),
      snapshotBytes: bytes.byteLength,
      snapshotBlobSha256: blobSha256,
      snapshotSha256,
    });
  }
  return digest.finish();
}

function validateWriterState(database: SQLiteConnection, observationCount: number, stage: BackupMaintenanceStage): void {
  const row = database.prepare("SELECT singleton, last_commit_sequence FROM writer_state WHERE singleton = 1").get() as
    Record<string, unknown> | undefined;
  const maxRow = database.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS maximum FROM event_observations").get() as
    Record<string, unknown> | undefined;
  if (row === undefined || maxRow === undefined || row.singleton !== 1 ||
      row.last_commit_sequence !== maxRow.maximum ||
      (observationCount === 0 && row.last_commit_sequence !== 0)) {
    throw maintenanceError("CORRUPT_DATABASE", stage, "writer sequence state does not match committed observations");
  }
}

function assertSchemaV1(
  database: SQLiteConnection,
  actualObjects: readonly Record<string, unknown>[],
  stage: BackupMaintenanceStage,
): void {
  const expected = openSQLiteConnection(":memory:", { readonly: false, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    expected.exec(EVENT_STORE_SCHEMA_V1);
    const expectedObjects = listUserObjects(expected);
    const actualSignature = schemaSignature(actualObjects);
    const expectedSignature = schemaSignature(expectedObjects);
    if (actualSignature !== expectedSignature) {
      throw maintenanceError("UNSUPPORTED_SCHEMA", stage, "schema version 1 does not match the supported event store DDL");
    }
  } finally {
    expected.close();
  }
}

function schemaSignature(objects: readonly Record<string, unknown>[]): string {
  return canonicalizeJson(objects.map((row) => ({
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl_name),
    sql: String(row.sql),
  })).sort((left, right) => `${left.type}/${left.name}`.localeCompare(`${right.type}/${right.name}`)) as unknown as JsonValue);
}

function listUserObjects(database: SQLiteConnection): Record<string, unknown>[] {
  return database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name
  `).all() as unknown as Record<string, unknown>[];
}

function openCoordinator(databasePath: string, stage: BackupMaintenanceStage): SQLiteConnection {
  let database: SQLiteConnection | undefined;
  try {
    database = openSQLiteConnection(databasePath, { readonly: false, timeout: SQLITE_BUSY_TIMEOUT_MS });
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 180; PRAGMA synchronous = FULL;");
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the setup failure. */ }
    throw asMaintenanceError(error, stage, "BUSY");
  }
}

function openReadOnly(databasePath: string, stage: BackupMaintenanceStage): SQLiteConnection {
  let database: SQLiteConnection | undefined;
  try {
    database = openSQLiteConnection(databasePath, { readonly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 180;");
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the open failure. */ }
    throw asMaintenanceError(error, stage, "CORRUPT_DATABASE");
  }
}

function readIntegrityCheck(database: SQLiteConnection, stage: BackupMaintenanceStage): "ok" {
  const rows = database.prepare("PRAGMA integrity_check").all() as unknown as Record<string, unknown>[];
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw maintenanceError("CORRUPT_DATABASE", stage, "SQLite integrity_check did not return exactly ok");
  }
  return "ok";
}

function pragmaCount(database: SQLiteConnection, table: string, stage: BackupMaintenanceStage): number {
  const allowed = new Set(["events", "event_observations", "event_origins", "event_receipts", "transcript_materials"]);
  if (!allowed.has(table)) throw maintenanceError("CORRUPT_DATABASE", stage, "internal table count request is invalid");
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown> | undefined;
  return requireInteger(row?.count, `${table}.count`, stage);
}

function pragmaInteger(database: SQLiteConnection, pragma: "user_version", stage: BackupMaintenanceStage): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  return requireInteger(row?.[pragma], `PRAGMA ${pragma}`, stage);
}

function requireInteger(value: unknown, label: string, stage: BackupMaintenanceStage): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw maintenanceError("CORRUPT_DATABASE", stage, `${label} is not a safe integer`);
  }
  return value;
}

function requireText(value: unknown, label: string, stage: BackupMaintenanceStage): string {
  if (typeof value !== "string") throw maintenanceError("CORRUPT_DATABASE", stage, `${label} is not text`);
  return value;
}

function createDigestBuilder(): DigestBuilder {
  const hash = createHash("sha256");
  let count = 0;
  return {
    add(value: JsonValue): void {
      hash.update(canonicalizeJson(value), "utf8");
      hash.update("\n", "utf8");
      count += 1;
    },
    finish(): ContentDigest {
      return Object.freeze({ count, sha256: hash.copy().digest("hex") });
    },
  };
}

function emptyDigest(): ContentDigest {
  return Object.freeze({ count: 0, sha256: createHash("sha256").digest("hex") });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSameContent(left: DatabaseVerification, right: DatabaseVerification, stage: BackupMaintenanceStage): void {
  for (const key of ["facts", "observations", "origins", "receipts", "captures", "materials"] as const) {
    if (left[key].count !== right[key].count || left[key].sha256 !== right[key].sha256) {
      throw maintenanceError("CORRUPT_DATABASE", stage, `backup content verification failed for ${key}`);
    }
  }
  if (left.schemaVersion !== right.schemaVersion) {
    throw maintenanceError("CORRUPT_DATABASE", stage, "backup schema version does not match its source");
  }
}

async function readMigrationOutcome(databasePath: string): Promise<"verified-v1" | "verified-empty-v0" | "unavailable"> {
  try {
    const verification = await verifyDatabase(databasePath, "migrate");
    if (verification.userVersion === 1) return "verified-v1";
    if (verification.userVersion === 0) return "verified-empty-v0";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

async function publishNoClobber(source: string, destination: string, stage: BackupMaintenanceStage): Promise<void> {
  try {
    await link(source, destination);
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "EEXIST") {
      throw maintenanceError("PUBLISH_CONFLICT", stage, "publication target already exists and was preserved", error);
    }
    throw maintenanceError("BACKUP_FAILED", stage, "same-volume no-clobber publication failed", error);
  }
}

async function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function assertExistingDirectory(directoryPath: string, stage: BackupMaintenanceStage): Promise<void> {
  let details;
  try { details = await lstat(directoryPath); } catch (error) {
    throw maintenanceError("INVALID_INPUT", stage, "required directory does not exist", error);
  }
  if (!details.isDirectory()) throw maintenanceError("INVALID_INPUT", stage, "required path is not a directory");
  try { await access(directoryPath, fsConstants.R_OK | fsConstants.W_OK); } catch (error) {
    throw maintenanceError("INVALID_INPUT", stage, "required directory is not readable and writable", error);
  }
}

async function assertExistingFile(filePath: string, stage: BackupMaintenanceStage): Promise<void> {
  let details;
  try { details = await stat(filePath); } catch (error) {
    throw maintenanceError("INVALID_INPUT", stage, "source database file does not exist", error);
  }
  if (!details.isFile()) throw maintenanceError("INVALID_INPUT", stage, "source database path is not a file");
  try { await access(filePath, fsConstants.R_OK); } catch (error) {
    throw maintenanceError("INVALID_INPUT", stage, "source database file is not readable", error);
  }
}

async function assertNewDirectoryTarget(directoryPath: string, stage: BackupMaintenanceStage): Promise<void> {
  try {
    await lstat(directoryPath);
    throw maintenanceError("PUBLISH_CONFLICT", stage, "restore destination already exists");
  } catch (error) {
    if (error instanceof BackupMaintenanceError) throw error;
    if (readErrorCode(error) !== "ENOENT") throw maintenanceError("INVALID_INPUT", stage, "restore destination could not be checked", error);
  }
}

async function removeOwnedTempDirectory(targetPath: string, parentPath: string): Promise<void> {
  const absoluteTarget = path.resolve(targetPath);
  const absoluteParent = path.resolve(parentPath);
  if (!isPathInside(absoluteParent, absoluteTarget) || absoluteTarget === absoluteParent) return;
  try {
    const [physicalParent, physicalTarget] = await Promise.all([realpath(absoluteParent), realpath(absoluteTarget)]);
    const targetStats = await lstat(absoluteTarget);
    if (!targetStats.isDirectory() || targetStats.isSymbolicLink() ||
        !isPathInside(physicalParent, physicalTarget) || physicalParent === physicalTarget) return;
    await rm(physicalTarget, { recursive: true });
  } catch { /* Preserve failed stages and the primary operation result. */ }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasExactFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
        required.some((field) => !keys.includes(field))) return false;
    return keys.every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function maintenanceError(
  code: BackupMaintenanceCode,
  stage: BackupMaintenanceStage,
  message: string,
  cause?: unknown,
): BackupMaintenanceError {
  return new BackupMaintenanceError(code, stage, message, cause === undefined ? undefined : { cause });
}

function asMaintenanceError(
  error: unknown,
  stage: BackupMaintenanceStage,
  fallbackCode: BackupMaintenanceCode,
): BackupMaintenanceError {
  if (error instanceof BackupMaintenanceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = `${readErrorCode(error) ?? ""} ${message}`.toUpperCase();
  if (diagnostic.includes("SQLITE_BUSY") || /DATABASE IS (LOCKED|BUSY)/i.test(message)) {
    return maintenanceError("BUSY", stage, "SQLite remained busy within the bounded wait", error);
  }
  if (diagnostic.includes("SQLITE_FULL") || /DATABASE OR DISK IS FULL/i.test(message)) {
    return maintenanceError("FULL", stage, "SQLite database reached its configured page limit", error);
  }
  if (diagnostic.includes("SQLITE_READONLY") || /READ-ONLY|READONLY/i.test(message)) {
    return maintenanceError("READONLY", stage, "SQLite database or target directory is read-only", error);
  }
  if (diagnostic.includes("SQLITE_CORRUPT") || diagnostic.includes("SQLITE_NOTADB") || /MALFORMED|NOT A DATABASE/i.test(message)) {
    return maintenanceError("CORRUPT_DATABASE", stage, "SQLite database is corrupt or has an unknown format", error);
  }
  return maintenanceError(fallbackCode, stage, "SQLite backup maintenance failed", error);
}

function readErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function stageFor(error: unknown, fallback: BackupMaintenanceStage): BackupMaintenanceStage {
  return error instanceof BackupMaintenanceError ? error.stage : fallback;
}
