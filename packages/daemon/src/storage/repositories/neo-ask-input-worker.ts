import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { getNeoPackPreference } from '../../lib/neo/preferences.ts';
import { SESSION_REUSE_VALUES } from '../../lib/neo/session-reuse.ts';

export type NeoAskInputClaim = {
  sessionId: string;
  messageId: string;
  askId?: string;
  title: string;
  request: string;
};

function sessionReuseFacts(db: Database, adapter: string, todoId: string, sessionId: string) {
  const row = db
    .prepare(`SELECT a.id AS askId, a.project_id AS projectId
    FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id
    WHERE t.id = ? AND a.session_id = ? AND a.status = 'open'`)
    .get(todoId, sessionId) as { askId: string; projectId: string | null } | null;
  if (!row) return null;
  const scope = row.projectId
    ? { kind: 'project' as const, key: row.projectId }
    : { kind: 'global' as const, key: '' };
  const saved = getNeoPackPreference(db, 'core', scope, 'sessionReuse');
  const mode = SESSION_REUSE_VALUES.find((value) => value === saved?.value) ?? 'long_lived';
  const workers = db
    .prepare(`SELECT json_extract(s.ref, '$.id') AS id,
      MAX(COALESCE(t.started_at, t.created_at)) AS usedAt
    FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
    JOIN work_started_sessions w ON w.adapter = json_extract(s.ref, '$.adapter')
      AND w.id = json_extract(s.ref, '$.id') AND w.role = 'worker'
    WHERE t.ask_id = ? AND t.id <> ? AND json_extract(s.ref, '$.adapter') = ?
      AND json_extract(s.ref, '$.daemon') IS NULL AND w.released_at IS NULL
      AND (w.unusable_at IS NULL OR w.unusable_at <= ?)
    GROUP BY w.adapter, w.id ORDER BY usedAt DESC`)
    .all(row.askId, todoId, adapter, Date.now() - 3_600_000) as { id: string }[];
  return { ...row, scope, saved: !!saved, mode, sameAsk: workers.map(({ id }) => id) };
}

export function releaseReuseFacts(
  db: Database,
  todoId: string
): {
  mode: (typeof SESSION_REUSE_VALUES)[number];
  askOpen: boolean;
  hasFolder: boolean;
  newerFree: boolean;
} | null {
  const row = db
    .prepare(
      `WITH uses AS (
           SELECT json_extract(o.ref, '$.adapter') AS adapter, json_extract(o.ref, '$.id') AS id,
             MAX(COALESCE(ot.finished_at, ot.updated_at)) AS usedAt,
             MAX(json_extract(o.target, '$.place.folder')) AS folder,
             MAX(ot.state IN ('todo', 'doing', 'blocked')) AS live
           FROM neo_todo_sessions o JOIN neo_todos ot ON ot.id = o.todo_id
           JOIN work_started_sessions w ON w.adapter = json_extract(o.ref, '$.adapter')
             AND w.id = json_extract(o.ref, '$.id') AND w.role = 'worker' AND w.released_at IS NULL
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
  if (!row) return null;
  const scope = row.projectId
    ? { kind: 'project' as const, key: row.projectId }
    : { kind: 'global' as const, key: '' };
  const saved = getNeoPackPreference(db, 'core', scope, 'sessionReuse')?.value;
  return {
    mode: SESSION_REUSE_VALUES.find((value) => value === saved) ?? 'long_lived',
    askOpen: row.askOpen === 1,
    hasFolder: row.hasFolder === 1,
    newerFree: row.newerFree === 1,
  };
}

export type SessionReuseFacts = NonNullable<ReturnType<typeof sessionReuseFacts>>;

class NeoAskInputs {
  constructor(private readonly db: Database) {}

  sessionReuseFacts(adapter: string, todoId: string, sessionId: string) {
    return sessionReuseFacts(this.db, adapter, todoId, sessionId);
  }

  sessionReuseQuestionState(prefix: string) {
    return (
      (
        this.db
          .prepare(`SELECT q.state FROM neo_pack_preference_proposals p
      JOIN neo_questions q ON q.id = p.question_id
      WHERE substr(p.request_id, 1, length(?)) = ?
      ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1`)
          .get(prefix, prefix) as { state: string } | null
      )?.state ?? null
    );
  }

  latestHumanContent() {
    return (
      (
        this.db
          .prepare(`SELECT payload_json AS payload FROM neo_conversation_asks
      ORDER BY sequence DESC LIMIT 1`)
          .get() as { payload: string } | null
      )?.payload ?? null
    );
  }

  owner(sessionId: string, messageId: string): string | null {
    const row = this.db
      .prepare(`SELECT ask_id AS askId FROM neo_ask_inputs
        WHERE session_id = ? AND message_id = ?
        AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`)
      .get(sessionId, messageId) as { askId: string } | null;
    return row?.askId ?? null;
  }

  claimNeoInputAsk(input: NeoAskInputClaim): string | { reason: string } {
    const store = new NeoAskTodoRepository(this.db);
    const owner =
      store.findAsk(input.sessionId, input.messageId, null)?.id ??
      this.owner(input.sessionId, input.messageId);
    if (owner) return owner;
    const target = input.askId ? store.getAsk(input.askId) : null;
    if (input.askId && target?.sessionId !== input.sessionId)
      return { reason: 'not_owned: this ask is unknown or belongs to another session.' };
    if (input.askId && target?.status !== 'open')
      return { reason: 'ask_settled: this ask is no longer open. Omit askId to open a new card.' };
    const now = Date.now();
    const askId =
      input.askId ??
      store.openAsk({
        id: crypto.randomUUID(),
        projectId: null,
        sessionId: input.sessionId,
        originMessageId: input.messageId,
        title: input.title,
        request: input.request,
        createdAt: now,
      }).id;
    this.db
      .prepare(`INSERT INTO neo_ask_inputs (session_id, message_id, ask_id, bound_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id, message_id) DO UPDATE
        SET ask_id = excluded.ask_id, bound_at = excluded.bound_at`)
      .run(input.sessionId, input.messageId, askId, now);
    return askId;
  }
}

export const neoAskInputReads = defineRepositoryOp('neo.askInputs.read', 'read', NeoAskInputs, [
  'owner',
  'sessionReuseFacts',
  'sessionReuseQuestionState',
  'latestHumanContent',
]);
export const neoAskInputWrites = defineRepositoryOp('neo.askInputs.write', 'write', NeoAskInputs, [
  'claimNeoInputAsk',
]);
