import type { Database } from '../sqlite-compat.ts';

export function runMigration440(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS human_device_resets (
    id TEXT PRIMARY KEY,
    reset_at INTEGER NOT NULL,
    devices_json TEXT NOT NULL,
    recovered_at INTEGER
  )`);
}
