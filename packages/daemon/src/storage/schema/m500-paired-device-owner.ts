import type { Database } from '../sqlite-compat.ts';

export function runMigration500(db: Database): void {
  db.exec('ALTER TABLE paired_devices ADD COLUMN owner INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE paired_devices SET owner = 1
    WHERE kind = 'human' AND revoked_at IS NULL
      AND id NOT LIKE 'local-rpc:%' AND id NOT LIKE 'agent-read:%'
  `);
}
