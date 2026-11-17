import { NEO_TODO_FAILURE_NEXT } from '../../lib/neo/todo-state.ts';
import type { Database } from '../sqlite-compat.ts';

export function runMigration523(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_todos'").get()) return;
  db.prepare(
    `UPDATE neo_todos SET state = 'blocked', blocked_by = 'failure',
       blocked_reason = COALESCE(NULLIF(reason, ''), 'Failed.'), next_action = ?
     WHERE state = 'failed'
       AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`
  ).run(NEO_TODO_FAILURE_NEXT);
  db.exec(`UPDATE neo_todos SET state = 'removed', reason = COALESCE(NULLIF(reason, ''), 'Failed.')
    WHERE state = 'failed'`);
}
