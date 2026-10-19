import type { Database } from '../sqlite-compat.ts';

export function runMigration401(db: Database): void {
  db.exec('DROP TABLE IF EXISTS neo_card_pr_relays');
}
