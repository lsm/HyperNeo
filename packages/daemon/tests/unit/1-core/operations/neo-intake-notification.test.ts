import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { ensurePrompt } from '../../../../src/lib/agent/message-delivery-outbox.ts';
import { createNeoIntakeOperation, neoIntakeMessage } from '../../../../src/lib/neo/intake.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoConversationAskRepository } from '../../../../src/storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root: NeoBinding = { sessionId: `neo:${conversationId}`, kind: 'neo', concernId: null };
const holder: NeoBinding = {
  sessionId: 'neo:holder:research',
  kind: 'concern',
  concernId: 'research',
};
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const requestId = '20000000-0000-4000-8000-000000000001';
const content = 'Keep this fictional draft.';
const input = { sessionId: root.sessionId, requestId, content };
const tables = ['neo_conversation_asks', 'sdk_messages', 'job_queue'] as const;

describe('accepted public ask notification', () => {
  let directory: string;
  let writer: Sqlite;
  let reader: Sqlite;
  let db: Database;
  let repo: NeoRepository;
  let sessions: SessionRepository;
  let sdk: SDKMessageRepository;
  let jobs: JobQueueRepository;
  let ledger: NeoConversationAskRepository;
  let observed: number[][];
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-intake-notify-'));
    writer = new Sqlite(join(directory, 'fictional.db'));
    reader = new Sqlite(join(directory, 'fictional.db'));
    createTables(writer);
    sessions = new SessionRepository(writer);
    sdk = new SDKMessageRepository(writer as never);
    jobs = new JobQueueRepository(writer);
    ledger = new NeoConversationAskRepository(writer);
    repo = new NeoRepository(writer);
    observed = [];
    notify = vi.fn(() => {
      observed.push(
        tables.map(
          (table) => (reader.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
        )
      );
    });
    for (const binding of [root, holder]) {
      repo.reserveBinding(binding);
      sessions.createSession({
        id: binding.sessionId,
        title: 'Fictional',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {},
        metadata: {},
      } as Session);
    }
    db = {
      getDatabase: () => writer,
      getSDKMessageRepo: () => sdk,
      getJobQueueRepo: () => jobs,
      getSession: (id: string) => sessions.getSession(id),
    } as unknown as Database;
  });
  afterEach(() => {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const send = (value: unknown = input, caller = human) =>
    invokeOperation(
      createOperationRegistry([createNeoIntakeOperation(db, repo, notify)]),
      'neo.message.send',
      value,
      caller
    );
  const receipt = async (value: unknown = input) => (await send(value)).value;
  const legacyPrompt = () =>
    ensurePrompt({
      db: writer,
      sdkMessageRepo: sdk,
      jobQueue: jobs,
      sessionId: root.sessionId,
      message: neoIntakeMessage(input),
      delivery: { origin: 'chat' },
    });

  test.each([root, holder])(
    'notifies only after all three committed rows are visible from a second connection for %o',
    async (binding) => {
      expect(await receipt({ ...input, sessionId: binding.sessionId })).toEqual({
        ok: true,
        requestId,
        messageId: requestId,
        created: true,
      });
      expect(observed).toEqual([[1, 1, 1]]);
      expect(ledger.list(conversationId)![0]).toMatchObject({
        requestId,
        askOrigin: { sessionId: binding.sessionId, messageId: requestId },
      });
    }
  );

  test('notifies an identical retry and a durable public receipt after SDK removal', async () => {
    expect(await receipt()).toMatchObject({ ok: true, created: true });
    writer.exec('DELETE FROM sdk_messages; DELETE FROM job_queue;');
    expect(await receipt()).toEqual({
      ok: true,
      requestId,
      messageId: requestId,
      created: false,
    });
    expect(observed).toEqual([
      [1, 1, 1],
      [1, 0, 0],
    ]);
    expect(ledger.list(conversationId)).toHaveLength(1);
  });
  test('notifies a genuine legacy backfill whose created flag only describes SDK prompt creation', async () => {
    const previous = legacyPrompt();
    expect(ledger.list(conversationId)).toEqual([]);
    expect(await receipt()).toEqual({
      ok: true,
      requestId,
      messageId: requestId,
      created: false,
    });
    expect(observed).toEqual([[1, 1, 1]]);
    expect(ledger.list(conversationId)![0].requestId).toBe(requestId);
    const kept = writer.prepare('SELECT id FROM sdk_messages').get() as { id: string };
    expect(kept.id).toBe(previous.dbMessageId);
  });

  test('accepts a manual-mode holder ask and still notifies after its commit', async () => {
    writer
      .prepare('UPDATE sessions SET config = ? WHERE id = ?')
      .run(JSON.stringify({ queryMode: 'manual' }), holder.sessionId);
    expect(sessions.getSession(holder.sessionId)!.config).toMatchObject({ queryMode: 'manual' });
    expect(await receipt({ ...input, sessionId: holder.sessionId })).toMatchObject({ ok: true });
    expect(observed).toEqual([[1, 1, 1]]);
    const row = writer
      .prepare('SELECT send_status FROM sdk_messages WHERE sdk_uuid = ?')
      .get(requestId) as { send_status: string };
    expect(row.send_status).toBe('deferred');
    expect(ledger.list(conversationId)![0].askOrigin.sessionId).toBe(holder.sessionId);
  });

  test.each([
    { source: 'mcp', role: 'neo', sessionId: root.sessionId } as OperationCaller,
    { source: 'rpc', principal: 'remote' } as OperationCaller,
  ])('does not notify a refused caller %j', async (caller) => {
    expect(await send({ ...input, inputKind: 'human' }, caller)).toMatchObject({
      value: { ok: false, reason: 'Only the human can submit a Neo ask.' },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test.each(['missing', 'archived'])(
    'does not notify an unavailable %s conversation',
    async (kind) => {
      if (kind === 'archived')
        writer.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(root.sessionId);
      else writer.exec('DELETE FROM neo_session_bindings WHERE concern_id IS NULL');
      expect(await receipt()).toMatchObject({ ok: false });
      expect(notify).not.toHaveBeenCalled();
    }
  );

  test('does not notify a conflicting ask and leaves the admitted ask intact', async () => {
    await receipt();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await receipt({ ...input, content: 'A different fictional ask.' })).toMatchObject({
      ok: false,
      reason: 'This request id already belongs to a different ask.',
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger.list(conversationId)).toHaveLength(1);
  });

  test.each(['sdk_messages', 'job_queue'])(
    'does not notify when a %s fault rolls back the acceptance',
    async (table) => {
      writer.exec(
        `CREATE TRIGGER refuse BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fault'); END`
      );
      expect(await send()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
      expect(notify).not.toHaveBeenCalled();
      expect(ledger.list(conversationId)).toEqual([]);
    }
  );

  test('does not notify without public storage rather than accepting an SDK-only ask', async () => {
    writer.exec('DROP TABLE neo_conversation_asks');
    expect(await send()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
    expect(notify).not.toHaveBeenCalled();
  });

  test('preserves the accepted result and rows when the notification itself faults', async () => {
    notify.mockImplementation(() => {
      throw new Error('listener fault');
    });
    expect(await receipt()).toEqual({
      ok: true,
      requestId,
      messageId: requestId,
      created: true,
    });
    expect(observed).toEqual([]);
    expect(ledger.list(conversationId)).toHaveLength(1);
    const kept = writer.prepare('SELECT COUNT(*) AS c FROM sdk_messages').get() as { c: number };
    expect(kept.c).toBe(1);
  });

  test('the real service callback emits neo.changed for an accepted ask', async () => {
    const events: string[] = [];
    const service = new NeoService(
      db,
      {} as never,
      {
        event: (method: string) => {
          events.push(method);
        },
      } as never,
      { subscribe: () => () => {} } as never
    );
    const result = await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.message.send',
      input,
      human
    );
    expect(result).toMatchObject({ value: { ok: true, created: true } });
    expect(events).toEqual(['neo.changed']);
  });
});
