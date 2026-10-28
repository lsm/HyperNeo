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

export function markWorkUnusable(db: BunDatabase, ref: StartedWork, at = Date.now()): void {
  db.prepare(
    `INSERT INTO work_started_sessions (adapter, id, started_at, unusable_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (adapter, id) DO UPDATE SET unusable_at = excluded.unusable_at`
  ).run(ref.adapter, ref.id, at, at);
}

export function readFreeWorkers(db: BunDatabase, adapter: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT worker.id FROM (
         SELECT adapter, id FROM work_started_sessions
         UNION SELECT json_extract(ref, '$.adapter'), json_extract(ref, '$.id') FROM neo_todo_sessions
         WHERE ref IS NOT NULL AND json_extract(ref, '$.daemon') IS NULL
       ) worker
       WHERE worker.adapter = ?
         AND NOT EXISTS (SELECT 1 FROM work_started_sessions marked
           WHERE marked.adapter = worker.adapter AND marked.id = worker.id
             AND marked.unusable_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM neo_todo_sessions bound
           JOIN neo_todos todo ON todo.id = bound.todo_id
           JOIN neo_asks ask ON ask.id = todo.ask_id
           WHERE json_extract(bound.ref, '$.adapter') = worker.adapter
             AND json_extract(bound.ref, '$.id') = worker.id
             AND ask.status = 'open'
             AND todo.state NOT IN ('done', 'closed_unverified', 'failed', 'removed'))`
    )
    .all(adapter) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}
