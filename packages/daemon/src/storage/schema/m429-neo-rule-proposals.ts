import type { Database } from '../sqlite-compat.ts';

export function runMigration429(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_rule_proposals (
    question_id TEXT PRIMARY KEY REFERENCES neo_questions(id),
    request_id TEXT NOT NULL UNIQUE,
    edit_json TEXT NOT NULL CHECK (json_valid(edit_json)),
    question_text TEXT NOT NULL,
    applied_at INTEGER
  );
  CREATE TRIGGER IF NOT EXISTS immutable_rule_proposal
    BEFORE UPDATE OF question_id, request_id, edit_json, question_text ON neo_rule_proposals
    BEGIN SELECT RAISE(ABORT, 'immutable_rule_proposal'); END`);
}
