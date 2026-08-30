import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration221(db: BunDatabase): void {
  db.exec(`DROP INDEX IF EXISTS uq_message_delivery_active_turn`);
}
