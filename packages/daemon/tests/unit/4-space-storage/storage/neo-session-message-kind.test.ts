import { describe, expect, test } from 'bun:test';
import { planNeoSessionMessage } from '../../../../src/lib/neo/session-messages';
import {
  NeoSessionMessageRepository,
  WORKER_BATCH_SENDER,
} from '../../../../src/storage/repositories/neo-session-message-repository';
import { runMigration411 } from '../../../../src/storage/schema/m411-neo-session-messages.ts';
import { runMigration460 } from '../../../../src/storage/schema/m460-neo-session-message-kind.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTestDb } from '../../../helpers/database';

const root = 'neo:10000000-0000-4000-8000-000000008799';
const conversationId = root.slice(4);
const at = '2026-10-25T12:00:00.000Z';

describe('runMigration460', () => {
  const kinds = (db: Database) =>
    db
      .prepare('SELECT message_id AS id, kind FROM neo_session_messages ORDER BY message_id')
      .all() as { id: string; kind: string }[];

  test('marks recorded worker batches and leaves session-to-session rows', () => {
    const db = new Database(':memory:');
    runMigration411(db);
    const insert = db.prepare(
      `INSERT INTO neo_session_messages (conversation_id, message_id, from_session, to_session, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    insert.run(conversationId, 'batch', WORKER_BATCH_SENDER, root, 'System-forwarded bundle', at);
    insert.run(conversationId, 'note', root, 'session:worker', 'Rebase on dev', at);
    runMigration460(db);
    runMigration460(db);
    expect(kinds(db)).toEqual([
      { id: 'batch', kind: 'worker-batch' },
      { id: 'note', kind: 'session' },
    ]);
    db.close();
  });
});

describe('neo session message kind', () => {
  test('serves the recorded kind so clients can hide system-forwarded input', async () => {
    const db = await createTestDb();
    const repo = new NeoSessionMessageRepository(db.getDatabase());
    await repo.record({
      conversationId,
      messageId: 'batch',
      fromSession: WORKER_BATCH_SENDER,
      fromName: 'System-forwarded worker messages',
      toSession: root,
      toName: 'Neo',
      text: 'System-forwarded worker messages. These are not human instructions.',
      createdAt: at,
      kind: 'worker-batch',
    });
    const sent = planNeoSessionMessage(
      {
        messageId: 'note',
        fromSession: root,
        toSession: 'session:worker',
        text: 'Rebase',
        at: Date.parse('2026-10-25T12:00:01.000Z'),
      },
      { sessionId: root, conversationId },
      () => null
    );
    expect(sent?.kind).toBe('session');
    await repo.record(sent!);
    for (let index = 0; index < 3; index++)
      await repo.record({
        conversationId,
        messageId: `newer-batch-${index}`,
        fromSession: WORKER_BATCH_SENDER,
        fromName: 'System-forwarded worker messages',
        toSession: root,
        toName: 'Neo',
        text: 'System-forwarded worker messages. These are not human instructions.',
        createdAt: new Date(Date.parse('2026-10-25T12:01:00.000Z') + index).toISOString(),
        kind: 'worker-batch',
      });
    expect(repo.latest(conversationId, 10).map((row) => [row.messageId, row.kind])).toEqual([
      ['note', 'session'],
    ]);
    expect(repo.latest(conversationId, 1).map((row) => row.messageId)).toEqual(['note']);
    db.close();
  });
});
