import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { createNeoConversationAskReadOperation } from '../../../../src/lib/neo/conversation-ask-read-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const foreignId = '10000000-0000-4000-8000-000000000002';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, concernId: null };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const page = { conversationId, after: 0, limit: 50 };
function ask(
  index = 1,
  target = conversationId,
  content: SDKUserMessage['message']['content'] = '请对照资料，不要发布。'
) {
  const requestId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  return {
    conversationId: target,
    requestId,
    askOrigin: { sessionId: root.sessionId, messageId: requestId },
    content,
  };
}

describe('durable public ask reads', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
  let ledger: NeoConversationAskRepository;
  function invoke(input: unknown = { conversationId }, caller = human) {
    return invokeOperation(
      createOperationRegistry([createNeoConversationAskReadOperation(repo, ledger)]),
      'neo.conversation.asks.read',
      input,
      caller
    );
  }
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration289(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    ledger = new NeoConversationAskRepository(mailbox.db);
    repo.reserveBinding(root);
  });
  afterEach(() => mailbox.close());

  test.each([
    { source: 'mcp', role: 'neo', sessionId: root.sessionId },
    { source: 'mcp', role: 'long_term_agent', spaceId: 's' },
    { source: 'internal' },
    { source: 'rpc' },
  ] as OperationCaller[])(
    'refuses non-human %o before binding or ledger access',
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

  test.each(['foreign', 'missing', 'holder'])(
    'refuses a %s conversation before ledger access',
    async (kind) => {
      if (kind === 'missing') mailbox.db.exec('DELETE FROM neo_session_bindings');
      if (kind === 'holder')
        vi.spyOn(repo, 'getBindingForConcern').mockReturnValue({
          ...root,
          concernId: 'research',
          kind: 'concern',
        });
      const reads = vi.spyOn(ledger, 'list');
      expect(
        await invoke({ conversationId: kind === 'foreign' ? foreignId : conversationId })
      ).toEqual({
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
  ])('rejects malformed bounds or injected input %o', async (input) => {
    const reads = vi.spyOn(ledger, 'list');
    expect(await invoke(input)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(reads).not.toHaveBeenCalled();
  });

  test.each([
    '请对照资料，不要发布。',
    '   ',
    [{ type: 'text', text: '**draft**\nattachment: fictional.txt' }],
    [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }],
    [
      { type: 'text', text: 'Compare this fictional photo.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
    ],
  ] as SDKUserMessage['message']['content'][])(
    'returns canonical content and stable original attribution %o',
    async (content) => {
      const stored = ledger.append(ask(1, conversationId, content));
      if (!stored.accepted) throw new Error('fixture ask rejected');
      expect(ledger.append(ask(1, conversationId, content))).toEqual({ ...stored, created: false });
      expect(stored.ask.content).toEqual(
        typeof content === 'string' ? [{ type: 'text', text: content }] : content
      );
      expect(await invoke()).toEqual({
        kind: 'completed',
        value: { ok: true, conversationId, items: [stored.ask], nextAfter: stored.ask.sequence },
      });
      expect(await invoke()).toEqual(await invoke());
      expect(mailbox.rows()).toEqual([]);
      expect(mailbox.sdkRows()).toEqual([]);
    }
  );

  test('ascending pagination excludes interleaved foreign rows and retains empty-tail cursor', async () => {
    const first = ledger.append(ask(1));
    expect(ledger.append(ask(2, foreignId)).accepted).toBe(true);
    const second = ledger.append(ask(3));
    if (!first.accepted || !second.accepted) throw new Error('fixture append failed');
    expect(await invoke({ conversationId, limit: 1 })).toEqual({
      kind: 'completed',
      value: { ok: true, conversationId, items: [first.ask], nextAfter: first.ask.sequence },
    });
    expect(await invoke({ conversationId, after: first.ask.sequence, limit: 1 })).toEqual({
      kind: 'completed',
      value: { ok: true, conversationId, items: [second.ask], nextAfter: second.ask.sequence },
    });
    expect(await invoke({ conversationId, after: second.ask.sequence })).toEqual({
      kind: 'completed',
      value: { ok: true, conversationId, items: [], nextAfter: second.ask.sequence },
    });
  });

  test('default/max bounds and synchronous read do not start native jobs or leak raw SDK rows', async () => {
    expect(
      mailbox.sdkMessageRepo.saveSDKMessage(root.sessionId, {
        type: 'user',
        uuid: 'private-context',
        session_id: root.sessionId,
        parent_tool_use_id: null,
        inputKind: 'system',
        message: { role: 'user', content: 'Private compaction context.' },
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
    const pending = createNeoConversationAskReadOperation(repo, ledger).execute(page, human);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(await pending).toEqual({ ok: true, conversationId, items: [], nextAfter: 0 });
    expect(mailbox.sdkRows()).toEqual(before);
    expect(mailbox.rows()).toEqual([]);
  });

  test.each(['{}', '{', JSON.stringify({ ...ask(), requestId: foreignId })])(
    'stored corruption surfaces infrastructure failure rather than empty success: %s',
    async (payload) => {
      expect(ledger.append(ask()).accepted).toBe(true);
      mailbox.db.prepare('UPDATE neo_conversation_asks SET payload_json = ?').run(payload);
      expect(await invoke()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
    }
  );

  test('null admitted storage page is an infrastructure failure', async () => {
    vi.spyOn(ledger, 'list').mockReturnValue(null);
    expect(await invoke()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
  });

  test('actual database reopen retains durable asks without SDK storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-ask-read-'));
    const path = join(dir, 'fictional.db');
    let db = new Database(path);
    try {
      createNeoTables(db);
      runMigration289(db);
      new NeoRepository(db).reserveBinding(root);
      const stored = new NeoConversationAskRepository(db).append(ask());
      if (!stored.accepted) throw new Error('fixture append failed');
      db.close();
      db = new Database(path);
      const operation = createNeoConversationAskReadOperation(
        new NeoRepository(db),
        new NeoConversationAskRepository(db)
      );
      expect(await operation.execute(page, human)).toEqual({
        ok: true,
        conversationId,
        items: [stored.ask],
        nextAfter: stored.ask.sequence,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
