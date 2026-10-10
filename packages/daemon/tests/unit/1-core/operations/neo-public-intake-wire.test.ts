import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { vi } from 'vitest';
import {
  createNeoIntakeOperation,
  requireNeoIntakeConversation,
} from '../../../../src/lib/neo/intake.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root: NeoBinding = { sessionId: `neo:${conversationId}`, kind: 'neo', concernId: null };
const holder: NeoBinding = {
  sessionId: 'neo:holder:research',
  kind: 'concern',
  concernId: 'research',
};
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const input = {
  sessionId: root.sessionId,
  requestId: '20000000-0000-4000-8000-000000000001',
  content: 'Keep this fictional draft.',
};
type Target = Pick<Session, 'id' | 'status' | 'config'>;
const active = (id = root.sessionId): Target => ({ id, status: 'active', config: {} });

describe('current public intake binding', () => {
  test('pure root gate derives identity only from valid runtime root and matching non-archived session', () => {
    expect(requireNeoIntakeConversation(root, active())).toEqual({ value: conversationId });
    for (const [binding, session] of [
      [null, active()],
      [holder, active(holder.sessionId)],
      [{ ...root, kind: 'worker' }, active()],
      [{ ...root, concernId: 'other' }, active()],
      [{ ...root, sessionId: 'neo:root' }, active('neo:root')],
      [{ ...root, sessionId: conversationId }, active(conversationId)],
      [root, null],
      [root, active('unrelated')],
      [root, { ...active(), status: 'archived' }],
    ] as [NeoBinding | null, Target | null][]) {
      expect(requireNeoIntakeConversation(binding, session)).toEqual({
        reason: { ok: false, reason: 'The public Neo conversation is no longer available.' },
      });
    }
  });
});

describe('real human intake joint persistence', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
  let ledger: NeoConversationAskRepository;
  let db: Database;
  let sessions: Map<string, Target>;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration289(mailbox.db);
    repo = new NeoRepository(mailbox.db);
    ledger = new NeoConversationAskRepository(mailbox.db);
    repo.reserveBinding(root);
    repo.reserveBinding(holder);
    for (const binding of [root, holder])
      mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(binding.sessionId);
    sessions = new Map(
      [root, holder].map((binding) => [binding.sessionId, active(binding.sessionId)])
    );
    db = {
      getDatabase: () => mailbox.db,
      getSession: (id: string) => sessions.get(id),
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      getJobQueueRepo: () => mailbox.jobQueue,
    } as unknown as Database;
  });
  afterEach(() => mailbox.close());
  function invoke(value: unknown = input, caller = human) {
    return invokeOperation(
      createOperationRegistry([createNeoIntakeOperation(db, repo)]),
      'neo.message.send',
      value,
      caller
    );
  }
  function empty() {
    expect(ledger.list(conversationId)).toEqual([]);
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  }

  test.each([root, holder])(
    'records original source %o in the current root conversation atomically',
    async (binding) => {
      expect(
        await invoke({
          ...input,
          sessionId: binding.sessionId,
          conversationId: 'avatar-cannot-select',
        })
      ).toEqual({
        kind: 'completed',
        value: { ok: true, requestId: input.requestId, messageId: input.requestId, created: true },
      });
      const [ask] = ledger.list(conversationId)!;
      expect(ask).toMatchObject({
        conversationId,
        requestId: input.requestId,
        askOrigin: { sessionId: binding.sessionId, messageId: input.requestId },
        content: [{ type: 'text', text: input.content }],
      });
      expect(mailbox.sdkRows()).toHaveLength(1);
      expect(mailbox.sdkRows()[0].session_id).toBe(binding.sessionId);
      expect(JSON.parse(mailbox.sdkRows()[0].sdk_message).inputKind).toBe('human');
      expect(mailbox.rows()).toHaveLength(1);
      expect(repo.listWork()).toEqual([]);
    }
  );

  test.each([
    { source: 'mcp', role: 'neo', sessionId: root.sessionId },
    { source: 'mcp', role: 'neo', sessionId: holder.sessionId },
    { source: 'rpc' },
    { source: 'rpc', principal: 'remote' },
    { source: 'internal', principal: 'local' },
  ] as OperationCaller[])(
    'refuses claimed human %o before any target/root/storage access',
    async (caller) => {
      const targets = vi.spyOn(db, 'getSession');
      const roots = vi.spyOn(repo, 'getBindingForConcern');
      const storage = vi.spyOn(db, 'getSDKMessageRepo');
      expect(await invoke({ ...input, human: true, inputKind: 'human' }, caller)).toMatchObject({
        value: { ok: false, reason: 'Only the human can submit a Neo ask.' },
      });
      expect(targets).not.toHaveBeenCalled();
      expect(roots).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      empty();
    }
  );

  test.each(['missing', 'archived', 'invalid', 'foreign-session', 'holder-root'])(
    'a valid holder cannot submit through a %s root',
    async (kind) => {
      if (kind === 'missing')
        mailbox.db.exec('DELETE FROM neo_session_bindings WHERE concern_id IS NULL');
      if (kind === 'archived') sessions.set(root.sessionId, { ...active(), status: 'archived' });
      if (kind === 'invalid')
        vi.spyOn(repo, 'getBindingForConcern').mockReturnValue({ ...root, sessionId: 'neo:root' });
      if (kind === 'foreign-session') sessions.set(root.sessionId, active('foreign'));
      if (kind === 'holder-root') vi.spyOn(repo, 'getBindingForConcern').mockReturnValue(holder);
      expect(await invoke({ ...input, sessionId: holder.sessionId })).toMatchObject({
        value: { ok: false, reason: 'The public Neo conversation is no longer available.' },
      });
      empty();
    }
  );

  test('target admission still precedes root and joint storage admission', async () => {
    const roots = vi.spyOn(repo, 'getBindingForConcern');
    expect(await invoke({ ...input, sessionId: 'unbound' })).toMatchObject({
      value: { ok: false, reason: 'Open a Neo conversation before sending.' },
    });
    expect(roots).not.toHaveBeenCalled();
    empty();
  });

  test('same request cannot migrate to another holder source or overwrite its public ask', async () => {
    await invoke();
    const before = ledger.list(conversationId);
    expect(await invoke({ ...input, sessionId: holder.sessionId })).toMatchObject({
      value: { ok: false, reason: 'This request id already belongs to a different ask.' },
    });
    expect(ledger.list(conversationId)).toEqual(before);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('concurrent retries and SDK transcript removal retain durable acceptance without rerun', async () => {
    const receipts = await Promise.all([invoke(), invoke(), invoke()]);
    expect(receipts.map((receipt) => receipt.kind === 'completed' && receipt.value)).toEqual([
      { ok: true, requestId: input.requestId, messageId: input.requestId, created: true },
      { ok: true, requestId: input.requestId, messageId: input.requestId, created: false },
      { ok: true, requestId: input.requestId, messageId: input.requestId, created: false },
    ]);
    const before = ledger.list(conversationId);
    mailbox.db.exec('DELETE FROM sdk_messages; DELETE FROM job_queue;');
    expect(await invoke()).toMatchObject({ value: { ok: true, created: false } });
    expect(ledger.list(conversationId)).toEqual(before);
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });

  test('holder manual mode and photo/text bytes persist without releasing or re-routing', async () => {
    sessions.set(holder.sessionId, {
      ...active(holder.sessionId),
      config: { queryMode: 'manual' },
    });
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: '   ```txt\nfictional attachment\n```' },
    ];
    expect(await invoke({ ...input, sessionId: holder.sessionId, content })).toMatchObject({
      value: { ok: true },
    });
    expect(ledger.list(conversationId)![0].content).toEqual(content);
    expect(mailbox.sdkRows()[0].send_status).toBe('deferred');
    expect(JSON.parse(mailbox.rows()[0].payload)).toMatchObject({
      sessionId: holder.sessionId,
      released: false,
    });
    expect(await invoke({ ...input, sessionId: holder.sessionId, content })).toMatchObject({
      value: { ok: true, created: false },
    });
    expect(mailbox.rows()).toHaveLength(1);
  });

  test('an unrelated ask persists while another native job is processing', async () => {
    await invoke();
    const [job] = mailbox.jobQueue.dequeue('message_delivery', 1);
    expect(job.status).toBe('processing');
    const next = {
      ...input,
      sessionId: holder.sessionId,
      requestId: crypto.randomUUID(),
      content: 'Another fictional ask.',
    };
    expect(await invoke(next)).toMatchObject({ value: { ok: true, created: true } });
    expect(mailbox.jobQueue.getJob(job.id)?.status).toBe('processing');
    expect(ledger.list(conversationId)).toHaveLength(2);
    expect(mailbox.rows()).toHaveLength(2);
  });

  test.each(['sdk_messages', 'job_queue'])(
    'a %s insert fault rolls back all three accepted records',
    async (table) => {
      mailbox.db.exec(
        `CREATE TRIGGER refuse_wire BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'wire fault'); END`
      );
      expect(await invoke()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
      empty();
    }
  );

  test('missing public storage fails rather than accepting an SDK-only ask', async () => {
    mailbox.db.exec('DROP TABLE neo_conversation_asks');
    expect(await invoke()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });

  test('the operation finishes joint persistence by the time its transport promise resolves', async () => {
    const operation = createNeoIntakeOperation(db, repo);
    expect(await operation.execute(input, human)).toMatchObject({ ok: true, created: true });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.rows()).toHaveLength(1);
  });
});
