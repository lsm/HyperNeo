import type { Database } from '../sqlite-compat.ts';

export function runMigration438(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS voice_recordings (
    owner TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    audio_sha256 TEXT NOT NULL,
    outcome_json TEXT,
    dispatched_at INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (owner, recording_id)
  )`);
}
