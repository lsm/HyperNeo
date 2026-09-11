import type { Database } from '../sqlite-compat.ts';

export function runMigration255(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(space_tasks)').all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === 'lifecycle_generation'))
    db.exec('ALTER TABLE space_tasks ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TRIGGER IF NOT EXISTS increment_task_lifecycle_generation
    AFTER UPDATE OF status, task_agent_session_id, workflow_run_id ON space_tasks
    WHEN OLD.status IS NOT NEW.status OR OLD.task_agent_session_id IS NOT NEW.task_agent_session_id
      OR OLD.workflow_run_id IS NOT NEW.workflow_run_id
    BEGIN
      UPDATE space_tasks SET lifecycle_generation = OLD.lifecycle_generation + 1 WHERE id = NEW.id;
    END;`);
}
