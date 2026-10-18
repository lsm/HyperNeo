import type { Database } from '../sqlite-compat.ts';

export function runMigration391(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_todos' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_todo_pr_refs (
    reference TEXT NOT NULL,
    number INTEGER NOT NULL,
    todo_id TEXT NOT NULL REFERENCES neo_todos(id) ON DELETE CASCADE,
    PRIMARY KEY (reference, todo_id)
  );
  CREATE INDEX IF NOT EXISTS idx_neo_todo_pr_refs_number ON neo_todo_pr_refs(number)`);
}
