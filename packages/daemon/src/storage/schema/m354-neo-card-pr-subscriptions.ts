import type { Database } from '../sqlite-compat.ts';

export function runMigration354(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_card_pr_subscriptions (
    work_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    PRIMARY KEY (work_id, topic)
  )`);
}
