import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';

export class NeoFrontInputRepository {
  constructor(private readonly db: Database) {}

  get(conversationId: string, messageId: string) {
    const row = this.db
      .prepare(`SELECT eligible, owner FROM neo_front_inputs
      WHERE conversation_id = ? AND message_id = ?`)
      .get(conversationId, messageId) as { eligible: number; owner: 'front' | 'neo' | null } | null;
    return row ? { eligible: row.eligible === 1, owner: row.owner } : null;
  }

  accept(conversationId: string, messageId: string, eligible: boolean): boolean {
    return (
      this.db
        .prepare(`INSERT INTO neo_front_inputs (conversation_id, message_id, eligible)
      VALUES (?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(conversationId, messageId, Number(eligible)).changes === 1
    );
  }

  claim(conversationId: string, messageIds: readonly string[], owner: 'front' | 'neo'): boolean {
    const ids = [...new Set(messageIds)];
    if (!ids.length) return false;
    return this.db.transaction(() => {
      const rows = ids.map((id) => this.get(conversationId, id));
      if (rows.some((row) => !row?.eligible || row.owner !== null)) return false;
      for (const id of ids)
        this.db
          .prepare(`UPDATE neo_front_inputs SET owner = ?
          WHERE conversation_id = ? AND message_id = ?`)
          .run(owner, conversationId, id);
      return true;
    })();
  }
}

export const neoFrontInputWrites = defineRepositoryOp(
  'neo.front.inputs',
  'write',
  NeoFrontInputRepository,
  ['claim']
);
