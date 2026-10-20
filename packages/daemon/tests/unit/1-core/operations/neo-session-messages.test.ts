import { describe, expect, test } from 'bun:test';
import { planNeoSessionMessage } from '../../../../src/lib/neo/session-messages.ts';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader.ts';
import { NeoSessionMessageRepository } from '../../../../src/storage/repositories/neo-session-message-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const root = { sessionId: 'neo:root', conversationId: '00000000-0000-4000-8000-000000000001' };
const title = (id: string) => ({ 'neo:root': 'Neo', 'worker-1': 'Fix the loader' })[id] ?? null;
const sent = (from: string, to: string, text: string, at: number) => ({
  messageId: `${from}-${at}`,
  fromSession: from,
  toSession: to,
  text,
  at,
});

describe('planNeoSessionMessage', () => {
  test('keeps only messages root Neo sends or receives, with both names', () => {
    expect(
      planNeoSessionMessage(sent('worker-1', 'neo:root', 'PR is up', 1000), root, title)
    ).toEqual({
      conversationId: root.conversationId,
      messageId: 'worker-1-1000',
      fromSession: 'worker-1',
      fromName: 'Fix the loader',
      toSession: 'neo:root',
      toName: 'Neo',
      text: 'PR is up',
      createdAt: '1970-01-01T00:00:01.000Z',
    });
    expect(planNeoSessionMessage(sent('worker-1', 'worker-2', 'hi', 1000), root, title)).toBeNull();
    expect(
      planNeoSessionMessage(sent('daemon:imac::session:w9', 'neo:root', 'hi', 1000), root, title)
    ).toMatchObject({ fromSession: 'daemon:imac::session:w9', fromName: 'w9 @ imac' });
    expect(planNeoSessionMessage(sent('worker-1', 'neo:root', 'hi', 1000), null, title)).toBeNull();
  });
});

describe('NeoConversationReader session rows', () => {
  test('pages the messages root Neo exchanged, oldest first, once each', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const messages = new NeoSessionMessageRepository(db);
    for (const item of [
      sent('neo:root', 'worker-1', 'Rebase on dev', 1000),
      sent('worker-1', 'neo:root', 'Rebased, CI is green', 2000),
      sent('worker-1', 'neo:root', 'Rebased, CI is green', 2000),
    ])
      messages.record(planNeoSessionMessage(item, root, title)!);
    const reader = new NeoConversationReader(db);
    const first = reader.read({ conversationId: root.conversationId, limit: 1 });
    expect(first.items).toMatchObject([
      {
        role: 'session',
        message: { fromName: 'Fix the loader', toName: 'Neo', text: 'Rebased, CI is green' },
      },
    ]);
    const earlier = reader.read({
      conversationId: root.conversationId,
      before: first.nextBefore!,
      limit: 5,
    });
    expect(earlier.items).toMatchObject([
      { role: 'session', message: { fromName: 'Neo', text: 'Rebase on dev' } },
    ]);
    expect(messages.latest(root.conversationId, 5).map((item) => item.text)).toEqual([
      'Rebase on dev',
      'Rebased, CI is green',
    ]);
    db.close();
  });
});
