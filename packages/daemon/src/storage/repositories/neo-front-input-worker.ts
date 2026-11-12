import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { sdkMessageBodyAt } from './sdk-message-body-read.ts';
import { SESSION_BILLING_TERMINAL, CONSUMED_INPUT } from './sdk-message-input-predicates.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../lib/mailbox/enqueue.ts';
import type { MailboxEntry } from '../../lib/mailbox/entry.ts';
import {
  catchUpBlock,
  FRONT_FALLBACK_TEXT,
  frontFallbackId,
} from '../../lib/neo/front-catch-up.ts';

export class NeoFrontInputRepository {
  constructor(private readonly db: Database) {}

  get(conversationId: string, messageId: string) {
    const row = this.db
      .prepare(`SELECT eligible, COALESCE(owner, CASE WHEN EXISTS (
        SELECT 1 FROM neo_publications p WHERE p.conversation_id = f.conversation_id AND (
          f.message_id IN (SELECT value FROM json_each(p.payload_json, '$.replyTo'))
          OR f.message_id IN (SELECT value FROM json_each(p.payload_json, '$.cardReply.sourceMessageIds'))
          OR (json_extract(p.payload_json, '$.producerInput.messageId') = f.message_id
            AND json_type(p.payload_json, '$.revisionId') = 'text')
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
    ), candidates AS (
      SELECT r.consumed_seq, ${sdkMessageBodyAt('r.rowid')} AS body FROM sdk_messages r, input
      WHERE r.session_id = ?1 AND r.consumed_seq > input.consumed_seq
        AND ${SESSION_BILLING_TERMINAL}
    ), ended AS (
      SELECT consumed_seq, body FROM candidates WHERE
        (json_type(body, '$.user_message_uuid') IS NULL
          AND json_type(body, '$.user_message_uuids') IS NULL)
        OR json_extract(body, '$.user_message_uuid') = ?2
        OR ?2 IN (SELECT value FROM json_each(body, '$.user_message_uuids'))
      ORDER BY consumed_seq LIMIT 1
    ) SELECT input.send_status AS sendStatus, ended.body,
      (SELECT json_group_array(u.sdk_uuid) FROM sdk_messages u
        JOIN neo_front_inputs f ON f.conversation_id = ?3 AND f.message_id = u.sdk_uuid AND f.eligible = 1 AND f.owner IS NULL
        WHERE u.session_id = ?1 AND ${CONSUMED_INPUT}
        AND CASE WHEN json_type(ended.body, '$.user_message_uuid') IS NOT NULL
          OR json_type(ended.body, '$.user_message_uuids') IS NOT NULL
        THEN u.sdk_uuid = json_extract(ended.body, '$.user_message_uuid')
          OR u.sdk_uuid IN (SELECT value FROM json_each(ended.body, '$.user_message_uuids'))
        ELSE u.consumed_seq > COALESCE((SELECT MAX(consumed_seq) FROM sdk_messages
          WHERE session_id = ?1 AND ${SESSION_BILLING_TERMINAL}
            AND consumed_seq < ended.consumed_seq), 0) END
        AND u.consumed_seq < ended.consumed_seq) AS messageIds
      FROM input LEFT JOIN ended ON 1`)
      .get(sessionId, messageId, conversationId) as {
      sendStatus: string | null;
      body: string | null;
      messageIds: string | null;
    } | null;
    if (!row || (!row.body && row.sendStatus !== 'failed')) return null;
    const result = row.body
      ? (JSON.parse(row.body) as { subtype?: string; num_turns?: number; is_error?: boolean })
      : null;
    const ids = JSON.parse(row.messageIds ?? '[]') as string[];
    return {
      messageIds: (ids.length ? ids : [messageId]).filter(
        (id) => !this.get(conversationId, id)?.owner
      ),
      toolUsed: result?.subtype === 'success' && !result.is_error && (result.num_turns ?? 0) > 1,
    };
  }

  enqueueWithCatchUp(conversationId: string, entry: MailboxEntry): 'duplicate' | 'enqueued' {
    if (entry.to.kind !== 'session' || !entry.messageUuid)
      throw new Error('Front delivery requires a session and message identity');
    const sessionId = entry.to.sessionId;
    const messageId = entry.messageUuid;
    return this.db.transaction(() => {
      const queue = new JobQueueRepository(this.db);
      if (
        new SDKMessageRepository(this.db).findMessageIdByUuid(sessionId, messageId) ||
        queue.listActiveByPayload(MAILBOX_LANE, {
          'to.sessionId': sessionId,
          messageUuid: messageId,
        }).length
      )
        return 'duplicate';
      const { upper } = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS upper FROM neo_publications WHERE conversation_id = ?'
        )
        .get(conversationId) as { upper: number };
      const fallenBack = new Set(
        (
          this.db
            .prepare(`SELECT publication_id AS id, payload_json AS payload FROM neo_publications
            WHERE conversation_id = ? AND json_extract(payload_json, '$.fullText') = ?`)
            .all(conversationId, FRONT_FALLBACK_TEXT) as { id: string; payload: string }[]
        ).flatMap((row) => {
          const replyTo = (JSON.parse(row.payload) as { replyTo?: string[] }).replyTo ?? [];
          return row.id === frontFallbackId(conversationId, replyTo) ? replyTo : [];
        })
      );
      const prior = (
        this.db
          .prepare(`SELECT f.message_id AS id, f.catch_up_through AS through FROM neo_front_inputs f
          WHERE f.conversation_id = ?1 AND f.message_id <> ?2 AND f.catch_up_through IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM sdk_messages s WHERE s.session_id = ?3
              AND s.sdk_uuid = f.message_id AND s.send_status = 'failed')
          ORDER BY f.catch_up_through DESC`)
          .all(conversationId, messageId, sessionId) as { id: string; through: number }[]
      ).find((row) => !fallenBack.has(row.id));
      const from = prior?.through ?? upper;
      const said = (
        this.db
          .prepare(`SELECT payload_json AS payload FROM neo_publications
          WHERE conversation_id = ? AND sequence > ? AND sequence <= ?
            AND json_extract(payload_json, '$.publishedBy') = 'neo' ORDER BY sequence`)
          .all(conversationId, from, upper) as { payload: string }[]
      ).map((row) => JSON.parse(row.payload) as { replyTo?: string[]; fullText: string });
      const block = catchUpBlock(said);
      const content = entry.message.message.content;
      const sent = enqueueMailboxEntry(
        queue,
        block
          ? {
              ...entry,
              message: {
                ...entry.message,
                message: {
                  ...entry.message.message,
                  content: [
                    { type: 'text', text: block },
                    ...(typeof content === 'string'
                      ? [{ type: 'text' as const, text: content }]
                      : content),
                  ],
                },
              },
            }
          : entry
      );
      if (sent.kind === 'rejected') throw new Error(sent.reason);
      this.db
        .prepare(`UPDATE neo_front_inputs SET catch_up_from = ?, catch_up_through = ?
        WHERE conversation_id = ? AND message_id = ?`)
        .run(from, upper, conversationId, messageId);
      return 'enqueued';
    })();
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

export const neoFrontDeliveryWrites = defineRepositoryOp(
  'neo.front.delivery',
  'write',
  NeoFrontInputRepository,
  ['enqueueWithCatchUp']
);

export const neoFrontInputReads = defineRepositoryOp(
  'neo.front.outcomes',
  'read',
  NeoFrontInputRepository,
  ['get', 'terminal']
);
