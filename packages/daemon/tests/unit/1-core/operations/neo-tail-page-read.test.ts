import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createNeoConversationAskReadOperation } from '../../../../src/lib/neo/conversation-ask-read-operation.ts';
import { createNeoPublicationReadOperation } from '../../../../src/lib/neo/publication-read-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, concernId: null };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const id = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const newest = Number.MAX_SAFE_INTEGER;

function publication(index: number, target = conversationId) {
  return {
    conversationId: target,
    publicationId: id(index),
    askOrigin: { sessionId: root.sessionId, messageId: 'original-ask' },
    producerInput: { sessionId: 'holder:research', messageId: `return-${index}` },
    shortText: `Fictional reply ${index}.`,
    fullText: `Fictional details ${index}.`,
    links: [],
  };
}

function ask(index: number, target = conversationId) {
  return {
    conversationId: target,
    requestId: id(index),
    askOrigin: { sessionId: root.sessionId, messageId: id(index) },
    content: `Fictional ask ${index}.`,
  };
}

const streams = [
  {
    name: 'neo.publication.read',
    seed: (mailbox: MailboxTestDb, count: number, target?: string) => {
      runMigration288(mailbox.db);
      const ledger = new NeoPublicationRepository(mailbox.db);
      for (let index = 1; index <= count; index++)
        expect(ledger.append(publication(index, target)).accepted).toBe(true);
      return (repo: NeoRepository) => createNeoPublicationReadOperation(repo, ledger);
    },
    key: (item: Record<string, unknown>) => item.publicationId,
  },
  {
    name: 'neo.conversation.asks.read',
    seed: (mailbox: MailboxTestDb, count: number, target?: string) => {
      runMigration289(mailbox.db);
      const ledger = new NeoConversationAskRepository(mailbox.db);
      for (let index = 1; index <= count; index++)
        expect(ledger.append(ask(index, target)).accepted).toBe(true);
      return (repo: NeoRepository) => createNeoConversationAskReadOperation(repo, ledger);
    },
    key: (item: Record<string, unknown>) => item.requestId,
  },
];

describe.each(streams)('$name tail pages', ({ name, seed, key }) => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    repo.reserveBinding(root);
  });
  afterEach(() => mailbox.close());

  async function read(count: number, input: Record<string, unknown>, caller = human) {
    const operation = seed(mailbox, count)(repo);
    return invokeOperation(
      createOperationRegistry([operation]),
      name,
      { conversationId, ...input },
      caller
    );
  }
  const page = (result: Awaited<ReturnType<typeof read>>) => {
    if (result.kind !== 'completed') throw new Error(`unexpected ${result.kind}`);
    const value = result.value as { ok: true; items: Record<string, unknown>[]; nextAfter: number };
    return {
      ids: value.items.map(key),
      sequences: value.items.map((item) => item.sequence),
      value,
    };
  };

  test('before the newest sequence returns the latest page in ascending order', async () => {
    const { ids, sequences, value } = page(await read(7, { before: newest, limit: 3 }));
    expect(ids).toEqual([id(5), id(6), id(7)]);
    expect(sequences).toEqual([5, 6, 7]);
    expect(value.nextAfter).toBe(7);
  });

  test('an earlier cursor pages backward without overlap', async () => {
    expect(page(await read(7, { before: 5, limit: 3 })).ids).toEqual([id(2), id(3), id(4)]);
  });

  test('the first page backward is short and ends at the oldest entry', async () => {
    const { ids, value } = page(await read(7, { before: 3, limit: 3 }));
    expect(ids).toEqual([id(1), id(2)]);
    expect(value.nextAfter).toBe(2);
  });

  test('nothing before the first sequence returns an empty page', async () => {
    const { ids, value } = page(await read(3, { before: 1, limit: 3 }));
    expect(ids).toEqual([]);
    expect(value.nextAfter).toBe(0);
  });

  test('an empty conversation tail is empty', async () => {
    expect(page(await read(0, { before: newest })).ids).toEqual([]);
  });

  test('forward reads stay unchanged when before is omitted', async () => {
    const { ids, value } = page(await read(7, { after: 2, limit: 3 }));
    expect(ids).toEqual([id(3), id(4), id(5)]);
    expect(value.nextAfter).toBe(5);
  });

  test('another conversation never leaks into the tail', async () => {
    const operation = seed(mailbox, 4)(repo);
    for (const index of [10, 11]) {
      const ledgerResult =
        name === 'neo.publication.read'
          ? new NeoPublicationRepository(mailbox.db).append(publication(index, foreignId))
          : new NeoConversationAskRepository(mailbox.db).append(ask(index, foreignId));
      expect(ledgerResult.accepted).toBe(true);
    }
    const result = await invokeOperation(
      createOperationRegistry([operation]),
      name,
      { conversationId, before: newest, limit: 3 },
      human
    );
    expect(page(result).ids).toEqual([id(2), id(3), id(4)]);
  });

  test.each([
    { before: 0 },
    { before: -1 },
    { before: 1.5 },
    { before: '9' },
    { before: newest + 1 },
    { after: 2, before: 9 },
  ])('rejects invalid or combined cursors %o', async (input) => {
    expect(await read(3, input)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  });

  test('tail reads keep the human-only gate', async () => {
    expect(await read(3, { before: newest }, { source: 'rpc' })).toEqual({
      kind: 'completed',
      value: { ok: false, reason: 'human_only' },
    });
  });

  test('tail reads keep the root conversation gate', async () => {
    const operation = seed(mailbox, 3)(repo);
    expect(
      await invokeOperation(
        createOperationRegistry([operation]),
        name,
        { conversationId: foreignId, before: newest },
        human
      )
    ).toEqual({ kind: 'completed', value: { ok: false, reason: 'conversation_not_found' } });
  });
});
