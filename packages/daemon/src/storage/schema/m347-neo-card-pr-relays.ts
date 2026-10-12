import type { Database } from '../sqlite-compat.ts';

export function runMigration347(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_card_pr_relays (
    work_id TEXT PRIMARY KEY,
    signature TEXT NOT NULL,
    told_at INTEGER NOT NULL
  )`);
}
