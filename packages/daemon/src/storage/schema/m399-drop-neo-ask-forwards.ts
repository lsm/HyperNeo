import type { Database } from '../sqlite-compat.ts';

export function runMigration399(db: Database): void {
  db.exec('DROP TABLE IF EXISTS neo_ask_forwards');
}
