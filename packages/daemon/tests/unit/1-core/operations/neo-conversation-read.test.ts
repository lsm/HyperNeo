import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { NeoConversationReader } from '../../../../src/storage/repositories/neo-conversation-reader.ts';
import {
  createNeoConversationReadOperation,
  requireNeoConversationReader,
} from '../../../../src/lib/neo/conversation-read-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, projectId: null };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const neo: OperationCaller = {
  source: 'mcp',
  role: 'neo',
  sessionId: root.sessionId,
};
const image = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
};

describe('neo.conversation.read', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repo: NeoRepository;
  let reader: NeoConversationReader;
  const ask = (n: number, target = conversationId) => {
    const id = `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const result = new NeoConversationAskRepository(db.getDatabase()).append({
      conversationId: target,
      requestId: id,
      askOrigin: { sessionId: root.sessionId, messageId: id },
      content: [{ type: 'text', text: `  My original words ${n}.\n第二行。` }, image],
    });
    if (!result.accepted) throw new Error('human fixture rejected');
    return result.ask;
  };
  const publish = (n: number, target = conversationId) => {
    const result = new NeoPublicationRepository(db.getDatabase()).append({
      conversationId: target,
      publicationId: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      askOrigin: { sessionId: root.sessionId, messageId: 'human' },
      producerInput: { sessionId: root.sessionId, messageId: `input-${n}` },
      shortText: `Reply ${n}.`,
      fullText: `Full original answer ${n}.`,
      links: [],
    });
    if (!result.accepted) throw new Error('publication fixture rejected');
    return result.publication;
  };
  const read = (input: unknown = { conversationId }, caller = neo) =>
    invokeOperation(
      createOperationRegistry([createNeoConversationReadOperation(repo, reader)]),
      'neo.conversation.read',
      input,
      caller
    );
  beforeEach(async () => {
    db = await createTestDb();
    await db.createSession(createTestSession(root.sessionId));
    repo = new NeoRepository(db.getDatabase());
    repo.reserveBinding(root);
    reader = new NeoConversationReader(db.getDatabase());
  });
  afterEach(() => db.close());

  test('returns original human words, attribution and image references with full Neo replies', async () => {
    const storedAsk = ask(1);
    const storedReply = publish(1);
    const rows = await reader.read({ conversationId, limit: 50 });
    expect(rows.items.map((item) => item.role)).toEqual(['human', 'neo']);
    expect(rows.items[0]).toMatchObject({
      role: 'human',
      ask: {
        askOrigin: storedAsk.askOrigin,
        requestId: storedAsk.requestId,
        content: [
          { type: 'text', text: '  My original words 1.\n第二行。' },
          { type: 'image_ref', imageId: `${storedAsk.sequence}:1`, mediaType: 'image/png' },
        ],
      },
    });
    expect(JSON.stringify(rows)).not.toContain('aGVsbG8=');
    expect(rows.items[1]).toMatchObject({ role: 'neo', publication: storedReply });
    for (const caller of [neo, human]) {
      expect(await read({ conversationId }, caller)).toEqual({
        kind: 'completed',
        value: { ok: true, conversationId, ...rows },
      });
    }
  });

  test('pages both directions without losing equal-timestamp entries or mixing conversations', async () => {
    for (let n = 1; n <= 5; n++) {
      ask(n);
      publish(n);
    }
    ask(6, foreignId);
    publish(6, foreignId);
    for (const table of ['neo_conversation_asks', 'neo_publications'])
      db.getDatabase()
        .prepare(`UPDATE ${table} SET created_at = ?`)
        .run('2026-10-16T10:00:00.000Z');
    const complete = (await reader.read({ conversationId, limit: 100 })).items;
    expect(complete).toHaveLength(10);
    expect(new Set(complete.map((item) => JSON.stringify(item.cursor))).size).toBe(10);
    let backwards = await reader.read({ conversationId, limit: 2 });
    const collected = [...backwards.items];
    while (backwards.items.length) {
      backwards = await reader.read({ conversationId, limit: 2, before: backwards.nextBefore! });
      collected.unshift(...backwards.items);
    }
    expect(collected).toEqual(complete);
    let forwards = await reader.read({ conversationId, limit: 2, after: complete[0].cursor });
    const later = [...forwards.items];
    while (forwards.items.length) {
      forwards = await reader.read({ conversationId, limit: 2, after: forwards.nextAfter! });
      later.push(...forwards.items);
    }
    expect(later).toEqual(complete.slice(1));
  });

  test('can read historical full text and revision history outside the injected seven', async () => {
    const first = publish(1);
    const revised = new NeoPublicationRepository(db.getDatabase()).edit(
      conversationId,
      first.publicationId,
      { fullText: 'Revised full details.' },
      '2026-10-16T13:00:00.000Z',
      root.sessionId,
      { sessionId: root.sessionId, messageId: 'revision' },
      '40000000-0000-4000-8000-000000000001'
    );
    expect(revised.accepted).toBe(true);
    for (let n = 2; n <= 12; n++) publish(n);
    const full = (await reader.read({ conversationId, limit: 100 })).items;
    expect(full[0]).toMatchObject({
      role: 'neo',
      publication: {
        publicationId: first.publicationId,
        fullText: 'Revised full details.',
        revisions: [{ fullText: 'Full original answer 1.' }],
      },
    });
    expect(await read({ conversationId, limit: 100 })).toMatchObject({
      kind: 'completed',
      value: { items: full },
    });
  });

  test.each([
    { source: 'rpc' },
    { source: 'internal', role: 'neo' },
    { ...neo, role: 'universal_read' },
    { ...neo, sessionId: 'neo:unbound' },
  ] as OperationCaller[])(
    'rejects unauthorized callers before reading history: %o',
    async (caller) => {
      const spy = vi.spyOn(reader, 'read');
      expect(await read({ conversationId }, caller)).toMatchObject({
        kind: 'completed',
        value: { ok: false, reason: 'reader_not_authorized' },
      });
      expect(spy).not.toHaveBeenCalled();
    }
  );

  test('refuses a foreign or missing conversation without a ledger read', async () => {
    const spy = vi.spyOn(reader, 'read');
    expect(await read({ conversationId: foreignId })).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'conversation_not_found' },
    });
    db.getDatabase().exec('DELETE FROM neo_conversation; DELETE FROM neo_session_bindings');
    expect(await read({ conversationId }, human)).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'conversation_not_found' },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { sessionId: root.sessionId },
    { after: { at: 'wrong', role: 'human', sequence: 1 } },
    { after: { at: '2026-10-16T10:00:00.000Z', role: 'tool', sequence: 1 } },
    { after: { at: '2026-10-16T10:00:00.000Z', role: 'human', sequence: 0 } },
    {
      after: { at: '2026-10-16T10:00:00.000Z', role: 'human', sequence: 1 },
      before: { at: '2026-10-16T10:00:00.000Z', role: 'human', sequence: 2 },
    },
  ])('rejects malformed bounds or cursors: %o', async (extra) => {
    const spy = vi.spyOn(reader, 'read');
    expect(await read({ conversationId, ...extra })).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  test('invalid stored content is an infrastructure error rather than omitted human words', async () => {
    ask(1);
    db.getDatabase().exec("UPDATE neo_conversation_asks SET payload_json = '{}'");
    expect(await read()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
  });
});
