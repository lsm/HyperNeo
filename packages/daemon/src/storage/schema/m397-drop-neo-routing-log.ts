import type { Database } from '../sqlite-compat.ts';

export function runMigration397(db: Database): void {
  db.exec('DROP TABLE IF EXISTS neo_routing_log');
}
