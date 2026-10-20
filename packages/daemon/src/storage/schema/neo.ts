import { runMigration415 } from './m415-neo-home-path.ts';
import { runMigration370 } from './m370-neo-project-merges.ts';
import { runMigration368 } from './m368-neo-project-tree.ts';
import type { Database } from '../sqlite-compat.ts';
import { createNeoPublicationTable } from './m288-neo-publications.ts';
import { runMigration389 } from './m389-neo-conversation.ts';

export function createNeoContextTables(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_concerns (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    context TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS neo_session_bindings (
    session_id TEXT PRIMARY KEY,
    concern_id TEXT REFERENCES neo_concerns(id),
    kind TEXT NOT NULL CHECK (kind IN ('neo', 'project', 'worker')),
    CHECK (kind = 'worker' OR (kind = 'neo' AND concern_id IS NULL)
      OR (kind = 'project' AND concern_id IS NOT NULL))
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_neo_session_bindings_coordinator
    ON neo_session_bindings(COALESCE(concern_id, '')) WHERE kind IN ('neo', 'project')`);
}

export function createNeoTables(db: Database): void {
  createNeoContextTables(db);
  runMigration389(db);
  runMigration368(db);
  runMigration415(db);
  runMigration370(db);
  createNeoPublicationTable(db);
}
