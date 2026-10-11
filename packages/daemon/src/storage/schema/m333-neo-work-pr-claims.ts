import type { Database } from '../sqlite-compat.ts';

export function runMigration333(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work_pr_claims (
    work_id TEXT NOT NULL REFERENCES neo_work(id) ON DELETE CASCADE,
    url_key TEXT NOT NULL,
    claim TEXT NOT NULL CHECK (claim IN ('branch', 'named', 'mentioned', 'rejected')),
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (work_id, url_key)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_neo_work_pr_claims_url ON neo_work_pr_claims(url_key)');
}
