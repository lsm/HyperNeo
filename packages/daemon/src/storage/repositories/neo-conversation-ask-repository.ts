import type {
  NeoConversationAsk,
  NeoConversationAskAppendResult,
  NeoConversationAskInput,
} from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { admitNeoConversationAsk } from '../../lib/neo/conversation-ask.ts';
import {
  ensurePrompt,
  PromptContentConflictError,
  type PromptHold,
} from '../../lib/agent/message-delivery-outbox.ts';
import type { JobQueueRepository } from './job-queue-repository.ts';
import type { SDKMessageRepository } from './sdk-message-repository.ts';
import type { Database } from '../sqlite-compat.ts';

type Row = { sequence: number; payloadJson: string; createdAt: string };
type IntakePrompt = SDKUserMessage & { inputKind?: unknown };
const columns = 'sequence, payload_json AS payloadJson, created_at AS createdAt';
const page = z.object({
  conversationId: z.uuid(),
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
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
          .prepare(
            input.before === undefined
              ? `SELECT ${columns} FROM neo_conversation_asks
      WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`
              : `SELECT * FROM (SELECT ${columns} FROM neo_conversation_asks
      WHERE conversation_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence`
          )
          .all(input.conversationId, input.before ?? input.after, input.limit) as Row[]
      ).map(decode),
    ['db', 'asks'],
    'asks'
  )
  .end('asks') as (input: unknown, db: Database) => NeoConversationAsk[] | null;

export function prepareNeoIntakeAsk(conversationId: string, message: IntakePrompt) {
  if (message.type !== 'user' || message.inputKind !== 'human')
    return { reason: { accepted: false as const, reason: 'invalid_ask' as const } };
  const admitted = admitNeoConversationAsk({
    conversationId,
    requestId: message.uuid,
    askOrigin: { sessionId: message.session_id, messageId: message.uuid },
    content: message.message.content,
  });
  return 'value' in admitted
    ? admitted
    : { reason: { accepted: false as const, reason: 'invalid_ask' as const } };
}

function commitNeoIntake(
  ask: NeoConversationAskInput,
  message: IntakePrompt,
  hold: PromptHold,
  db: Database,
  ledger: NeoConversationAskRepository,
  sdkMessageRepo: SDKMessageRepository,
  jobQueue: JobQueueRepository
): NeoConversationAskAppendResult {
  const active = 'inTransaction' in db ? Boolean(db.inTransaction) : db.isTransaction;
  if (active) throw new Error('Public ask intake must own its commit boundary');
  let publish = () => {};
  const receipt = db.transaction(() => {
    const stored = ledger.append(ask);
    if (!stored.accepted) return stored;
    if (
      !stored.created &&
      sdkMessageRepo.getDeliveryMessageIdsByUuids(ask.askOrigin.sessionId, [ask.requestId])
        .length === 0
    )
      return { ...stored, created: false };
    const prompt = ensurePrompt({
      db,
      sdkMessageRepo,
      jobQueue,
      sessionId: ask.askOrigin.sessionId,
      message,
      hold,
      delivery: { origin: 'chat' },
      deferPostSaveSideEffects: (effect) => {
        publish = effect;
      },
    });
    return { ...stored, created: prompt.created };
  })();
  try {
    publish();
  } catch {}
  return receipt;
}

const acceptPrompt = (superpipe({})('neo-public-ask-intake') as PipelineAPI)
  .input(['conversationId', 'message', 'hold', 'db', 'ledger', 'sdkMessageRepo', 'jobQueue'])
  .pipe(prepareNeoIntakeAsk, ['conversationId', 'message'], 'result:receipt')
  .pipe(
    commitNeoIntake,
    ['receipt', 'message', 'hold', 'db', 'ledger', 'sdkMessageRepo', 'jobQueue'],
    'receipt'
  )
  .end('receipt') as (
  conversationId: string,
  message: IntakePrompt,
  hold: PromptHold,
  db: Database,
  ledger: NeoConversationAskRepository,
  sdkMessageRepo: SDKMessageRepository,
  jobQueue: JobQueueRepository
) => NeoConversationAskAppendResult;

export class NeoConversationAskRepository {
  constructor(private readonly db: Database) {}

  append(input: unknown): NeoConversationAskAppendResult {
    const result = append(input, this.db);
    return result === 'invalid_ask' ? { accepted: false, reason: result } : result;
  }

  list(
    conversationId: string,
    after = 0,
    limit = 50,
    before?: number
  ): NeoConversationAsk[] | null {
    return read({ conversationId, after, limit, before }, this.db);
  }

  newestFrom(conversationId: string, sessionId: string): NeoConversationAsk | null {
    const row = this.db
      .prepare(`SELECT ${columns} FROM neo_conversation_asks
      WHERE conversation_id = ? AND json_extract(payload_json, '$.askOrigin.sessionId') = ?
      ORDER BY sequence DESC LIMIT 1`)
      .get(conversationId, sessionId) as Row | null;
    return row ? decode(row) : null;
  }

  acceptPrompt(
    conversationId: string,
    message: IntakePrompt,
    hold: PromptHold,
    sdkMessageRepo: SDKMessageRepository,
    jobQueue: JobQueueRepository
  ): NeoConversationAskAppendResult {
    try {
      return acceptPrompt(conversationId, message, hold, this.db, this, sdkMessageRepo, jobQueue);
    } catch (error) {
      if (error instanceof PromptContentConflictError)
        return { accepted: false, reason: 'ask_conflict' };
      throw error;
    }
  }
}
