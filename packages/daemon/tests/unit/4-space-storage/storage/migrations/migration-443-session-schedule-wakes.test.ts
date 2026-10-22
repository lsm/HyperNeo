import { expect, test } from 'bun:test';
import { createTestDb, createTestSession } from '../../../../helpers/database.ts';
import { seedNeoWake } from '../../../../helpers/neo-wake-corpus.ts';
import { NeoConversationReader } from '../../../../../src/storage/repositories/neo-conversation-reader.ts';
import { runMigration339 } from '../../../../../src/storage/schema/m339-neo-input-origins.ts';
import { runMigration377 } from '../../../../../src/storage/schema/m377-neo-input-origin-trigger.ts';
import { runMigration443 } from '../../../../../src/storage/schema/m443-session-schedule-wakes.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;

test('retired attribution upgrades preserve wake history and legacy publications on repeated startup', async () => {
  const db = await createTestDb();
  try {
    db.createSession(createTestSession(sessionId));
    const raw = db.getDatabase();
    const wake = seedNeoWake(raw, conversationId);
    wake.finish();
    const reader = new NeoConversationReader(raw);
    const before = await reader.read({ conversationId, limit: 100 });
    runMigration339(raw);
    runMigration377(raw);
    raw.exec(`INSERT INTO neo_input_origins
      SELECT session_id, message_id, session_id, message_id, fired_at,
        'scheduled_wake:' || metadata_json FROM session_schedule_wakes;
      DELETE FROM session_schedule_wakes`);
    const put = raw.prepare('INSERT INTO neo_input_origins VALUES (?, ?, ?, ?, ?, ?)');
    put.run(sessionId, 'human', sessionId, 'human', 1, 'human:human');
    put.run(sessionId, 'continuation', sessionId, wake.messageId, 2, 'scheduled_wake:{}');
    put.run(sessionId, 'malformed', sessionId, 'malformed', 3, 'scheduled_wake:{bad');
    const retired = raw.prepare('SELECT * FROM neo_input_origins ORDER BY message_id').all();
    runMigration443(raw);
    runMigration443(raw);
    expect(await reader.read({ conversationId, limit: 100 })).toEqual(before);
    expect(raw.prepare('SELECT message_id FROM session_schedule_wakes').all()).toEqual([
      { message_id: wake.messageId },
    ]);
    expect(raw.prepare('SELECT * FROM neo_input_origins ORDER BY message_id').all()).toEqual(
      retired
    );
    expect(
      before.items.some(
        (item) => item.role === 'neo' && item.publication.askOrigin?.messageId === wake.messageId
      )
    ).toBe(true);
  } finally {
    db.close();
  }
});

test('legacy unstamped results keep their recorded continuation boundary after upgrade', async () => {
  const db = await createTestDb();
  try {
    db.createSession(createTestSession(sessionId));
    const raw = db.getDatabase();
    const wake = seedNeoWake(raw, conversationId, false);
    const continuation = 'legacy-question-continuation';
    wake.continuation(continuation);
    const terminal = wake.finish('Saved legacy summary.', false);
    runMigration339(raw);
    runMigration377(raw);
    raw.exec(`INSERT INTO neo_input_origins
      SELECT session_id, message_id, session_id, message_id, fired_at,
        'scheduled_wake:' || metadata_json FROM session_schedule_wakes;
      DELETE FROM session_schedule_wakes`);
    raw
      .prepare('INSERT INTO neo_input_origins VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, continuation, sessionId, wake.messageId, 2, 'scheduled_wake:{}');
    const retired = raw.prepare('SELECT * FROM neo_input_origins ORDER BY message_id').all();
    runMigration443(raw);
    const items = (await new NeoConversationReader(raw).read({ conversationId, limit: 100 })).items;
    expect(items).toEqual([
      expect.objectContaining({
        role: 'wake',
        wake: expect.objectContaining({
          settledAt: Date.parse(terminal.timestamp),
          summary: 'Saved legacy summary.',
        }),
      }),
    ]);
    expect(raw.prepare('SELECT * FROM neo_input_origins ORDER BY message_id').all()).toEqual(
      retired
    );
  } finally {
    db.close();
  }
});
