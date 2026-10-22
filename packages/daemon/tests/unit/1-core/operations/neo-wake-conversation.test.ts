import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { seedNeoWake } from '../../../helpers/neo-wake-corpus.ts';
import { NeoConversationWakeRepository } from '../../../../src/storage/repositories/neo-conversation-wake-repository.ts';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createNeoConversationReadOperation } from '../../../../src/lib/neo/conversation-read-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';

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
  test('root status updates notify snapshot readers while other sessions do not', async () => {
    const events = new InternalEventBus<DaemonInternalEventMap>();
    const changed: string[] = [];
    const service = new NeoService(
      db,
      {} as never,
      {
        event: (name: string) => {
          if (name === 'neo.changed') changed.push(name);
        },
      } as never,
      events
    );
    try {
      for (const target of [sessionId, sessionId, 'other']) {
        await events.publish('session.updated', {
          sessionId: target,
          processingState: { status: 'processing' } as never,
        });
      }
      expect(changed).toEqual(['neo.changed', 'neo.changed']);
      await events.publish('session.updated', {
        sessionId,
        processingState: { status: 'idle' } as never,
      });
      expect(changed).toEqual(['neo.changed', 'neo.changed', 'neo.changed']);
    } finally {
      service.dispose();
    }
  });
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

  test('a separately allocated terminal settles its consumed wake without additions', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId, false);
    const reader = new NeoConversationReader(db.getDatabase());
    const read = () =>
      reader.read({ conversationId, limit: 100 }).items.find((item) => item.role === 'wake');
    const cursor = read()!.cursor;
    expect(read()).toMatchObject({ wake: { settledAt: null, summary: null, additions: [] } });
    const result = fixture.finish();
    expect(result.consumed).toBeGreaterThan(fixture.input.consumed);
    db.getDatabase()
      .prepare('UPDATE sdk_messages SET timestamp = ? WHERE sdk_uuid = ?')
      .run(result.timestamp, fixture.messageId);
    expect(read()).toMatchObject({
      wake: {
        settledAt: Date.parse(result.timestamp),
        summary: 'Guide cycle complete.',
        additions: [],
      },
    });
    expect(read()!.cursor).toEqual(cursor);
    db.getDatabase().exec('UPDATE sessions SET processing_state = \'{"status":"processing"}\'');
    expect(read()).toMatchObject({ wake: { settledAt: Date.parse(result.timestamp) } });
  });

  test('a terminal after the next consumed input cannot settle an earlier wake', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId, false);
    const next = fixture.nextInput();
    const terminal = fixture.finish('Only the later input finished.');
    expect(next.consumed).toBeGreaterThan(fixture.input.consumed);
    expect(terminal.consumed).toBeGreaterThan(next.consumed);
    const reader = new NeoConversationReader(db.getDatabase());
    expect(
      reader.read({ conversationId, limit: 100 }).items.find((item) => item.role === 'wake')
    ).toMatchObject({
      wake: { settledAt: null, summary: null, additions: [] },
    });
  });

  test('later turns do not replace an already settled wake summary', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId, false);
    const terminal = fixture.finish();
    fixture.nextInput();
    fixture.finish('An unrelated later summary.');
    const reader = new NeoConversationReader(db.getDatabase());
    expect(
      reader.read({ conversationId, limit: 100 }).items.find((item) => item.role === 'wake')
    ).toMatchObject({
      wake: { settledAt: Date.parse(terminal.timestamp), summary: 'Guide cycle complete.' },
    });
  });

  test('inherited question and recovery triggers do not create extra wake rows', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId);
    fixture.continuation('neo-question:answered');
    fixture.continuation(`restart-recovery:${fixture.messageId}`);
    const reader = new NeoConversationReader(db.getDatabase());
    expect(
      reader.read({ conversationId, limit: 100 }).items.filter((row) => row.role === 'wake')
    ).toHaveLength(1);
    expect(
      new NeoConversationWakeRepository(db.getDatabase()).latest(conversationId, 30)
    ).toHaveLength(1);
  });

  test('a recovered wake settles through its recorded origin without creating a new wake', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId, false);
    fixture.continuation(`restart-recovery:${fixture.messageId}`);
    const terminal = fixture.finish();
    const wakes = new NeoConversationReader(db.getDatabase())
      .read({ conversationId, limit: 100 })
      .items.filter((row) => row.role === 'wake');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      wake: { settledAt: Date.parse(terminal.timestamp), summary: 'Guide cycle complete.' },
    });
  });

  test('a terminal bound to the wake settles it after a steered input', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId, false);
    fixture.nextInput(true);
    const terminal = fixture.finish();
    expect(
      new NeoConversationWakeRepository(db.getDatabase()).get(conversationId, fixture.messageId)
    ).toMatchObject({
      settledAt: Date.parse(terminal.timestamp),
      summary: 'Guide cycle complete.',
    });
  });

  test('unstamped results use the next independent input as a conservative boundary', () => {
    const first = seedNeoWake(db.getDatabase(), conversationId, false);
    const terminal = first.finish('Unstamped close.', false);
    const unfinished = seedNeoWake(db.getDatabase(), conversationId, false);
    unfinished.nextInput();
    unfinished.finish('Other input.', false);
    const wakes = new NeoConversationWakeRepository(db.getDatabase());
    expect(wakes.get(conversationId, first.messageId)).toMatchObject({
      settledAt: Date.parse(terminal.timestamp),
      summary: 'Unstamped close.',
    });
    expect(wakes.get(conversationId, unfinished.messageId)).toMatchObject({
      settledAt: null,
      summary: null,
    });
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
      .prepare('UPDATE session_schedule_wakes SET fired_at = ?')
      .run(Date.parse('2026-10-20T12:00:00.000Z'));
    db.getDatabase()
      .prepare(
        'INSERT INTO session_schedule_wakes(session_id,message_id,fired_at,metadata_json) VALUES (?,?,?,?)'
      )
      .run(
        sessionId,
        'not-delivered',
        Date.now(),
        '{"scheduleId":"skip","sourceKind":"goal","sourceId":"skip"}'
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

  test('compaction and intercepted recovery results do not settle a working wake', () => {
    const fixture = seedNeoWake(db.getDatabase(), conversationId, false);
    const reader = new NeoConversationReader(db.getDatabase());
    const read = () =>
      reader.read({ conversationId, limit: 100 }).items.find((item) => item.role === 'wake');
    const compaction = fixture.finish();
    db.getSDKMessageRepo().markResultInternalCompactionTurn(sessionId, compaction.uuid);
    expect(read()).toMatchObject({ wake: { settledAt: null, summary: null } });
    const intercepted = fixture.finish();
    db.getSDKMessageRepo().markResultRecoveryIntercepted(sessionId, intercepted.uuid);
    expect(read()).toMatchObject({ wake: { settledAt: null, summary: null } });
    const terminal = fixture.finish();
    expect(read()).toMatchObject({
      wake: { settledAt: Date.parse(terminal.timestamp), summary: 'Guide cycle complete.' },
    });
  });
});
