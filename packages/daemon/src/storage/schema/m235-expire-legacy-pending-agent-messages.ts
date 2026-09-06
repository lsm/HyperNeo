import type { Database as BunDatabase } from '../sqlite-compat.ts';

function tableExists(db: BunDatabase, tableName: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
}

export function runMigration235(db: BunDatabase): void {
  if (!tableExists(db, 'pending_agent_messages')) return;
  db.exec(
    `UPDATE pending_agent_messages
        SET status = 'expired',
            last_error = 'dropped at deploy: pending_agent_messages queue removed (W3c)',
            last_attempt_at = strftime('%s', 'now') * 1000
      WHERE status = 'pending'`
  );
}
