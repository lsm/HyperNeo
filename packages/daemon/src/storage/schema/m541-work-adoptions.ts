import type { Database } from '../sqlite-compat.ts';

const RECORD_ADOPTION = `INSERT INTO work_adoptions (todo_id, adapter, id, daemon, at)
  VALUES (NEW.todo_id, json_extract(NEW.target, '$.ref.adapter'),
    json_extract(NEW.target, '$.ref.id'), json_extract(NEW.target, '$.ref.daemon'),
    COALESCE(json_extract(NEW.target, '$.boundAt'),
      CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)));`;

export function runMigration541(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_adoptions (
    todo_id TEXT NOT NULL,
    adapter TEXT NOT NULL,
    id TEXT NOT NULL,
    daemon TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_adoptions_worker ON work_adoptions(adapter, id);
  CREATE TRIGGER IF NOT EXISTS work_adoptions_on_insert AFTER INSERT ON neo_todo_sessions
    WHEN json_extract(NEW.target, '$.verb') = 'adopt'
    BEGIN ${RECORD_ADOPTION} END;
  CREATE TRIGGER IF NOT EXISTS work_adoptions_on_update AFTER UPDATE OF target ON neo_todo_sessions
    WHEN json_extract(NEW.target, '$.verb') = 'adopt' AND NEW.target IS NOT OLD.target
    BEGIN ${RECORD_ADOPTION} END;
  CREATE INDEX IF NOT EXISTS idx_work_delivery_inputs_target_ref
    ON work_delivery_inputs(json_extract(target, '$.ref.adapter'),
      json_extract(target, '$.ref.id'), json_extract(target, '$.ref.daemon'), accepted_at)`);
}
