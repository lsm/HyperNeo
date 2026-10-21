import type { Database } from '../sqlite-compat.ts';

export function runMigration432(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_file_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), daemon_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifact_files (
    artifact_id TEXT PRIMARY KEY, context_kind TEXT NOT NULL, context_id TEXT NOT NULL,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL, receipt TEXT NOT NULL CHECK (json_valid(receipt)),
    producer_ref TEXT NOT NULL CHECK (json_valid(producer_ref)),
    source_path TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(context_kind, context_id, request_id)
  );
  CREATE TRIGGER IF NOT EXISTS immutable_artifact_file_update BEFORE UPDATE ON artifact_files
    BEGIN SELECT RAISE(ABORT, 'immutable_artifact_file'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_artifact_file_delete BEFORE DELETE ON artifact_files
    BEGIN SELECT RAISE(ABORT, 'immutable_artifact_file'); END`);
}
