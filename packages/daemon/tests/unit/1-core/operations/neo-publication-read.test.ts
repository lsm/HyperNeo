import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  createNeoPublicationReadOperation,
  requirePublicationConversation,
  requirePublicationReader,
} from '../../../../src/lib/neo/publication-read-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, concernId: null };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const page = { conversationId, after: 0, limit: 50 };
function publication(index = 1, target = conversationId) {
  return {
    conversationId: target,
    publicationId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    askOrigin: { sessionId: root.sessionId, messageId: 'original-ask' },
    producerInput: { sessionId: 'holder:research', messageId: 'return-input' },
    shortText: 'Two differences are worth checking.',
    fullText: '**Fictional comparison**\n\nKeep this as a draft.',
    links: [{ kind: 'concern' as const, id: 'research', label: '查看对照 ↗' }],
  };
}

describe('authored publication reads', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
  let ledger: NeoPublicationRepository;
  function invoke(input: unknown = { conversationId }, caller = human) {
    return invokeOperation(
      createOperationRegistry([createNeoPublicationReadOperation(repo, ledger)]),
      'neo.publication.read',
      input,
      caller
    );
  }
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration288(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    ledger = new NeoPublicationRepository(mailbox.db);
    repo.reserveBinding(root);
  });
  afterEach(() => mailbox.close());

  test('pure reader and conversation gates require actual local human and root identities', () => {
    expect(requirePublicationReader(page, human)).toEqual({ value: page });
    expect(requirePublicationReader(page, { source: 'rpc' })).toEqual({
      reason: { ok: false, reason: 'human_only' },
    });
    expect(requirePublicationConversation(page, root)).toEqual({ value: page });
    for (const binding of [
      null,
      { ...root, sessionId: `neo:${foreignId}` },
      { ...root, concernId: 'research' },
    ]) {
      expect(requirePublicationConversation(page, binding)).toEqual({
        reason: { ok: false, reason: 'conversation_not_found' },
      });
    }
  });

  test.each([
    { source: 'mcp', role: 'neo', sessionId: root.sessionId },
    { source: 'mcp', role: 'long_term_agent', spaceId: 's' },
    { source: 'internal' },
    { source: 'rpc' },
  ] as OperationCaller[])(
    'refuses non-human caller %o before any ledger or binding read',
    async (caller) => {
      const bindings = vi.spyOn(repo, 'getBindingForConcern');
      const reads = vi.spyOn(ledger, 'list');
      expect(await invoke({ conversationId }, caller)).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'human_only' },
      });
      expect(bindings).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
    }
  );

  test('returns authored bytes, labels, original attribution and immutable retry receipt', async () => {
    const stored = ledger.append(publication());
    expect(stored.accepted).toBe(true);
    if (!stored.accepted) throw new Error('fixture publication was not admitted');
    expect(ledger.append(publication())).toEqual({ ...stored, created: false });
    expect(await invoke()).toEqual({
      kind: 'completed',
      value: {
        ok: true,
        conversationId,
        items: [stored.publication],
        nextAfter: stored.publication.sequence,
      },
    });
    expect(await invoke()).toEqual(await invoke());
  });

  test('ascending cursor pages exclude foreign rows and retain the cursor on an empty tail', async () => {
    const first = ledger.append(publication(1));
    expect(ledger.append(publication(2, foreignId)).accepted).toBe(true);
    const second = ledger.append(publication(3));
    if (!first.accepted || !second.accepted) throw new Error('fixture append failed');
    const cursor = first.publication.sequence;
    expect(await invoke({ conversationId, limit: 1 })).toEqual({
      kind: 'completed',
      value: { ok: true, conversationId, items: [first.publication], nextAfter: cursor },
    });
    expect(await invoke({ conversationId, after: cursor, limit: 1 })).toEqual({
      kind: 'completed',
      value: {
        ok: true,
        conversationId,
        items: [second.publication],
        nextAfter: second.publication.sequence,
      },
    });
    expect(await invoke({ conversationId, after: second.publication.sequence })).toEqual({
      kind: 'completed',
      value: { ok: true, conversationId, items: [], nextAfter: second.publication.sequence },
    });
  });

  test.each([{ conversationId: foreignId }, { conversationId, missing: true }])(
    'does not read mismatched or missing root %o',
    async (input) => {
      if ('missing' in input) mailbox.db.exec('DELETE FROM neo_session_bindings');
      const reads = vi.spyOn(ledger, 'list');
      expect(await invoke({ conversationId: input.conversationId })).toEqual({
        kind: 'completed',
        value: { ok: false, reason: 'conversation_not_found' },
      });
      expect(reads).not.toHaveBeenCalled();
    }
  );

  test.each([
    { conversationId: 'not-an-id' },
    { conversationId, after: -1 },
    { conversationId, after: 1.5 },
    { conversationId, after: Number.MAX_SAFE_INTEGER + 1 },
    { conversationId, limit: 0 },
    { conversationId, limit: 101 },
    { conversationId, limit: 1.5 },
    { conversationId, sessionId: root.sessionId },
  ])('rejects malformed identity, cursor, bounds or injected fields %o', async (input) => {
    const reads = vi.spyOn(ledger, 'list');
    expect(await invoke(input)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(reads).not.toHaveBeenCalled();
  });

  test('default and maximum bounds are forwarded without mutations or raw SDK leakage', async () => {
    expect(
      mailbox.sdkMessageRepo.saveSDKMessage(root.sessionId, {
        type: 'user',
        uuid: 'private-system-input',
        session_id: root.sessionId,
        parent_tool_use_id: null,
        inputKind: 'system',
        message: { role: 'user', content: 'Raw internal compaction context never belongs here.' },
      } as SDKUserMessage)
    ).toBe(true);
    const before = mailbox.sdkRows();
    const reads = vi.spyOn(ledger, 'list');
    expect(await invoke()).toEqual({
      kind: 'completed',
      value: { ok: true, conversationId, items: [], nextAfter: 0 },
    });
    expect(reads).toHaveBeenLastCalledWith(conversationId, 0, 50);
    await invoke({ conversationId, after: Number.MAX_SAFE_INTEGER, limit: 100 });
    expect(reads).toHaveBeenLastCalledWith(conversationId, Number.MAX_SAFE_INTEGER, 100);
    expect(mailbox.sdkRows()).toEqual(before);
    expect(mailbox.rows()).toEqual([]);
  });

  test('the operation finishes its synchronous reads before returning its transport promise', async () => {
    const reads = vi.spyOn(ledger, 'list');
    const pending = createNeoPublicationReadOperation(repo, ledger).execute(page, human);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await pending).toEqual({ ok: true, conversationId, items: [], nextAfter: 0 });
  });

  test('invalid stored publications surface an infrastructure failure, not an empty success', async () => {
    expect(ledger.append(publication()).accepted).toBe(true);
    mailbox.db.prepare('UPDATE neo_publications SET payload_json = ?').run('{}');
    expect(await invoke()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
  });

  test('fresh repository instances read durable publications after database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-public-read-'));
    const path = join(dir, 'fictional.db');
    let db = new Database(path);
    try {
      createNeoTables(db);
      runMigration288(db);
      new NeoRepository(db).reserveBinding(root);
      const stored = new NeoPublicationRepository(db).append(publication());
      if (!stored.accepted) throw new Error('fixture append failed');
      db.close();
      db = new Database(path);
      const op = createNeoPublicationReadOperation(
        new NeoRepository(db),
        new NeoPublicationRepository(db)
      );
      expect(await op.execute(page, human)).toEqual({
        ok: true,
        conversationId,
        items: [stored.publication],
        nextAfter: stored.publication.sequence,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
