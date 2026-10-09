import type { Database } from '../sqlite-compat.ts';

export function runMigration315(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_devices (
    device_id TEXT PRIMARY KEY,
    apns_token TEXT NOT NULL UNIQUE,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    bundle_id TEXT NOT NULL,
    push_to_start_token TEXT,
    kinds_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS neo_live_activities (
    activity_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES neo_devices(device_id) ON DELETE CASCADE,
    push_token TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}
