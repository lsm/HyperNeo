import type { Database as BunDatabase } from './sqlite-compat.ts';

export interface StartedWork {
  adapter: string;
  id: string;
}

export function recordStartedWork(
  db: BunDatabase,
  ref: StartedWork,
  at = Date.now(),
  unusable = false
): void {
  db.prepare(
    `INSERT INTO work_started_sessions (adapter, id, started_at, unusable_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (adapter, id) DO UPDATE SET unusable_at = COALESCE(excluded.unusable_at, unusable_at)`
  ).run(ref.adapter, ref.id, at, unusable ? at : null);
}

export function markWorkUnusable(db: BunDatabase, ref: StartedWork): void {
  recordStartedWork(db, ref, Date.now(), true);
}

const UNUSABLE_FOR_MS = 60 * 60_000;

export function readStartedWork(db: BunDatabase, freeOn: string | null = null): StartedWork[] {
  return db
    .prepare(
      `SELECT worker.adapter, worker.id FROM (
         SELECT adapter, id FROM work_started_sessions
         UNION SELECT json_extract(ref, '$.adapter'), json_extract(ref, '$.id') FROM neo_todo_sessions
         WHERE ref IS NOT NULL AND json_extract(ref, '$.daemon') IS NULL
       ) worker
       WHERE ?1 IS NULL OR (worker.adapter = ?1
         AND NOT EXISTS (SELECT 1 FROM work_started_sessions marked
           WHERE marked.adapter = worker.adapter AND marked.id = worker.id
             AND marked.unusable_at > ?2)
         AND NOT EXISTS (SELECT 1 FROM neo_todo_sessions bound
           JOIN neo_todos todo ON todo.id = bound.todo_id
           JOIN neo_asks ask ON ask.id = todo.ask_id
           WHERE json_extract(bound.ref, '$.adapter') = worker.adapter
             AND json_extract(bound.ref, '$.id') = worker.id
             AND ask.status = 'open'
             AND todo.state NOT IN ('done', 'closed_unverified', 'failed', 'removed')))`
    )
    .all(freeOn, Date.now() - UNUSABLE_FOR_MS) as StartedWork[];
}

export function readFreeWorkers(db: BunDatabase, adapter: string): Set<string> {
  return new Set(readStartedWork(db, adapter).map((worker) => worker.id));
}
