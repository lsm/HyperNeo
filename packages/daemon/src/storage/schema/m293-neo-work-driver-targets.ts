import type { Database } from '../sqlite-compat.ts';

export function runMigration293(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_driver_targets (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id),
    target TEXT NOT NULL CHECK (json_valid(target)),
    ref TEXT CHECK (ref IS NULL OR json_valid(ref))
  )`);
}
