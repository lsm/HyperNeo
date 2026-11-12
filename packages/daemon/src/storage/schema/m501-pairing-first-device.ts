import type { Database } from '../sqlite-compat.ts';

export function backfillFirstDeviceCodes(db: Database): void {
  db.exec(`
    UPDATE pairing_codes SET first_device = 1
    WHERE kind = 'human' AND used_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM paired_devices WHERE kind = 'human'
        AND id NOT LIKE 'local-rpc:%' AND id NOT LIKE 'agent-read:%')
  `);
}

export function runMigration501(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(pairing_requests)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'first_device'))
    db.exec('ALTER TABLE pairing_requests ADD COLUMN first_device INTEGER NOT NULL DEFAULT 0');
  const codeColumns = db.prepare('PRAGMA table_info(pairing_codes)').all() as { name: string }[];
  const added = !codeColumns.some((column) => column.name === 'first_device');
  if (added) {
    db.exec('ALTER TABLE pairing_codes ADD COLUMN first_device INTEGER NOT NULL DEFAULT 0');
    backfillFirstDeviceCodes(db);
  }
}
