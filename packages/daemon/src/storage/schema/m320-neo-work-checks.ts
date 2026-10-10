import type { Database } from '../sqlite-compat.ts';

const hasTable = (db: Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name);

export function runMigration320(db: Database): void {
  if (!hasTable(db, 'neo_work')) return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_checks (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id) ON DELETE CASCADE,
    signature TEXT NOT NULL,
    told_at INTEGER,
    reminded TEXT
  )`);
  if (hasTable(db, 'neo_work_prs'))
    db.exec(`INSERT OR IGNORE INTO neo_work_checks(work_id, signature, told_at, reminded)
      SELECT work_id, delivered, delivered_at, reminded FROM neo_work_prs WHERE delivered IS NOT NULL`);
}
