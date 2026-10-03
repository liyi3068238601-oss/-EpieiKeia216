/** Initial normalized-event store schema. Future changes belong in new migrations. */
export const EVENT_STORE_SCHEMA_VERSION = 1;

export const EVENT_STORE_SCHEMA_V1 = `
CREATE TABLE writer_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_commit_sequence INTEGER NOT NULL CHECK
    (last_commit_sequence BETWEEN 0 AND 9007199254740991)
) STRICT;
INSERT INTO writer_state (singleton, last_commit_sequence) VALUES (1, 0);

CREATE TABLE events (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  run_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  operation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN
    ('fact','draft','success','failure','cancel','interrupted','operation_intent','operation_receipt')),
  occurred_at TEXT NOT NULL,
  canonical_facts_json TEXT NOT NULL,
  canonical_hash TEXT NOT NULL CHECK (length(canonical_hash) = 64),
  first_commit_sequence INTEGER NOT NULL UNIQUE CHECK
    (first_commit_sequence BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (source, event_id),
  CHECK (kind NOT IN ('operation_intent','operation_receipt') OR
         (operation_id IS NOT NULL AND length(operation_id) > 0))
) STRICT, WITHOUT ROWID;

CREATE TABLE event_observations (
  observation_key TEXT PRIMARY KEY CHECK (length(observation_key) = 64),
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  commit_sequence INTEGER NOT NULL UNIQUE CHECK
    (commit_sequence BETWEEN 1 AND 9007199254740991),
  observed_at TEXT NOT NULL,
  source_sequence INTEGER CHECK
    (source_sequence IS NULL OR source_sequence BETWEEN 1 AND 9007199254740991),
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64),
  disposition TEXT NOT NULL CHECK
    (disposition IN ('accepted','duplicate','redelivery_resequenced','identity_conflict')),
  candidate_scope_session_id TEXT,
  candidate_scope_turn_id TEXT,
  candidate_scope_run_id TEXT,
  candidate_scope_task_id TEXT,
  candidate_attempt_id TEXT,
  candidate_operation_id TEXT,
  candidate_kind TEXT NOT NULL,
  event_json TEXT NOT NULL,
  conflict_facts_json TEXT,
  origin_json TEXT NOT NULL,
  FOREIGN KEY (source, event_id) REFERENCES events(source, event_id),
  UNIQUE (source, event_id, observation_key),
  CHECK ((disposition = 'identity_conflict') = (conflict_facts_json IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE event_origins (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  first_observation_key TEXT NOT NULL,
  PRIMARY KEY (source, event_id),
  FOREIGN KEY (source, event_id) REFERENCES events(source, event_id),
  FOREIGN KEY (source, event_id, first_observation_key)
    REFERENCES event_observations(source, event_id, observation_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE transcript_materials (
  observation_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  hook_event_name TEXT NOT NULL CHECK
    (hook_event_name IN ('UserPromptSubmit','Stop')),
  capture_origin_json TEXT NOT NULL,
  snapshot_json BLOB NOT NULL CHECK (length(snapshot_json) BETWEEN 1 AND 4096),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
  FOREIGN KEY (observation_key) REFERENCES event_observations(observation_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE event_receipts (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  canonical_hash TEXT NOT NULL CHECK (length(canonical_hash) = 64),
  first_commit_sequence INTEGER NOT NULL UNIQUE CHECK
    (first_commit_sequence BETWEEN 1 AND 9007199254740991),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (source, event_id),
  FOREIGN KEY (source, event_id) REFERENCES events(source, event_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX events_scope_commit
  ON events(session_id, turn_id, run_id, task_id, first_commit_sequence);
CREATE INDEX events_operation_commit
  ON events(operation_id, first_commit_sequence) WHERE operation_id IS NOT NULL;
CREATE INDEX event_observations_commit
  ON event_observations(commit_sequence);
CREATE INDEX observations_scope_commit
  ON event_observations(candidate_scope_session_id, candidate_scope_turn_id,
                        candidate_scope_run_id, candidate_scope_task_id, commit_sequence);
CREATE INDEX observations_operation_commit
  ON event_observations(candidate_operation_id, commit_sequence)
  WHERE candidate_operation_id IS NOT NULL;
`;
