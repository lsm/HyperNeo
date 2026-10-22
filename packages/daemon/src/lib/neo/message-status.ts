import type {
  NeoConversationAsk,
  NeoConversationAskPageItem,
  NeoConversationMessageStatus,
} from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { parseProcessingState } from '../session/space-session-reads.ts';

type Ask = NeoConversationAsk | NeoConversationAskPageItem;
type Fact = { sendStatus: string | null; processing: string | null; answered: boolean };
export type NeoMessageStatusPresenter = <T extends Ask>(items: readonly T[]) => T[];

function readMessageFacts(db: Database, items: readonly Ask[]): Fact[] {
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
  }));
  const rows = db
    .prepare(`SELECT (SELECT COALESCE(send_status, 'consumed') FROM sdk_messages
      INDEXED BY idx_sdk_messages_session_uuid
      WHERE session_id = json_extract(ref.value, '$.sessionId') AND message_type = 'user'
      AND sdk_uuid = json_extract(ref.value, '$.messageId') ORDER BY timestamp ASC LIMIT 1) AS sendStatus,
      s.processing_state AS processing FROM json_each(?) ref LEFT JOIN sessions s
      ON s.id = json_extract(ref.value, '$.sessionId') ORDER BY CAST(ref.key AS INTEGER)`)
    .all(JSON.stringify(refs)) as Omit<Fact, 'answered'>[];
  return rows.map((row, i) => ({
    ...row,
    answered: answered.has(JSON.stringify([items[i].conversationId, items[i].requestId])),
  }));
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
      messageStatus,
      ...(messageStatus === 'failed' ? { delivery: { state: 'failed' as const } } : {}),
    };
  });
}

export const readNeoMessageStatuses = (superpipe({})('neo-message-statuses') as PipelineAPI)
  .input(['db', 'items'])
  .pipe(readMessageFacts, ['db', 'items'], 'facts')
  .pipe(presentMessageStatuses, ['items', 'facts'], 'items')
  .end('items') as <T extends Ask>(db: Database, items: readonly T[]) => T[];
