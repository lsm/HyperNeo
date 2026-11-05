import type { Database } from '../sqlite-compat.ts';

export function runMigration476(db: Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'neo_todos'").get();
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[];
  if (columns.some((column) => column.name === 'approved_at')) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE neo_todos ADD COLUMN approved_at INTEGER;
      UPDATE neo_todos SET approved_at = COALESCE(started_at, finished_at, updated_at)
        WHERE started_at IS NOT NULL OR state IN ('done', 'closed_unverified');
      UPDATE neo_todos SET approved_at = updated_at
        WHERE approved_at IS NULL
          AND (state = 'todo' OR (blocked_by = 'held' AND blocked_reason NOT IN
            ('Not ticked in the start answer.', 'Start question withdrawn.')))
          AND (EXISTS (SELECT 1 FROM neo_todos other WHERE other.ask_id = neo_todos.ask_id
                AND (other.started_at IS NOT NULL OR other.state IN ('done', 'closed_unverified')))
            OR EXISTS (SELECT 1 FROM neo_questions q WHERE q.ask_id = neo_todos.ask_id
                AND q.kind = 'start' AND q.state = 'answered'))
          AND NOT EXISTS (SELECT 1 FROM neo_questions q, json_each(q.start_todos) listed
            WHERE q.ask_id = neo_todos.ask_id AND q.kind = 'start' AND q.state = 'open'
              AND listed.value = neo_todos.id);
    `);
  })();
}
