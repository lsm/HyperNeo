import type { Database } from '../sqlite-compat.ts';

export function runMigration460(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_session_messages)').all() as {
    name: string;
  }[];
  if (!columns.length || columns.some((column) => column.name === 'kind')) return;
  db.exec(
    `ALTER TABLE neo_session_messages
     ADD COLUMN kind TEXT NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'worker-batch'))`
  );
  db.exec(
    `UPDATE neo_session_messages SET kind = 'worker-batch' WHERE from_session = 'system:worker-batch'`
  );
}
