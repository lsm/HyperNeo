import type { Database } from '../sqlite-compat.ts';
import { ChangeRecorder, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { sdkMessageWrites } from './sdk-message-writes.ts';
import { sdkMessageBodyAt } from './sdk-message-body-read.ts';
import { SESSION_BILLING_TERMINAL, CONSUMED_INPUT } from './sdk-message-input-predicates.ts';
import { JobQueueRepository } from './job-queue-repository.ts';
import { SDKMessageRepository } from './sdk-message-repository.ts';
import {
  ensurePromptInTransaction,
  type PersistPromptArgs,
} from '../../lib/agent/message-delivery-outbox.ts';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../lib/mailbox/enqueue.ts';
import { toMailboxMessage, type MailboxEntry } from '../../lib/mailbox/entry.ts';
import {
  catchUpBlock,
  FRONT_FALLBACK_TEXT,
  frontFallbackId,
} from '../../lib/neo/front-catch-up.ts';

export class NeoFrontInputRepository {
  constructor(
    private readonly db: Database,
    private readonly changes?: Pick<ReactiveDatabase, 'notifyChange'>
  ) {}

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
        JOIN neo_front_inputs f ON f.conversation_id = ?3 AND f.message_id = u.sdk_uuid
          AND f.eligible = 1 AND (f.owner IS NULL OR f.owner = 'front')
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
    const ids = JSON.parse(row.messageIds ?? '[]') as string[];
    return {
      messageIds: (ids.length ? ids : [messageId]).filter(
        (id) => this.get(conversationId, id)?.owner !== 'neo'
      ),
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
      const message = toMailboxMessage(
        block
          ? {
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
            }
          : entry.message
      );
      if ('reason' in message) throw new Error(message.reason);
      const sent = enqueueMailboxEntry(queue, { ...entry, message: message.message });
      if (sent.kind === 'rejected') throw new Error(sent.reason);
      this.db
        .prepare(`UPDATE neo_front_inputs SET catch_up_from = ?, catch_up_through = ?
        WHERE conversation_id = ? AND message_id = ?`)
        .run(from, upper, conversationId, messageId);
      return 'enqueued';
    })();
  }

  claim(
    conversationId: string,
    messageIds: readonly string[],
    owner: 'front' | 'neo'
  ): 'claimed' | 'ineligible' {
    const ids = [...new Set(messageIds)];
    if (!ids.length) return 'ineligible';
    return this.db.transaction(() => {
      const rows = ids.map((id) => this.get(conversationId, id));
      if (rows.some((row) => !row?.eligible)) return 'ineligible';
      for (const id of ids)
        this.db
          .prepare(`UPDATE neo_front_inputs SET owner = ?
          WHERE conversation_id = ? AND message_id = ? AND owner IS NULL`)
          .run(owner, conversationId, id);
      return 'claimed' as const;
    })();
  }

  claimUnowned(
    conversationId: string,
    messageIds: readonly string[],
    owner: 'front' | 'neo'
  ): 'claimed' | 'ineligible' {
    const ids = [...new Set(messageIds)];
    if (!ids.length) return 'ineligible';
    return this.db.transaction(() => {
      const rows = ids.map((id) => this.get(conversationId, id));
      if (rows.some((row) => !row?.eligible || row.owner !== null)) return 'ineligible';
      for (const id of ids)
        this.db
          .prepare(`UPDATE neo_front_inputs SET owner = ?
          WHERE conversation_id = ? AND message_id = ? AND owner IS NULL`)
          .run(owner, conversationId, id);
      return 'claimed' as const;
    })();
  }

  release(conversationId: string, messageIds: readonly string[]): number {
    const run = this.db.prepare(`UPDATE neo_front_inputs SET owner = NULL
      WHERE conversation_id = ? AND message_id = ? AND owner = 'front'`);
    return messageIds.reduce((count, id) => count + run.run(conversationId, id).changes, 0);
  }

  failSettled(
    conversationId: string,
    sessionId: string,
    messageId: string,
    origin: { sessionId: string; message: SDKUserMessage }
  ): 'failed' | 'delivered' | 'handed_off' {
    const changes = new ChangeRecorder();
    const outcome = this.db.transaction(() => {
      if (this.get(conversationId, messageId)?.owner === 'neo') return 'handed_off' as const;
      const sdk = new SDKMessageRepository(this.db);
      const status = sdk.getUserSendStatus(origin.sessionId, messageId);
      if (status !== null && status !== 'failed') return 'delivered' as const;
      this.release(conversationId, [messageId]);
      sdkMessageWrites.run(
        this.db,
        { method: 'markDeliveryFailedByUuidInclusive', args: [sessionId, messageId] },
        changes
      );
      if (status === null)
        sdkMessageWrites.run(
          this.db,
          {
            method: 'saveUserMessage',
            args: [origin.sessionId, origin.message, 'failed'],
          },
          changes
        );
      return 'failed' as const;
    })();
    for (const change of changes.changes) this.changes?.notifyChange(change.table, change.scope);
    return outcome;
  }

  reserve(
    conversationId: string,
    messageIds: readonly string[],
    prompts: readonly Pick<PersistPromptArgs, 'sessionId' | 'message'>[]
  ): 'reserved' | 'ineligible' | 'undeliverable' {
    return this.db.transaction(() => {
      const rows = messageIds.map((id) => this.get(conversationId, id));
      if (rows.some((row) => !row?.eligible)) return 'ineligible';
      const sdk = new SDKMessageRepository(this.db);
      const statuses = prompts.map((prompt) =>
        sdk.getUserSendStatus(prompt.sessionId, prompt.message.uuid!)
      );
      if (statuses.includes('failed')) return 'undeliverable';
      for (const id of messageIds)
        this.db
          .prepare(`UPDATE neo_front_inputs SET owner = 'neo'
          WHERE conversation_id = ? AND message_id = ?`)
          .run(conversationId, id);
      prompts.forEach((prompt, index) => {
        if (statuses[index]) return;
        ensurePromptInTransaction({
          ...prompt,
          db: this.db,
          sdkMessageRepo: sdk,
          jobQueue: new JobQueueRepository(this.db),
          hold: 'immediate',
          delivery: { origin: 'chat' },
        });
      });
      return 'reserved' as const;
    })();
  }
}

export const neoFrontInputWrites = defineRepositoryOp(
  'neo.front.inputs',
  'write',
  NeoFrontInputRepository,
  ['claim', 'claimUnowned', 'release', 'reserve', 'failSettled']
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
