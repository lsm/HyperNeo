import { runMigration370 } from './m370-neo-project-merges.ts';
import { runMigration368 } from './m368-neo-project-tree.ts';
import type { Database } from '../sqlite-compat.ts';
import { createNeoPublicationTable } from './m288-neo-publications.ts';
import { createNeoConsultationPublicationTable } from './m291-neo-consultation-publications.ts';
import { runMigration380 } from './m380-neo-work-follows.ts';
import { runMigration385 } from './m385-neo-work-kickoff.ts';
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
  db.exec(`CREATE TABLE IF NOT EXISTS neo_work (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    concern_id TEXT REFERENCES neo_concerns(id),
    origin_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    instruction TEXT NOT NULL,
    target_session_id TEXT,
    session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'queued', 'reported', 'failed', 'cancelled')),
    report TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  runMigration380(db);
  runMigration385(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_work_concern ON neo_work(concern_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_work_session
    ON neo_work(session_id, created_at) WHERE session_id IS NOT NULL`);
}

export function createNeoTables(db: Database): void {
  createNeoContextTables(db);
  runMigration389(db);
  runMigration368(db);
  runMigration370(db);
  createNeoPublicationTable(db);
  createNeoConsultationPublicationTable(db);
}
