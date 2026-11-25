import { readReleaseReuseRow, readSameAskWorkers } from './work-started-sessions-worker.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { getNeoPackPreference } from '../../lib/neo/preferences.ts';
import { SESSION_REUSE_VALUES } from '../../lib/neo/session-reuse.ts';
import type { NeoDesktopApp } from '@hyperneo/shared/types/neo-ask';

export function mergeAskDesktopApps(
  held: readonly NeoDesktopApp[],
  apps: readonly NeoDesktopApp[]
): NeoDesktopApp[] {
  const scope = [...held];
  for (const app of apps)
    if (!scope.some(({ bundleId }) => bundleId === app.bundleId)) scope.push(app);
  return scope;
}

export type NeoAskInputClaim = {
  sessionId: string;
  messageId: string;
  askId?: string;
  title: string;
  topic?: string;
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
  const workers = readSameAskWorkers(db, row.askId, todoId, adapter);
  return { ...row, scope, saved: !!saved, mode, sameAsk: workers.map(({ id }) => id) };
}

export function releaseReuseFacts(
  db: Database,
  todoId: string
): {
  mode: (typeof SESSION_REUSE_VALUES)[number];
  askOpen: boolean;
  hasFolder: boolean;
} | null {
  const row = readReleaseReuseRow(db, todoId);
  if (!row) return null;
  const scope = row.projectId
    ? { kind: 'project' as const, key: row.projectId }
    : { kind: 'global' as const, key: '' };
  const saved = getNeoPackPreference(db, 'core', scope, 'sessionReuse')?.value;
  return {
    mode: SESSION_REUSE_VALUES.find((value) => value === saved) ?? 'long_lived',
    askOpen: row.askOpen === 1,
    hasFolder: row.hasFolder === 1,
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
        topic: input.topic ?? null,
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

  addAskDesktopApps(id: string, apps: readonly NeoDesktopApp[], now: number): boolean {
    const ask = new NeoAskTodoRepository(this.db).getAsk(id);
    if (!ask || ask.status !== 'open') return false;
    const scope = mergeAskDesktopApps(ask.desktopApps ?? [], apps);
    this.db
      .prepare(
        "UPDATE neo_asks SET desktop_apps = ?, updated_at = ? WHERE id = ? AND status = 'open'"
      )
      .run(JSON.stringify(scope), now, id);
    return true;
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
  'addAskDesktopApps',
]);
