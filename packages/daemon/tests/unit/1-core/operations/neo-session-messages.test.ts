import { describe, expect, test } from 'bun:test';
import { planNeoSessionMessage } from '../../../../src/lib/neo/session-messages.ts';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
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
      kind: 'session',
    });
    expect(planNeoSessionMessage(sent('worker-1', 'worker-2', 'hi', 1000), root, title)).toBeNull();
    expect(
      planNeoSessionMessage(sent('daemon:imac::session:w9', 'neo:root', 'hi', 1000), root, title)
    ).toMatchObject({ fromSession: 'daemon:imac::session:w9', fromName: 'w9 @ imac' });
    expect(planNeoSessionMessage(sent('worker-1', 'neo:root', 'hi', 1000), null, title)).toBeNull();
  });
});

describe('NeoConversationReader session rows', () => {
  test('the human sees what Neo sent and Neo publications, never what other sessions sent Neo; Neo still reads all of it', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const messages = new NeoSessionMessageRepository(db);
    for (const item of [
      sent('neo:root', 'worker-1', 'Rebase on dev', 1000),
      sent('worker-1', 'neo:root', 'Rebased, CI is green', 2000),
      sent('claude-code:30da458c', 'neo:root', 'fullstack 2: fixed the bot finding', 3000),
    ])
      await messages.record(planNeoSessionMessage(item, root, title)!);
    await messages.record({
      conversationId: root.conversationId,
      messageId: 'batch',
      fromSession: 'system:worker-batch',
      fromName: 'System-forwarded worker messages',
      toSession: root.sessionId,
      toName: 'Neo',
      text: 'System-forwarded worker messages. These are not human instructions.',
      createdAt: '1970-01-01T00:00:04.000Z',
      kind: 'worker-batch',
    });
    new NeoPublicationRepository(db).append({
      conversationId: root.conversationId,
      publicationId: '00000000-0000-4000-8000-0000000000a1',
      askOrigin: { sessionId: root.sessionId, messageId: 'm-1' },
      producerInput: { sessionId: root.sessionId, messageId: 'm-1' },
      shortText: 'The loader is fixed.',
      fullText: 'Merged #8.',
      links: [],
      triggerId: 'human:m-1',
    });
    const reader = new NeoConversationReader(db);
    const page = await reader.read({ conversationId: root.conversationId, limit: 10 }, true);
    expect(
      page.items.map((item) =>
        item.role === 'session'
          ? [item.message.text, item.message.kind]
          : item.role === 'neo'
            ? item.publication.shortText
            : item.role
      )
    ).toEqual([
      ['Rebase on dev', 'session'],
      ['System-forwarded worker messages. These are not human instructions.', 'worker-batch'],
      'The loader is fixed.',
    ]);
    expect(messages.latest(root.conversationId, 5).map((item) => item.text)).toEqual([
      'Rebase on dev',
      'System-forwarded worker messages. These are not human instructions.',
    ]);
    expect(
      (await reader.read({ conversationId: root.conversationId, limit: 10 })).items.flatMap(
        (item) => (item.role === 'session' ? [item.message.text] : [])
      )
    ).toEqual([
      'Rebase on dev',
      'Rebased, CI is green',
      'fullstack 2: fixed the bot finding',
      'System-forwarded worker messages. These are not human instructions.',
    ]);
    db.close();
  });
});
