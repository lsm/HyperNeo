import type { Database } from '../sqlite-compat.ts';

export function runMigration245(db: Database): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_long_horizon_agent_reminders'"
      )
      .get()
  )
    return;
  db.exec(`CREATE INDEX IF NOT EXISTS idx_space_lh_agent_reminders_space_active
    ON space_long_horizon_agent_reminders(space_id, agent_id) WHERE status = 'active'`);
}
