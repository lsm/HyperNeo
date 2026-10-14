import type { Database } from '../sqlite-compat.ts';

export function runMigration365(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_cross_project_dispatches (
    id TEXT PRIMARY KEY,
    root_session_id TEXT NOT NULL,
    origin_message_id TEXT NOT NULL,
    ask_session_id TEXT NOT NULL,
    ask_message_id TEXT NOT NULL,
    parts_json TEXT NOT NULL,
    publication_id TEXT,
    UNIQUE(ask_session_id, ask_message_id)
  );
  CREATE TABLE IF NOT EXISTS neo_cross_project_dispatch_members (
    group_id TEXT NOT NULL REFERENCES neo_cross_project_dispatches(id),
    receipt_id TEXT NOT NULL UNIQUE REFERENCES neo_consultation_waiters(id),
    project_id TEXT NOT NULL REFERENCES neo_concerns(id),
    PRIMARY KEY(group_id, project_id)
  )`);
}
