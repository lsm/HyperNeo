import type { Database } from '../sqlite-compat.ts';

export function runMigration388(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_desktop_bridge_instances (
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
      retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0, 1)),
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, instance_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_desktop_bridge_active
      ON claude_desktop_bridge_instances(session_id) WHERE retired = 0;
    CREATE TABLE IF NOT EXISTS claude_desktop_bridge_events (
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, instance_id, sequence),
      FOREIGN KEY(session_id, instance_id)
        REFERENCES claude_desktop_bridge_instances(session_id, instance_id) ON DELETE CASCADE
    );
  `);
}
