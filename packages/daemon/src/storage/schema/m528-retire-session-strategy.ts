import type { Database } from '../sqlite-compat.ts';

export function runMigration528(db: Database): void {
  db.exec("DELETE FROM neo_pack_preferences WHERE pack = 'coding' AND key = 'sessionStrategy'");
}
