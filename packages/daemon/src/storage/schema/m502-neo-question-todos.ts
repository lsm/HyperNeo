import type { Database } from '../sqlite-compat.ts';

export function runMigration502(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'todos')) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE neo_questions ADD COLUMN todos TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(todos));
      UPDATE neo_questions SET todos = start_todos WHERE kind = 'start' AND start_todos IS NOT NULL;
      UPDATE neo_questions SET todos = json_array(todo_id) WHERE kind != 'start' AND todo_id IS NOT NULL;
      UPDATE neo_questions SET todos = (
        SELECT json_group_array(t.id) FROM neo_todos t
        WHERE (t.ask_id = neo_questions.ask_id OR t.ask_id IN (
          SELECT id FROM neo_asks WHERE parent_id = neo_questions.ask_id
        )) AND (
          (t.state = 'blocked' AND (t.started_at IS NULL OR t.blocked_by = 'question'))
          OR (t.state = 'todo' AND t.started_at IS NULL)
        )
      ) WHERE kind != 'start' AND todo_id IS NULL AND state = 'open';
    `);
  })();
}
