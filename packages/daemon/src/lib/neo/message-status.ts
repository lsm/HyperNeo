import type {
  NeoConversationAsk,
  NeoConversationAskPageItem,
  NeoConversationMessageStatus,
} from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { parseProcessingState } from '../session/space-session-reads.ts';
import { frontSessionId } from './front-mode.ts';
import { neoDerivedId } from './derived-id.ts';
import { readRefusedNeoInput } from '../../storage/repositories/neo-front-input-worker.ts';

type Ask = NeoConversationAsk | NeoConversationAskPageItem;
export type NeoMessageStatusRef = Pick<Ask, 'conversationId' | 'requestId' | 'askOrigin'>;
export type Fact = {
  sendStatus: string | null;
  processing: string | null;
  answered: boolean;
  messageDbId: string | null;
  reason?: string;
  supersededBy?: string;
};
export type NeoMessageStatusPresenter = <T extends Ask>(items: readonly T[]) => T[] | Promise<T[]>;

export function readMessageFacts(db: Database, items: readonly NeoMessageStatusRef[]): Fact[] {
  if (!items.length) return [];
  const answered = new Set<string>();
  for (const conversation of new Set(items.map((item) => item.conversationId))) {
    const ids = items
      .filter((item) => item.conversationId === conversation)
      .map((item) => item.requestId);
    const rows = db
      .prepare(`SELECT DISTINCT ref.value AS id FROM neo_publications p,
      json_each(p.payload_json, '$.replyTo') ref WHERE p.conversation_id = ?
      AND ref.value IN (SELECT value FROM json_each(?))`)
      .all(conversation, JSON.stringify(ids)) as { id: string }[];
    for (const row of rows) answered.add(JSON.stringify([conversation, row.id]));
  }
  const refs = items.map((item) => ({
    sessionId: item.askOrigin.sessionId,
    messageId: item.askOrigin.messageId,
    frontSessionId: frontSessionId(item.conversationId),
  }));
  const rows = db
    .prepare(`SELECT CASE WHEN m.seq IS NULL THEN (SELECT send_status FROM sdk_messages
      INDEXED BY idx_sdk_messages_session_uuid
      WHERE session_id = json_extract(ref.value, '$.frontSessionId') AND message_type = 'user'
      AND sdk_uuid = json_extract(ref.value, '$.messageId') AND send_status = 'failed'
      ORDER BY timestamp ASC LIMIT 1) ELSE COALESCE(m.send_status, 'consumed') END AS sendStatus, m.id AS messageDbId,
      s.processing_state AS processing FROM json_each(?) ref
      LEFT JOIN sessions s ON s.id = json_extract(ref.value, '$.sessionId')
      LEFT JOIN sdk_messages m ON m.seq = (SELECT seq FROM sdk_messages
      INDEXED BY idx_sdk_messages_session_uuid
      WHERE session_id = json_extract(ref.value, '$.sessionId') AND message_type = 'user'
      AND sdk_uuid = json_extract(ref.value, '$.messageId') ORDER BY timestamp ASC LIMIT 1)
      ORDER BY CAST(ref.key AS INTEGER)`)
    .all(JSON.stringify(refs)) as Omit<Fact, 'answered'>[];
  return rows.map((row, i) => {
    const item = items[i];
    const retryId = neoDerivedId(`neo-retry:${item.conversationId}:${item.requestId}`);
    const refusal =
      row.sendStatus === 'failed'
        ? readRefusedNeoInput(
            db,
            item.conversationId,
            item.askOrigin.sessionId,
            item.requestId,
            row.messageDbId,
            retryId
          )
        : {};
    return {
      ...row,
      answered: answered.has(JSON.stringify([item.conversationId, item.requestId])),
      ...refusal,
    };
  });
}

function describeMessageStatus(item: Ask, fact: Fact): NeoConversationMessageStatus {
  if (fact.sendStatus === 'failed') return 'failed';
  if (fact.sendStatus === 'consumed') {
    if (fact.answered) return 'answered';
    const state = parseProcessingState(fact.processing);
    return state.status === 'processing' &&
      state.messageId === item.askOrigin.messageId &&
      typeof state.phase === 'string' &&
      state.phase !== 'initializing'
      ? 'working'
      : 'read';
  }
  return fact.sendStatus === 'deferred' ||
    fact.sendStatus === 'enqueued' ||
    fact.sendStatus === 'submitted'
    ? 'queued'
    : 'received';
}

function presentMessageStatuses<T extends Ask>(items: readonly T[], facts: readonly Fact[]): T[] {
  return items.map((item, index) => {
    const messageStatus = describeMessageStatus(item, facts[index]);
    return {
      ...item,
      askOrigin: { ...item.askOrigin, messageDbId: facts[index].messageDbId },
      messageStatus,
      ...(messageStatus === 'failed'
        ? {
            delivery: {
              state: 'failed' as const,
              ...(facts[index].reason ? { reason: facts[index].reason } : {}),
              ...(facts[index].supersededBy ? { supersededBy: facts[index].supersededBy } : {}),
            },
          }
        : {}),
    };
  });
}

export const readNeoMessageStatuses = (superpipe({})('neo-message-statuses') as PipelineAPI)
  .input(['readFacts', 'items'])
  .pipe(
    (readFacts: (refs: NeoMessageStatusRef[]) => Promise<Fact[]>, items: readonly Ask[]) =>
      readFacts(
        items.map(({ conversationId, requestId, askOrigin }) => ({
          conversationId,
          requestId,
          askOrigin,
        }))
      ),
    ['readFacts', 'items'],
    'facts'
  )
  .pipe(presentMessageStatuses, ['items', 'facts'], 'items')
  .endAsync('items') as <T extends Ask>(
  readFacts: (refs: NeoMessageStatusRef[]) => Promise<Fact[]>,
  items: readonly T[]
) => Promise<T[]>;
