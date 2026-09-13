import type { Database } from '../sqlite-compat.ts';

export function runMigration261(db: Database): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_tasks'").get()
  )
    return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_tasks_owner_updated
    ON space_tasks(space_id, updated_at DESC, id DESC) WHERE status != 'archived'`);
}
