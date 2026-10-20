import type { Database } from '../sqlite-compat.ts';

export function runMigration425(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS message_send_receipts (
    key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    receipt TEXT NOT NULL
  )`);
}
