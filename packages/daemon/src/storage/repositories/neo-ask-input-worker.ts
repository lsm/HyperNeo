import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';

export type NeoAskInputClaim = {
  sessionId: string;
  messageId: string;
  askId?: string;
  title: string;
  request: string;
};

class NeoAskInputs {
  constructor(private readonly db: Database) {}

  owner(sessionId: string, messageId: string): string | null {
    const row = this.db
      .prepare(`SELECT ask_id AS askId FROM neo_ask_inputs
        WHERE session_id = ? AND message_id = ?
        AND ask_id IN (SELECT id FROM neo_asks WHERE status = 'open')`)
      .get(sessionId, messageId) as { askId: string } | null;
    return row?.askId ?? null;
  }

  claimNeoInputAsk(input: NeoAskInputClaim): string | null {
    const store = new NeoAskTodoRepository(this.db);
    const owner =
      store.findAsk(input.sessionId, input.messageId, null)?.id ??
      this.owner(input.sessionId, input.messageId);
    if (owner) return owner;
    const target = input.askId ? store.getAsk(input.askId) : null;
    if (input.askId && (target?.sessionId !== input.sessionId || target.status !== 'open'))
      return null;
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
]);
export const neoAskInputWrites = defineRepositoryOp('neo.askInputs.write', 'write', NeoAskInputs, [
  'claimNeoInputAsk',
]);
