import type { Database } from '../sqlite-compat.ts';

export function runMigration286(db: Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work' AND type = 'table'").get())
    return;
  db.exec(`CREATE TABLE IF NOT EXISTS neo_agent_work_targets (
    work_id TEXT PRIMARY KEY REFERENCES neo_work(id),
    space_id TEXT NOT NULL CHECK (length(trim(space_id)) > 0),
    agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
    session_id TEXT NOT NULL CHECK (length(trim(session_id)) > 0)
  )`);
}
