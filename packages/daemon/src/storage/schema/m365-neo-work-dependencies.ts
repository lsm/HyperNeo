import type { Database } from '../sqlite-compat.ts';

export function runMigration365(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'neo_work'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_dependencies (
    work_id TEXT NOT NULL REFERENCES neo_work(id),
    prerequisite_id TEXT NOT NULL REFERENCES neo_work(id),
    PRIMARY KEY (work_id, prerequisite_id),
    CHECK (work_id != prerequisite_id)
  )`);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_neo_work_dependents ON neo_work_dependencies(prerequisite_id, work_id)'
  );
}
