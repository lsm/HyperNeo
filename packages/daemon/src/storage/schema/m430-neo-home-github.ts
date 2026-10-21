import type { Database } from '../sqlite-compat.ts';

export function runMigration430(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_home_github (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    question_id TEXT UNIQUE REFERENCES neo_questions(id),
    repository TEXT,
    question_text TEXT,
    state TEXT NOT NULL CHECK (state IN ('local', 'proposed', 'creating', 'created'))
  )`);
}
