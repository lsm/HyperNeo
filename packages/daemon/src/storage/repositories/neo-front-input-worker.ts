import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { sdkMessageBodyAt } from './sdk-message-body-read.ts';
import { SESSION_BILLING_TERMINAL, CONSUMED_INPUT } from './sdk-message-input-predicates.ts';

export class NeoFrontInputRepository {
  constructor(private readonly db: Database) {}

  get(conversationId: string, messageId: string) {
    const row = this.db
      .prepare(`SELECT eligible, COALESCE(owner, CASE WHEN EXISTS (
        SELECT 1 FROM neo_publications p WHERE p.conversation_id = f.conversation_id AND (
          f.message_id IN (SELECT value FROM json_each(p.payload_json, '$.replyTo'))
          OR f.message_id IN (SELECT value FROM json_each(p.payload_json, '$.cardReply.sourceMessageIds'))
        )
      ) THEN 'neo' END) AS owner FROM neo_front_inputs f
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

  terminal(conversationId: string, sessionId: string, messageId: string) {
    const row = this.db
      .prepare(`WITH input AS (
      SELECT consumed_seq, send_status FROM sdk_messages
      WHERE session_id = ?1 AND sdk_uuid = ?2 AND message_type = 'user' LIMIT 1
    ), ended AS (
      SELECT r.consumed_seq, ${sdkMessageBodyAt('r.rowid')} AS body FROM sdk_messages r, input
      WHERE r.session_id = ?1 AND r.consumed_seq > input.consumed_seq
        AND ${SESSION_BILLING_TERMINAL}
      ORDER BY r.consumed_seq LIMIT 1
    ) SELECT input.send_status AS sendStatus, ended.body,
      (SELECT json_group_array(u.sdk_uuid) FROM sdk_messages u
        JOIN neo_front_inputs f ON f.conversation_id = ?3 AND f.message_id = u.sdk_uuid AND f.eligible = 1 AND f.owner IS NULL
        WHERE u.session_id = ?1 AND ${CONSUMED_INPUT}
        AND u.consumed_seq > COALESCE((SELECT MAX(consumed_seq) FROM sdk_messages
          WHERE session_id = ?1 AND ${SESSION_BILLING_TERMINAL}
            AND consumed_seq < ended.consumed_seq), 0)
        AND u.consumed_seq < ended.consumed_seq) AS messageIds
      FROM input LEFT JOIN ended ON 1`)
      .get(sessionId, messageId, conversationId) as {
      sendStatus: string | null;
      body: string | null;
      messageIds: string | null;
    } | null;
    if (!row || (!row.body && row.sendStatus !== 'failed')) return null;
    const result = row.body
      ? (JSON.parse(row.body) as { subtype?: string; result?: string; is_error?: boolean })
      : null;
    const ids = JSON.parse(row.messageIds ?? '[]') as string[];
    return {
      messageIds: (ids.length ? ids : [messageId]).filter(
        (id) => !this.get(conversationId, id)?.owner
      ),
      text: result?.subtype === 'success' && !result.is_error ? (result.result ?? '') : '',
    };
  }

  claim(conversationId: string, messageIds: readonly string[], owner: 'front' | 'neo'): boolean {
    const ids = [...new Set(messageIds)];
    if (!ids.length) return false;
    return this.db.transaction(() => {
      const rows = ids.map((id) => this.get(conversationId, id));
      if (rows.some((row) => !row?.eligible)) return false;
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

export const neoFrontInputReads = defineRepositoryOp(
  'neo.front.outcomes',
  'read',
  NeoFrontInputRepository,
  ['get', 'terminal']
);
