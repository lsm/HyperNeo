import type { Database as BunDatabase } from './sqlite-compat.ts';

export interface StartedWork {
  adapter: string;
  id: string;
}

export function recordStartedWork(db: BunDatabase, ref: StartedWork, at = Date.now()): void {
  db.prepare(
    'INSERT OR IGNORE INTO work_started_sessions (adapter, id, started_at) VALUES (?, ?, ?)'
  ).run(ref.adapter, ref.id, at);
}

export function readStartedWork(db: BunDatabase): StartedWork[] {
  return db
    .prepare(
      `SELECT adapter, id FROM work_started_sessions
       UNION SELECT json_extract(ref, '$.adapter'), json_extract(ref, '$.id') FROM neo_todo_sessions
       WHERE ref IS NOT NULL AND json_extract(ref, '$.daemon') IS NULL`
    )
    .all() as StartedWork[];
}
