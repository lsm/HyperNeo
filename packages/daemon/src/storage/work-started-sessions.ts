import type { Database as BunDatabase } from './sqlite-compat.ts';
import type { WorkerReuseFacts } from '../lib/drivers/worker-reuse.ts';

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

export function claimStartedWork(
  db: BunDatabase,
  ref: StartedWork,
  todoId?: string
): (() => void) | null {
  const claim = () => {
    if (
      db
        .prepare(
          'SELECT 1 FROM work_started_sessions WHERE adapter = ? AND id = ? AND released_at IS NOT NULL'
        )
        .get(ref.adapter, ref.id)
    )
      return null;
    if (!todoId)
      return db
        .prepare(
          `SELECT 1 FROM neo_todo_sessions WHERE json_extract(ref, '$.adapter') = ?
             AND json_extract(ref, '$.id') = ? AND json_extract(ref, '$.daemon') IS NULL`
        )
        .get(ref.adapter, ref.id)
        ? null
        : () => {};
    const previous =
      (
        db.prepare('SELECT ref FROM neo_todo_sessions WHERE todo_id = ?').get(todoId) as
          | { ref: string | null }
          | undefined
      )?.ref ?? null;
    const claimed = JSON.stringify({ adapter: ref.adapter, id: ref.id });
    const bound = db
      .prepare(
        `UPDATE neo_todo_sessions SET ref = ?1 WHERE todo_id = ?2 AND EXISTS (SELECT 1 FROM neo_todos
           WHERE id = ?2 AND state IN ('todo', 'doing', 'blocked', 'failed'))`
      )
      .run(claimed, todoId);
    if (!bound.changes) return null;
    return () =>
      void db
        .prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ? AND ref = ?')
        .run(previous, todoId, claimed);
  };
  return db.transaction(claim, 'immediate')();
}

export function readStartedWork(
  db: BunDatabase,
  freeOn: string | null = null,
  reuse?: { todoId?: string; sessionId?: string }
): (StartedWork & Partial<WorkerReuseFacts>)[] {
  const history = reuse
    ? `WITH uses AS (
         SELECT json_extract(bound.ref, '$.adapter') AS adapter,
                json_extract(bound.ref, '$.id') AS id, todo.ask_id AS askId,
                MAX(todo.created_at,
                    COALESCE(todo.started_at, bound.started_at, todo.created_at)) AS usedAt,
                CASE WHEN ask.status != 'open' THEN ask.settled_at END AS settledAt
         FROM neo_todo_sessions bound JOIN neo_todos todo ON todo.id = bound.todo_id
         JOIN neo_asks ask ON ask.id = todo.ask_id
         WHERE bound.ref IS NOT NULL AND json_extract(bound.ref, '$.daemon') IS NULL
       ), request AS (
         SELECT todo.ask_id FROM neo_todos todo JOIN neo_asks ask ON ask.id = todo.ask_id
         WHERE todo.id = ?3 AND ask.session_id = ?4 AND ask.status = 'open'
       )`
    : '';
  const ranks = reuse
    ? `, (
           SELECT MAX(usedAt) FROM uses, request
           WHERE uses.adapter = worker.adapter AND uses.id = worker.id
             AND uses.askId = request.ask_id
         ) AS sameAskAt, (
           SELECT settledAt FROM uses WHERE uses.adapter = worker.adapter AND uses.id = worker.id
           ORDER BY usedAt DESC, askId DESC LIMIT 1
         ) AS settledAt`
    : '';
  return db
    .prepare(
      `${history} SELECT worker.adapter, worker.id${ranks}
       FROM (
         SELECT adapter, id FROM work_started_sessions
         UNION SELECT json_extract(ref, '$.adapter'), json_extract(ref, '$.id') FROM neo_todo_sessions
         WHERE ref IS NOT NULL AND json_extract(ref, '$.daemon') IS NULL
       ) worker
       WHERE ?1 IS NULL OR (worker.adapter = ?1
         AND NOT EXISTS (SELECT 1 FROM work_started_sessions marked
           WHERE marked.adapter = worker.adapter AND marked.id = worker.id
             AND (marked.unusable_at > ?2 OR marked.released_at IS NOT NULL))
         AND NOT EXISTS (SELECT 1 FROM neo_todo_sessions bound
           JOIN neo_todos todo ON todo.id = bound.todo_id
           JOIN neo_asks ask ON ask.id = todo.ask_id
           WHERE json_extract(bound.ref, '$.adapter') = worker.adapter
             AND json_extract(bound.ref, '$.id') = worker.id
             AND ask.status = 'open'
             AND todo.state NOT IN ('done', 'failed', 'removed')))`
    )
    .all(
      freeOn,
      Date.now() - UNUSABLE_FOR_MS,
      ...(reuse ? [reuse.todoId ?? null, reuse.sessionId ?? null] : [])
    ) as (StartedWork & Partial<WorkerReuseFacts>)[];
}

export function readFreeWorkers(db: BunDatabase, adapter: string): Set<string> {
  return new Set(readStartedWork(db, adapter).map((worker) => worker.id));
}

export function readReusableWorkers(
  db: BunDatabase,
  adapter: string,
  todoId?: string,
  sessionId?: string
): ReadonlyMap<string, WorkerReuseFacts> {
  return new Map(
    readStartedWork(db, adapter, { todoId, sessionId }).map((worker) => [
      worker.id,
      { sameAskAt: worker.sameAskAt ?? null, settledAt: worker.settledAt ?? null },
    ])
  );
}
