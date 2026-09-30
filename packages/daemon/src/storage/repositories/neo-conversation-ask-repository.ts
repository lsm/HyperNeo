import type {
  NeoConversationAsk,
  NeoConversationAskAppendResult,
  NeoConversationAskInput,
} from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { admitNeoConversationAsk } from '../../lib/neo/conversation-ask.ts';
import type { Database } from '../sqlite-compat.ts';

type Row = { sequence: number; payloadJson: string; createdAt: string };
const columns = 'sequence, payload_json AS payloadJson, created_at AS createdAt';
const page = z.object({
  conversationId: z.uuid(),
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
});

function decode(row: Row): NeoConversationAsk {
  const parsed = admitNeoConversationAsk(JSON.parse(row.payloadJson));
  if ('reason' in parsed) throw new Error('Invalid stored Neo conversation ask');
  return { ...parsed.value, sequence: row.sequence, createdAt: row.createdAt };
}

function appendImmutable(
  db: Database,
  input: NeoConversationAskInput,
  payload: string
): NeoConversationAskAppendResult {
  return db.transaction((): NeoConversationAskAppendResult => {
    const inserted = db
      .prepare(`INSERT INTO neo_conversation_asks(conversation_id, request_id, payload_json, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, request_id) DO NOTHING RETURNING ${columns}`)
      .get(input.conversationId, input.requestId, payload, new Date().toISOString()) as Row | null;
    const row =
      inserted ??
      (db
        .prepare(`SELECT ${columns} FROM neo_conversation_asks
      WHERE conversation_id = ? AND request_id = ?`)
        .get(input.conversationId, input.requestId) as Row | null);
    if (!row) throw new Error('Neo conversation ask append lost its reservation');
    return row.payloadJson === payload
      ? { accepted: true, created: !!inserted, ask: decode(row) }
      : { accepted: false, reason: 'ask_conflict' };
  })();
}

const append = (superpipe({})('neo-conversation-ask-append') as PipelineAPI)
  .input(['input', 'db'])
  .pipe(admitNeoConversationAsk, 'input', 'result:ask')
  .pipe(JSON.stringify, 'ask', 'payload')
  .pipe(appendImmutable, ['db', 'ask', 'payload'], 'ask')
  .end('ask') as (input: unknown, db: Database) => NeoConversationAskAppendResult | 'invalid_ask';

const read = (superpipe({})('neo-conversation-ask-page') as PipelineAPI)
  .input(['input', 'db'])
  .pipe(
    (input: unknown) => {
      const parsed = page.safeParse(input);
      return parsed.success ? { value: parsed.data } : { reason: null };
    },
    'input',
    'result:asks'
  )
  .pipe(
    (db: Database, input: z.infer<typeof page>) =>
      (
        db
          .prepare(`SELECT ${columns} FROM neo_conversation_asks
      WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
          .all(input.conversationId, input.after, input.limit) as Row[]
      ).map(decode),
    ['db', 'asks'],
    'asks'
  )
  .end('asks') as (input: unknown, db: Database) => NeoConversationAsk[] | null;

export class NeoConversationAskRepository {
  constructor(private readonly db: Database) {}

  append(input: unknown): NeoConversationAskAppendResult {
    const result = append(input, this.db);
    return result === 'invalid_ask' ? { accepted: false, reason: result } : result;
  }

  list(conversationId: string, after = 0, limit = 50): NeoConversationAsk[] | null {
    return read({ conversationId, after, limit }, this.db);
  }
}
