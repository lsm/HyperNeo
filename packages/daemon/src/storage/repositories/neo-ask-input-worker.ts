import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';

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

  bind(sessionId: string, messageId: string, askId: string, now: number): string | null {
    this.db
      .prepare(`INSERT INTO neo_ask_inputs (session_id, message_id, ask_id, bound_at)
      SELECT ?, ?, id, ? FROM neo_asks WHERE id = ? AND session_id = ? AND status = 'open'
      ON CONFLICT(session_id, message_id) DO UPDATE
      SET ask_id = excluded.ask_id, bound_at = excluded.bound_at
      WHERE neo_ask_inputs.ask_id IN (SELECT id FROM neo_asks WHERE status != 'open')`)
      .run(sessionId, messageId, now, askId, sessionId);
    return this.owner(sessionId, messageId);
  }
}

export const neoAskInputReads = defineRepositoryOp('neo.askInputs.read', 'read', NeoAskInputs, [
  'owner',
]);
export const neoAskInputWrites = defineRepositoryOp('neo.askInputs.write', 'write', NeoAskInputs, [
  'bind',
]);
