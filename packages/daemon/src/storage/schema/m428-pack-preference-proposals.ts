import type { Database } from '../sqlite-compat.ts';

export function runMigration428(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_pack_preference_proposals (
    question_id TEXT PRIMARY KEY REFERENCES neo_questions(id),
    request_id TEXT NOT NULL UNIQUE,
    values_json TEXT NOT NULL CHECK (json_valid(values_json)),
    question_text TEXT NOT NULL,
    applied_at INTEGER
  );
  CREATE TRIGGER IF NOT EXISTS immutable_pack_preference_proposal
    BEFORE UPDATE OF question_id, request_id, values_json, question_text ON neo_pack_preference_proposals
    BEGIN SELECT RAISE(ABORT, 'immutable_preference_proposal'); END`);
}
