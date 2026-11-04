import type { Database } from '../sqlite-compat.ts';

export function runMigration475(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(work_delivery_inputs)').all() as {
    name: string;
    notnull: number;
  }[];
  if (!columns.find((column) => column.name === 'todo_id')?.notnull) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE work_delivery_inputs_next (
      id TEXT PRIMARY KEY,
      todo_id TEXT,
      origin_session_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK (json_valid(target)),
      message TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL CHECK (deadline_at > accepted_at),
      outcome TEXT CHECK (outcome IS NULL OR json_valid(outcome)),
      observed_at INTEGER
    );
    INSERT INTO work_delivery_inputs_next SELECT * FROM work_delivery_inputs;
    DROP TABLE work_delivery_inputs;
    ALTER TABLE work_delivery_inputs_next RENAME TO work_delivery_inputs;
    CREATE INDEX idx_work_delivery_inputs_todo ON work_delivery_inputs(todo_id, accepted_at);
    CREATE INDEX idx_work_delivery_inputs_deadline ON work_delivery_inputs(deadline_at, id);
    CREATE INDEX idx_work_delivery_inputs_ref ON work_delivery_inputs(
      json_extract(outcome, '$.ref.adapter'), json_extract(outcome, '$.ref.id'),
      json_extract(outcome, '$.ref.daemon'), accepted_at);`);
  })();
}
