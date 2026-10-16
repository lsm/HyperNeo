import type { Database } from '../sqlite-compat.ts';
import { runMigration283 } from './m283-neo-work-origins.ts';

export function runMigration385(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_work)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'started_at')) return;
  runMigration283(db);
  db.exec('ALTER TABLE neo_work ADD COLUMN started_at INTEGER');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_items'").get()) return;
  db.exec(`UPDATE neo_ask_items SET state = 'pending', met_by = NULL, evidence = NULL,
    verified_definition_hash = NULL WHERE check_kind = 'coding.pr_merged' AND state = 'met'
    AND ask_id IN (SELECT id FROM neo_asks WHERE status IN ('open', 'waiting', 'blocked'))`);
}
