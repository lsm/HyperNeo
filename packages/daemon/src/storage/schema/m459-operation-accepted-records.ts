import type { Database } from '../sqlite-compat.ts';

export function runMigration459(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(operation_refusals)').all() as { name: string }[];
  if (columns.length && !columns.some((column) => column.name === 'accepted'))
    db.exec(
      'ALTER TABLE operation_refusals ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1))'
    );
}
