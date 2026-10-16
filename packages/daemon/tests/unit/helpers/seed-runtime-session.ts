import type { Database } from '../../../src/storage/sqlite-compat.ts';

export function seedRuntimeSession(db: Database, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
     (id, title, created_at, last_active_at, status, config, metadata)
     VALUES (?, '', '', '', 'active', '{}', '{}')`
  ).run(id);
}
