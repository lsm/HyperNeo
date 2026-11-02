import type { Database as BunDatabase } from './sqlite-compat.ts';

export interface StartedWork {
  adapter: string;
  id: string;
}

export function recordStartedWork(
  db: BunDatabase,
  ref: StartedWork,
  at = Date.now(),
  unusable = false,
  matter?: { todoId?: string; sessionId?: string; reusable?: boolean }
): void {
  db.prepare(
    `INSERT INTO work_started_sessions (adapter, id, started_at, unusable_at, ask_ids, reusable)
     VALUES (?, ?, ?, ?, (SELECT json_group_array(ask.id) FROM neo_todos todo JOIN neo_asks ask ON ask.id=todo.ask_id
       WHERE todo.id=? AND ask.session_id=? AND ask.status='open'), ?)
     ON CONFLICT (adapter, id) DO UPDATE SET
       started_at = CASE WHEN excluded.unusable_at IS NULL THEN excluded.started_at ELSE started_at END,
       unusable_at = COALESCE(excluded.unusable_at, unusable_at),
       ask_ids = (SELECT json_group_array(value) FROM (
         SELECT value FROM json_each(work_started_sessions.ask_ids)
         UNION SELECT value FROM json_each(excluded.ask_ids))),
       reusable = MIN(reusable, excluded.reusable)`
  ).run(
    ref.adapter,
    ref.id,
    at,
    unusable ? at : null,
    matter?.todoId ?? null,
    matter?.sessionId ?? null,
    matter?.reusable === false ? 0 : 1
  );
}

export function markWorkUnusable(db: BunDatabase, ref: StartedWork): void {
  recordStartedWork(db, ref, Date.now(), true);
}

const UNUSABLE_FOR_MS = 60 * 60_000;

export function readStartedWork(
  db: BunDatabase,
  freeOn: string | null = null,
  todoId: string | null = null,
  sessionId: string | null = null,
  includeUnavailable = false,
  independent = false
): StartedWork[] {
  return db
    .prepare(
      freeOn === null
        ? `SELECT adapter,id FROM work_started_sessions
           UNION SELECT json_extract(ref,'$.adapter'),json_extract(ref,'$.id') FROM neo_todo_sessions
           WHERE ref IS NOT NULL AND json_extract(ref,'$.daemon') IS NULL`
        : `WITH workers AS (
         SELECT adapter, id FROM work_started_sessions
         UNION SELECT json_extract(ref, '$.adapter'), json_extract(ref, '$.id') FROM neo_todo_sessions
         WHERE ref IS NOT NULL AND json_extract(ref, '$.daemon') IS NULL
       ), bindings AS (
         SELECT started.adapter,started.id,matter.value AS ask_id,started.started_at AS used_at
         FROM work_started_sessions started,json_each(started.ask_ids) matter
         UNION ALL SELECT json_extract(bound.ref,'$.adapter'),json_extract(bound.ref,'$.id'),
           todo.ask_id,COALESCE(bound.started_at,todo.updated_at)
         FROM neo_todo_sessions bound JOIN neo_todos todo ON todo.id=bound.todo_id
         WHERE bound.ref IS NOT NULL AND json_extract(bound.ref,'$.daemon') IS NULL
       ), requested AS (
         SELECT ask.id FROM neo_todos todo JOIN neo_asks ask ON ask.id=todo.ask_id
         WHERE todo.id=?3 AND ask.session_id=?4 AND ask.status='open'
       ), actors AS MATERIALIZED (
         SELECT json_extract(value_json,'$.ref.adapter') AS adapter,json_extract(value_json,'$.ref.id') AS id
         FROM pack_facts WHERE pack='coding' AND key LIKE 'assignment:%'
           AND json_extract(value_json,'$.ref.daemon') IS NULL
       )
       SELECT worker.adapter,worker.id FROM workers worker
       WHERE ?1 IS NULL OR (worker.adapter=?1
         AND NOT EXISTS (SELECT 1 FROM work_started_sessions marked
           WHERE marked.adapter=worker.adapter AND marked.id=worker.id
             AND ((?5=0 AND marked.unusable_at>?2) OR (?6=0 AND marked.reusable=0)))
         AND (?6=1 OR NOT EXISTS (SELECT 1 FROM actors WHERE actors.adapter=worker.adapter AND actors.id=worker.id))
         AND NOT EXISTS (SELECT 1 FROM bindings bound JOIN neo_asks ask ON ask.id=bound.ask_id
           WHERE ?5=0 AND bound.adapter=worker.adapter AND bound.id=worker.id AND ask.status='open'
             AND (?3 IS NULL OR ask.id<>(SELECT id FROM requested)))
         AND (?3 IS NULL OR EXISTS (SELECT 1 FROM bindings bound
           WHERE bound.adapter=worker.adapter AND bound.id=worker.id AND bound.ask_id=(SELECT id FROM requested))))
       ORDER BY CASE WHEN ?1 IS NOT NULL AND ?3 IS NOT NULL THEN -(SELECT MAX(used_at) FROM bindings bound
           WHERE bound.adapter=worker.adapter AND bound.id=worker.id AND bound.ask_id=(SELECT id FROM requested)) END,
         CASE WHEN ?1 IS NOT NULL AND ?3 IS NULL THEN (SELECT MAX(ask.settled_at) FROM bindings bound
           JOIN neo_asks ask ON ask.id=bound.ask_id WHERE bound.adapter=worker.adapter AND bound.id=worker.id) END,
         worker.adapter,worker.id`
    )
    .all(
      ...(freeOn === null
        ? []
        : [
            freeOn,
            Date.now() - UNUSABLE_FOR_MS,
            todoId,
            sessionId,
            includeUnavailable ? 1 : 0,
            independent ? 1 : 0,
          ])
    ) as StartedWork[];
}

export function readFreeWorkers(
  db: BunDatabase,
  adapter: string,
  independent = false
): Set<string> {
  return new Set(
    readStartedWork(db, adapter, null, null, false, independent).map((worker) => worker.id)
  );
}

export function readAskWorkers(
  db: BunDatabase,
  adapter: string,
  todoId?: string,
  sessionId?: string,
  includeUnavailable = false,
  independent = false
): Set<string> {
  return new Set(
    todoId && sessionId
      ? readStartedWork(db, adapter, todoId, sessionId, includeUnavailable, independent).map(
          (worker) => worker.id
        )
      : []
  );
}
