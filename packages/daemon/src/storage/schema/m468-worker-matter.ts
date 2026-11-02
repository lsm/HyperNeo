import type { Database } from '../sqlite-compat.ts';

export function runMigration468(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_started_sessions)').all() as {
    name: string;
  }[];
  if (columns.length && !columns.some((column) => column.name === 'ask_ids')) {
    db.exec("ALTER TABLE work_started_sessions ADD COLUMN ask_ids TEXT NOT NULL DEFAULT '[]'");
    db.exec(`INSERT INTO work_started_sessions(adapter,id,started_at,ask_ids)
      SELECT json_extract(bound.ref,'$.adapter'),json_extract(bound.ref,'$.id'),
        MIN(COALESCE(bound.started_at,todo.updated_at)),json_group_array(DISTINCT todo.ask_id)
      FROM neo_todo_sessions bound JOIN neo_todos todo ON todo.id=bound.todo_id
      WHERE bound.ref IS NOT NULL AND json_extract(bound.ref,'$.daemon') IS NULL
        AND json_extract(bound.ref,'$.adapter') IS NOT NULL AND json_extract(bound.ref,'$.id') IS NOT NULL
      GROUP BY json_extract(bound.ref,'$.adapter'),json_extract(bound.ref,'$.id')
      ON CONFLICT(adapter,id) DO UPDATE SET ask_ids=excluded.ask_ids`);
  }
  if (columns.length && !columns.some((column) => column.name === 'reusable')) {
    db.exec('ALTER TABLE work_started_sessions ADD COLUMN reusable INTEGER NOT NULL DEFAULT 1');
    db.exec(`UPDATE work_started_sessions AS worker SET reusable=0 WHERE EXISTS (
      SELECT 1 FROM pack_facts WHERE pack='coding' AND key LIKE 'assignment:%'
        AND json_extract(value_json,'$.ref.adapter')=worker.adapter
        AND json_extract(value_json,'$.ref.id')=worker.id
        AND json_extract(value_json,'$.ref.daemon') IS NULL)`);
  }
}
