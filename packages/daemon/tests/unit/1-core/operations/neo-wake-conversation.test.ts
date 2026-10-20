import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { seedNeoWake } from '../../../helpers/neo-wake-corpus.ts';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createNeoConversationReadOperation } from '../../../../src/lib/neo/conversation-read-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

const conversationId = '10000000-0000-4000-8000-000000000005';
const sessionId = `neo:${conversationId}`;
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession(sessionId));
  new NeoRepository(db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
});
afterEach(() => db.close());

describe('scheduled wakes in the public conversation', () => {
  test('delivered system input produces one wake with exact-origin additions and no raw prompt', async () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId);
    const repo = new NeoRepository(db.getDatabase());
    const reader = new NeoConversationReader(db.getDatabase());
    const operation = createNeoConversationReadOperation(repo, reader);
    const result = await invokeOperation(
      createOperationRegistry([operation]),
      'neo.conversation.read',
      { conversationId },
      { source: 'rpc', principal: 'local' }
    );
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Read failed');
    expect(operation.resultSchema.safeParse(result.value).success).toBe(true);
    const wakes = (result.value as ReturnType<NeoConversationReader['read']>).items.filter(
      (item) => item.role === 'wake'
    );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      role: 'wake',
      cursor: { role: 'wake', sequence: fixture.input.seq },
      wake: {
        scheduleId: fixture.scheduleId,
        sourceKind: 'goal',
        sourceId: fixture.goal.id,
        title: fixture.goal.title,
        settledAt: null,
        summary: null,
        additions: fixture.expected,
      },
    });
    expect(JSON.stringify(wakes)).not.toContain('PRIVATE_WAKE_INSTRUCTIONS');
    expect(JSON.stringify(wakes)).not.toContain('Not from this wake');
  });

  test('only the shared consumed_seq terminal settles a wake, including a no-additions run', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId, false);
    fixture.finish(false, 'Later turn must not settle the wake.');
    const reader = new NeoConversationReader(db.getDatabase());
    const read = () =>
      reader.read({ conversationId, limit: 100 }).items.find((item) => item.role === 'wake');
    expect(read()).toMatchObject({ wake: { settledAt: null, summary: null, additions: [] } });
    const result = fixture.finish();
    expect(read()).toMatchObject({
      wake: {
        settledAt: Date.parse(result.timestamp),
        summary: 'Guide cycle complete.',
        additions: [],
      },
    });
    db.getDatabase().exec('UPDATE sessions SET processing_state = \'{"status":"processing"}\'');
    expect(read()).toMatchObject({ wake: { settledAt: Date.parse(result.timestamp) } });
  });

  test('equal-time wakes page both ways and exclude other sessions, skips and undelivered origins', () => {
    const foreign = '10000000-0000-4000-8000-000000000006';
    db.createSession(createTestSession(`neo:${foreign}`));
    seedNeoWake(db.getDatabase(), foreign, false);
    for (let i = 0; i < 4; i++) seedNeoWake(db.getDatabase(), conversationId, false);
    db.getDatabase()
      .prepare("UPDATE sdk_messages SET timestamp = ? WHERE message_type = 'user'")
      .run('2026-10-20T12:00:00.000Z');
    db.getDatabase()
      .prepare(
        'INSERT INTO neo_input_origins(session_id,message_id,origin_session_id,origin_message_id,stamped_at,trigger_id) VALUES (?,?,?,?,?,?)'
      )
      .run(
        sessionId,
        'not-delivered',
        sessionId,
        'not-delivered',
        Date.now(),
        'scheduled_wake:{"scheduleId":"skip","sourceKind":"goal","sourceId":"skip"}'
      );
    const reader = new NeoConversationReader(db.getDatabase());
    const full = reader.read({ conversationId, limit: 100 }).items;
    expect(full).toHaveLength(4);
    expect(full.every((item) => item.role === 'wake')).toBe(true);
    const last = reader.read({ conversationId, limit: 2 });
    const first = reader.read({ conversationId, limit: 2, before: last.nextBefore! });
    expect([...first.items, ...last.items]).toEqual(full);
    expect(reader.read({ conversationId, limit: 2, after: first.nextAfter! }).items).toEqual(
      last.items
    );
  });
});
