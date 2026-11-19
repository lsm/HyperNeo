import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { WorkerReuseFacts } from '../../lib/drivers/worker-reuse.ts';
import { workerWorkKey } from '../../lib/work-locations.ts';

export interface StartedWork {
  adapter: string;
  id: string;
}

export interface StartedWorkFacts extends StartedWork {
  releasedAt: number | null;
  claimedBy: string | null;
}

export function recordStartedWork(
  db: BunDatabase,
  ref: StartedWork,
  at = Date.now(),
  unusable = false,
  released = false,
  claim?: { todoId: string | null },
  role: 'worker' | null = null
): void {
  db.prepare(
    `INSERT INTO work_started_sessions
       (adapter, id, started_at, unusable_at, released_at, claimed_by, role)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8) ON CONFLICT (adapter, id) DO UPDATE SET
       unusable_at = COALESCE(excluded.unusable_at, unusable_at),
       released_at = COALESCE(released_at, excluded.released_at),
       claimed_by = CASE WHEN ?7 THEN excluded.claimed_by ELSE claimed_by END,
       role = COALESCE(excluded.role, role)`
  ).run(
    ref.adapter,
    ref.id,
    at,
    unusable ? at : null,
    released ? at : null,
    claim?.todoId ?? null,
    Number(!!claim),
    role
  );
}

export function recordWorkerStarted(db: BunDatabase, ref: StartedWork): void {
  recordStartedWork(db, ref, Date.now(), false, false, undefined, 'worker');
}

export function forgetWorkGone(db: BunDatabase, root: string): void {
  db.run('DELETE FROM work_cleanup_gone WHERE key = ?', workerWorkKey(root));
}

export function markWorkUnusable(db: BunDatabase, ref: StartedWork): void {
  recordStartedWork(db, ref, Date.now(), true);
}

const UNUSABLE_FOR_MS = 60 * 60_000;

export function readStartedWork(
  db: BunDatabase,
  freeOn: string | null = null,
  reuse?: { todoId?: string; sessionId?: string },
  worker?: StartedWork
): (StartedWorkFacts & Partial<WorkerReuseFacts>)[] {
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
  const sql = `${history} SELECT worker.adapter, worker.id${ranks},
         (SELECT released_at FROM work_started_sessions own
           WHERE own.adapter = worker.adapter AND own.id = worker.id) AS releasedAt,
         (SELECT claimed_by FROM work_started_sessions own
           WHERE own.adapter = worker.adapter AND own.id = worker.id) AS claimedBy
       FROM (
         SELECT adapter, id FROM work_started_sessions
         WHERE (?1 IS NULL OR role = 'worker')
           AND (?5 IS NULL OR (adapter = ?5 AND id = ?6 AND role = 'worker'))
         UNION SELECT json_extract(ref, '$.adapter'), json_extract(ref, '$.id') FROM neo_todo_sessions
         WHERE ?1 IS NULL AND ?5 IS NULL AND ref IS NOT NULL AND json_extract(ref, '$.daemon') IS NULL
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
             AND todo.state NOT IN ('done', 'removed')))`;
  return db
    .prepare(sql)
    .all(
      freeOn,
      Date.now() - UNUSABLE_FOR_MS,
      reuse?.todoId ?? null,
      reuse?.sessionId ?? null,
      worker?.adapter ?? null,
      worker?.id ?? null
    ) as (StartedWorkFacts & Partial<WorkerReuseFacts>)[];
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

class WorkStartedSessionReads {
  constructor(private readonly db: BunDatabase) {}

  startedWork(): StartedWorkFacts[] {
    return readStartedWork(this.db);
  }

  startedByUs(ref: StartedWork): boolean {
    return readStartedWork(this.db, null, undefined, ref).length > 0;
  }

  reusableWorkers(
    adapter: string,
    todoId?: string,
    sessionId?: string
  ): [string, WorkerReuseFacts][] {
    return [...readReusableWorkers(this.db, adapter, todoId, sessionId)];
  }
}

class WorkStartedSessionWrites {
  constructor(private readonly db: BunDatabase) {}

  recordStarted(ref: StartedWork, directory?: string): void {
    recordWorkerStarted(this.db, ref);
    if (directory) forgetWorkGone(this.db, directory);
  }

  markUnusable(ref: StartedWork): void {
    markWorkUnusable(this.db, ref);
  }
}

export const workStartedSessionReads = defineRepositoryOp(
  'work.startedSessionReads',
  'read',
  WorkStartedSessionReads,
  ['startedWork', 'startedByUs', 'reusableWorkers']
);

export const workStartedSessionWrites = defineRepositoryOp(
  'work.startedSessionWrites',
  'write',
  WorkStartedSessionWrites,
  ['recordStarted', 'markUnusable']
);
