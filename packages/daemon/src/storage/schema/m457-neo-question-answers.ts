import type { Database } from '../sqlite-compat.ts';

export function runMigration457(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[];
  if (!columns.length) return;
  if (!columns.some((c) => c.name === 'worker_answers_json'))
    db.exec(
      'ALTER TABLE neo_questions ADD COLUMN worker_answers_json TEXT CHECK (worker_answers_json IS NULL OR json_valid(worker_answers_json))'
    );
  if (!columns.some((c) => c.name === 'source_session_json')) return;
  db.exec(`UPDATE neo_questions SET worker_answers_json = json_array(json_object(
    'id', id || ':' || todo_id, 'todoId', todo_id, 'sourceSession', json(source_session_json),
    'receipt', NULL, 'acceptedAt', NULL))
    WHERE worker_answers_json IS NULL AND source_session_json IS NOT NULL
      AND state IN ('open', 'answered')
      AND todo_id IN (SELECT id FROM neo_todos WHERE blocked_by = 'needs-human')`);
}
