import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { WorkerReuseFacts } from '../../lib/drivers/worker-reuse.ts';
import { workerWorkKey } from '../../lib/work-locations.ts';
import { sdkMessageBodyAt } from './sdk-message-body-read.ts';

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
  kind: 'worker' | null = null
): void {
  db.prepare(
    `INSERT INTO work_started_sessions
       (adapter, id, started_at, unusable_at, released_at, claimed_by, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?8) ON CONFLICT (adapter, id) DO UPDATE SET
       unusable_at = COALESCE(excluded.unusable_at, unusable_at),
       released_at = COALESCE(released_at, excluded.released_at),
       claimed_by = CASE WHEN ?7 THEN excluded.claimed_by ELSE claimed_by END,
       kind = COALESCE(excluded.kind, kind)`
  ).run(
    ref.adapter,
    ref.id,
    at,
    unusable ? at : null,
    released ? at : null,
    claim?.todoId ?? null,
    Number(!!claim),
    kind
  );
}

export type WorkCompactionFailure = { count: number; attemptedAt: number; retryAt: number };

export function readWorkCompaction(db: BunDatabase, ref: StartedWork) {
  const row = db
    .prepare(
      `SELECT compacted_at AS at, (
         SELECT value_json FROM pack_facts WHERE pack = 'core' AND key = 'compaction_failure'
           AND json_extract(value_json, '$.worker.adapter') = ?1
           AND json_extract(value_json, '$.worker.id') = ?2
         ORDER BY json_extract(value_json, '$.attemptedAt') DESC, todo_id DESC LIMIT 1
       ) AS failure FROM work_started_sessions WHERE adapter = ?1 AND id = ?2`
    )
    .get(ref.adapter, ref.id) as { at: number | null; failure: string | null } | null;
  return {
    compactedAt: row?.at ?? null,
    failure: row?.failure ? (JSON.parse(row.failure) as WorkCompactionFailure) : null,
  };
}

export function recordWorkerStarted(
  db: BunDatabase,
  ref: StartedWork,
  facts?: {
    startedBy: string;
    todoId?: string;
    machine: string;
    folder?: string;
    harness: string;
    provider?: string;
    model?: string;
    effort?: string;
    preparation?: unknown;
    role?: string;
  }
): void {
  if (!facts) {
    recordStartedWork(db, ref, Date.now(), false, false, undefined, 'worker');
    return;
  }
  db.transaction(() => {
    recordStartedWork(db, ref, Date.now(), false, false, undefined, 'worker');
    db.prepare(`UPDATE work_started_sessions SET started_by = ?, todo_id = ?,
    ask_id = (SELECT ask_id FROM neo_todos WHERE id = ?), machine = ?, folder = ?, harness = ?,
    provider = ?, model = ?, effort = ?, preparation = ? WHERE adapter = ? AND id = ?`).run(
      facts.startedBy,
      facts.todoId ?? null,
      facts.todoId ?? null,
      facts.machine,
      facts.folder ?? null,
      facts.harness,
      facts.provider ?? null,
      facts.model ?? null,
      facts.effort ?? null,
      facts.preparation ? JSON.stringify(facts.preparation) : null,
      ref.adapter,
      ref.id
    );
    if (facts.todoId && facts.role)
      recordTodoRole(db, facts.todoId, facts.role, ref, facts.model, facts.effort);
  })();
}

export function recordTodoRole(
  db: BunDatabase,
  todoId: string,
  role: string,
  ref: StartedWork,
  model?: string,
  effort?: string
): void {
  db.prepare(`INSERT INTO neo_todo_roles (todo_id, role, adapter, id, at, model, effort)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    todoId,
    role,
    ref.adapter,
    ref.id,
    Date.now(),
    model ?? null,
    effort ?? null
  );
}

export function readTodoRoles(db: BunDatabase, todoId: string) {
  return db
    .prepare(`SELECT role, adapter, id, model, effort FROM neo_todo_roles
    WHERE todo_id = ? ORDER BY at DESC, rowid DESC`)
    .all(todoId) as {
    role: string;
    adapter: string;
    id: string;
    model: string | null;
    effort: string | null;
  }[];
}

export function claimTodoWorker(
  db: BunDatabase,
  ref: StartedWork,
  todoId: string | null,
  role: string,
  model: string | undefined,
  effort: string | undefined,
  checks: {
    liveTodo: (id: string | null) => boolean;
    isBound: (states: readonly string[]) => boolean;
    liveStates: readonly string[];
    shareWith: readonly string[];
  }
): boolean {
  return db.transaction(() => {
    const workers = readStartedWork(db);
    const own = workers.find((worker) => worker.adapter === ref.adapter && worker.id === ref.id);
    if (own?.releasedAt) return false;
    if (own?.claimedBy !== todoId && checks.liveTodo(own?.claimedBy ?? null)) return false;
    const holders = todoId ? checks.liveStates : [...checks.liveStates, 'done', 'removed'];
    if (checks.isBound(holders)) return false;
    if (!todoId) return true;
    if (!checks.liveTodo(todoId)) return false;
    const roles = readTodoRoles(db, todoId);
    const held = workers.filter((worker) => worker.claimedBy === todoId);
    const ownRole =
      roles.find((entry) => entry.adapter === ref.adapter && entry.id === ref.id)?.role ?? 'do';
    if (own?.claimedBy === todoId && ownRole !== role && !checks.shareWith.includes(ownRole))
      return false;
    if (own?.claimedBy !== todoId && held.length >= 4) return false;
    if (
      workers.some(
        (worker) =>
          worker.claimedBy === todoId &&
          worker !== own &&
          (roles.find((entry) => entry.adapter === worker.adapter && entry.id === worker.id)
            ?.role ?? 'do') === role
      )
    )
      return false;
    recordStartedWork(db, ref, Date.now(), false, false, { todoId });
    recordTodoRole(db, todoId, role, ref, model, effort);
    return true;
  })();
}

export function unclaimTodoWorker(
  db: BunDatabase,
  todoId: string,
  ref: StartedWork,
  role: string
): void {
  db.transaction(() => {
    const own = readStartedWork(db).find(
      (worker) => worker.adapter === ref.adapter && worker.id === ref.id
    );
    if (own?.claimedBy !== todoId) return;
    const currentRole =
      readTodoRoles(db, todoId).find(
        (entry) => entry.adapter === ref.adapter && entry.id === ref.id
      )?.role ?? 'do';
    if (currentRole !== role) return;
    db.prepare(`DELETE FROM neo_todo_roles WHERE rowid = (SELECT rowid FROM neo_todo_roles
      WHERE todo_id = ? AND role = ? AND adapter = ? AND id = ? ORDER BY at DESC, rowid DESC LIMIT 1)`).run(
      todoId,
      role,
      ref.adapter,
      ref.id
    );
    if (
      !readTodoRoles(db, todoId).some(
        (entry) => entry.adapter === ref.adapter && entry.id === ref.id && entry.role !== role
      )
    )
      recordStartedWork(db, ref, Date.now(), false, false, { todoId: null });
  })();
}

export function readWorkerLastTurn(
  db: BunDatabase,
  sessionId: string
): { at: number; oneHourCache: boolean } | null {
  const row = db
    .prepare(
      `SELECT timestamp, COALESCE(json_extract(${sdkMessageBodyAt('sdk_messages.rowid')},
         '$.message.usage.cache_creation.ephemeral_1h_input_tokens'), 0) AS oneHour
       FROM sdk_messages WHERE session_id = ? AND message_type = 'assistant'
         AND parent_tool_use_id IS NULL
       ORDER BY timestamp DESC, rowid DESC LIMIT 1`
    )
    .get(sessionId) as { timestamp: string; oneHour: number } | null;
  const at = row ? Date.parse(row.timestamp) : Number.NaN;
  return Number.isFinite(at) ? { at, oneHourCache: Number(row?.oneHour) > 0 } : null;
}

export function readWorkerPreparations(db: BunDatabase, adapter: string) {
  return db
    .prepare(`SELECT id, preparation FROM work_started_sessions
    WHERE adapter = ? AND kind = 'worker' AND released_at IS NULL
      AND (unusable_at IS NULL OR unusable_at <= ?)`)
    .all(adapter, Date.now() - 60 * 60_000) as {
    id: string;
    preparation: string | null;
  }[];
}

export function forgetWorkGone(db: BunDatabase, root: string): void {
  db.run('DELETE FROM work_cleanup_gone WHERE key = ?', workerWorkKey(root));
}

export function markWorkUnusable(
  db: BunDatabase,
  ref: StartedWork,
  reason = 'worker unavailable'
): void {
  db.transaction(() => {
    recordStartedWork(db, ref, Date.now(), true);
    db.prepare(
      'UPDATE work_started_sessions SET unusable_reason = ? WHERE adapter = ? AND id = ?'
    ).run(reason, ref.adapter, ref.id);
  })();
}

export function recordWorkArchived(db: BunDatabase, ref: StartedWork, reason: string): void {
  db.prepare(`UPDATE work_started_sessions SET archived_at = ?, archive_reason = ?
    WHERE adapter = ? AND id = ? AND kind = 'worker'`).run(Date.now(), reason, ref.adapter, ref.id);
}

export function recordWorkRelease(
  db: BunDatabase,
  ref: StartedWork,
  at: number,
  reason: string
): void {
  db.transaction(() => {
    recordStartedWork(db, ref, at, false, true);
    db.prepare(`UPDATE work_started_sessions SET release_reason = ?
      WHERE adapter = ? AND id = ? AND kind = 'worker'`).run(reason, ref.adapter, ref.id);
  })();
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
         WHERE (?1 IS NULL OR kind = 'worker')
           AND (?5 IS NULL OR (adapter = ?5 AND id = ?6 AND kind = 'worker'))
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

export function readTrustedWorkers(db: BunDatabase, refs: readonly StartedWork[]): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT own.adapter, own.id FROM json_each(?) AS requested
    JOIN work_started_sessions AS own
      ON own.adapter = json_extract(requested.value, '$.adapter')
      AND own.id = json_extract(requested.value, '$.id')
    WHERE own.kind = 'worker'`)
    .all(JSON.stringify(refs)) as StartedWork[];
  return new Set(rows.map((ref) => JSON.stringify([ref.adapter, ref.id])));
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

  todoRoles(todoId: string) {
    return readTodoRoles(this.db, todoId);
  }

  workerPreparations(adapter: string) {
    return readWorkerPreparations(this.db, adapter);
  }

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

  recordStarted(
    ref: StartedWork,
    directory?: string,
    facts?: Parameters<typeof recordWorkerStarted>[2]
  ): void {
    recordWorkerStarted(this.db, ref, facts);
    if (directory) forgetWorkGone(this.db, directory);
  }

  recordCompacted(ref: StartedWork, at: number): void {
    this.db
      .prepare(
        `UPDATE work_started_sessions SET compacted_at = ?1
       WHERE adapter = ?2 AND id = ?3 AND kind = 'worker'
         AND (compacted_at IS NULL OR compacted_at < ?1)`
      )
      .run(at, ref.adapter, ref.id);
  }

  markUnusable(ref: StartedWork, reason?: string): void {
    markWorkUnusable(this.db, ref, reason);
  }

  recordArchived(ref: StartedWork, reason: string): void {
    recordWorkArchived(this.db, ref, reason);
  }
}

export const workStartedSessionReads = defineRepositoryOp(
  'work.startedSessionReads',
  'read',
  WorkStartedSessionReads,
  ['startedWork', 'startedByUs', 'reusableWorkers', 'todoRoles', 'workerPreparations']
);

export const workStartedSessionWrites = defineRepositoryOp(
  'work.startedSessionWrites',
  'write',
  WorkStartedSessionWrites,
  ['recordStarted', 'markUnusable', 'recordArchived', 'recordCompacted']
);

export function readReleaseReuseRow(db: BunDatabase, todoId: string) {
  const row = db
    .prepare(
      `WITH uses AS (
           SELECT json_extract(o.ref, '$.adapter') AS adapter, json_extract(o.ref, '$.id') AS id,
             MAX(COALESCE(ot.finished_at, ot.updated_at)) AS usedAt,
             MAX(json_extract(o.target, '$.place.folder')) AS folder,
             MAX(ot.state IN ('todo', 'doing', 'blocked')) AS live
           FROM neo_todo_sessions o JOIN neo_todos ot ON ot.id = o.todo_id
           JOIN work_started_sessions w ON w.adapter = json_extract(o.ref, '$.adapter')
             AND w.id = json_extract(o.ref, '$.id') AND w.kind = 'worker' AND w.released_at IS NULL
           WHERE o.ref IS NOT NULL AND json_extract(o.ref, '$.daemon') IS NULL
           GROUP BY 1, 2
         )
         SELECT a.status = 'open' AS askOpen, a.project_id AS projectId,
           (SELECT mine.folder FROM uses mine WHERE mine.adapter = json_extract(s.ref, '$.adapter')
             AND mine.id = json_extract(s.ref, '$.id')) IS NOT NULL AS hasFolder,
           EXISTS (SELECT 1 FROM uses mine JOIN uses other
               ON other.adapter = mine.adapter AND other.id <> mine.id AND other.folder = mine.folder
             WHERE mine.adapter = json_extract(s.ref, '$.adapter') AND mine.id = json_extract(s.ref, '$.id')
               AND NOT other.live
               AND (other.usedAt > mine.usedAt OR (other.usedAt = mine.usedAt AND other.id > mine.id))
           ) AS newerFree
         FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
         JOIN neo_asks a ON a.id = t.ask_id
         WHERE s.todo_id = ?`
    )
    .get(todoId) as {
    askOpen: number;
    projectId: string | null;
    hasFolder: number;
    newerFree: number;
  } | null;
  return row;
}

export function readWorkerOwnershipRows(db: BunDatabase) {
  return db
    .prepare(
      `SELECT adapter, id, started_at AS startedAt, claimed_by AS claimedBy, released_at AS releasedAt, kind AS role FROM work_started_sessions ORDER BY adapter, id`
    )
    .all();
}

export function markReviewedWorkers(db: BunDatabase, refs: StartedWork[]): void {
  const update = db.prepare(
    "UPDATE work_started_sessions SET kind = 'worker' WHERE adapter = ? AND id = ? AND (kind IS NULL OR kind = '') AND released_at IS NULL AND claimed_by IS NULL"
  );
  for (const ref of refs) update.run(ref.adapter, ref.id);
}

export function readSameAskWorkers(
  db: BunDatabase,
  askId: string,
  todoId: string,
  adapter: string
): { id: string }[] {
  return db
    .prepare(`SELECT json_extract(s.ref, '$.id') AS id,
      MAX(COALESCE(t.started_at, t.created_at)) AS usedAt
    FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
    JOIN work_started_sessions w ON w.adapter = json_extract(s.ref, '$.adapter')
      AND w.id = json_extract(s.ref, '$.id') AND w.kind = 'worker'
    WHERE t.ask_id = ? AND t.id <> ? AND json_extract(s.ref, '$.adapter') = ?
      AND json_extract(s.ref, '$.daemon') IS NULL AND w.released_at IS NULL
      AND (w.unusable_at IS NULL OR w.unusable_at <= ?)
    GROUP BY w.adapter, w.id ORDER BY usedAt DESC`)
    .all(askId, todoId, adapter, Date.now() - 3_600_000) as { id: string }[];
}
