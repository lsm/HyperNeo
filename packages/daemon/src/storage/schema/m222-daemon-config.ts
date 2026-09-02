import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration222(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}
