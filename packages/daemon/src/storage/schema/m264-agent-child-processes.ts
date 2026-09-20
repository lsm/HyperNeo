import type { Database } from '../sqlite-compat.ts';

export function runMigration264(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_child_processes (
      pid INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      daemon_pid INTEGER NOT NULL
    );
  `);
}
