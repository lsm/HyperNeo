import type { Database } from '../sqlite-compat.ts';

export function runMigration487(db: Database): void {
  db.exec('ALTER TABLE pairing_codes ADD COLUMN requested_by TEXT');
}
