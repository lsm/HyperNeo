import type { Database } from '../sqlite-compat.ts';

export function runMigration483(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(neo_todos)').all() as { name: string }[];
  if (!columns.length || columns.some((column) => column.name === 'approval_question_id')) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE neo_todos ADD COLUMN approval_question_id TEXT REFERENCES neo_questions(id);
      UPDATE neo_todos SET approval_question_id = (
        SELECT q.id FROM neo_questions q
        WHERE q.kind = 'start' AND q.state = 'answered' AND q.answered_by IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(q.start_todos) WHERE value = neo_todos.id)
          AND EXISTS (SELECT 1 FROM json_each(q.answer) WHERE value = neo_todos.id)
        ORDER BY q.answered_at DESC, q.id DESC LIMIT 1
      );
    `);
  })();
}
