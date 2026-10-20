import { afterEach, beforeEach, expect, test } from 'bun:test';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader';
import { NeoConversationWakeRepository } from '../../../../src/storage/repositories/neo-conversation-wake-repository';
import { createTestDb, createTestSession } from '../../../helpers/database';

const conversationId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
const at = Date.parse('2026-10-20T00:00:00.000Z');
let db: Awaited<ReturnType<typeof createTestDb>>;
let wakes: NeoConversationWakeRepository;
beforeEach(async () => {
  db = await createTestDb();
  for (const id of [conversationId, foreignId]) db.createSession(createTestSession(`neo:${id}`));
  wakes = new NeoConversationWakeRepository(db.getDatabase());
});
afterEach(() => db.close());
function put(
  id: string,
  offset = 0,
  options: { conversationId?: string; trigger?: string; type?: string; origin?: string } = {}
) {
  const session = `neo:${options.conversationId ?? conversationId}`;
  const raw = db.getDatabase();
  raw
    .prepare(
      'INSERT INTO sdk_messages (id,session_id,message_type,sdk_uuid,sdk_message,timestamp,consumed_seq) VALUES (?,?,?,?,?,?,?)'
    )
    .run(
      `${session}:${id}`,
      session,
      options.type ?? 'user',
      id,
      JSON.stringify({ type: options.type ?? 'user', uuid: id }),
      new Date(at + offset).toISOString(),
      offset + 1
    );
  raw
    .prepare(
      'INSERT INTO neo_input_origins (session_id,message_id,origin_session_id,origin_message_id,stamped_at,trigger_id) VALUES (?,?,?,?,?,?)'
    )
    .run(
      session,
      id,
      options.origin ?? session,
      id,
      at + offset,
      options.trigger ??
        `scheduled_wake:${JSON.stringify({ scheduleId: id, sourceKind: 'schedule', sourceId: id })}`
    );
}

test('an empty wake view excludes human, malformed, forwarded, non-user and foreign origins', () => {
  put('human', 0, { trigger: 'human:human' });
  put('malformed', 0, { trigger: 'scheduled_wake:{invalid' });
  put('forwarded', 0, { origin: `neo:${foreignId}` });
  put('assistant', 0, { type: 'assistant' });
  put('foreign', 0, { conversationId: foreignId });
  db.getDatabase()
    .prepare('INSERT INTO neo_input_origins VALUES (?,?,?,?,?,?)')
    .run(
      `neo:${conversationId}`,
      'orphan',
      `neo:${conversationId}`,
      'orphan',
      at,
      'scheduled_wake:{}'
    );
  expect(wakes.latest(conversationId, 10)).toEqual([]);
  expect(
    new NeoConversationReader(db.getDatabase()).read({ conversationId, limit: 10 }).items
  ).toEqual([]);
  expect(wakes.latest(foreignId, 10).map((w) => w.scheduleId)).toEqual(['foreign']);
});

test('latest and both cursor directions retain timestamp/SDK-sequence ordering and conversation scope', () => {
  put('first');
  put('second', 100);
  put('third', 100);
  put('foreign', 1000, { conversationId: foreignId });
  expect(wakes.latest(conversationId, 2).map((w) => w.scheduleId)).toEqual(['second', 'third']);
  expect(wakes.get(conversationId, 'second')).toMatchObject({
    scheduleId: 'second',
    firedAt: at + 100,
    title: 'Scheduled check-in',
    settledAt: null,
    summary: null,
    additions: [],
  });
  expect(wakes.get(foreignId, 'second')).toBeNull();
  const reader = new NeoConversationReader(db.getDatabase());
  const all = reader.read({ conversationId, limit: 10 }).items;
  expect(all.map((item) => (item.role === 'wake' ? item.wake.scheduleId : null))).toEqual([
    'first',
    'second',
    'third',
  ]);
  const latest = reader.read({ conversationId, limit: 1 });
  const previous = reader.read({ conversationId, limit: 1, before: latest.nextBefore! });
  expect(previous.items).toEqual([all[1]]);
  expect(reader.read({ conversationId, limit: 1, after: previous.nextAfter! }).items).toEqual([
    all[2],
  ]);
});
