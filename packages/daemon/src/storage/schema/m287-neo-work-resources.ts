import type { Database } from '../sqlite-compat.ts';

export function createNeoWorkResourceTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_resources (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
    refs_json TEXT NOT NULL
  )`);
}

export function runMigration287(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  createNeoWorkResourceTable(db);
}
