import type { Database } from '../sqlite-compat.ts';

export function runMigration422(db: Database): void {
  for (const [table, predicate] of [
    ['tool_continuation_recovery', "status IN ('active', 'waiting_rebind')"],
    ['tool_continuation_inbox', "status = 'pending'"],
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
      continue;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_expiry
      ON ${table}(status, expires_at) WHERE ${predicate}`);
  }
}
