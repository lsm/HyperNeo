import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import {
  admitNeoIntake,
  createNeoIntakeOperation,
  requireNeoIntakeTarget,
} from '../../../../src/lib/neo/intake.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import type { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const input = {
  sessionId: 'neo:10000000-0000-4000-8000-000000000001',
  requestId: 'c706b610-7d48-46d7-a0dd-397d09c070fe',
  content: 'What is happening with project A?',
};
const target = { id: input.sessionId, status: 'active' as const, config: {} };
const binding = { sessionId: input.sessionId, concernId: null, kind: 'neo' as const };

describe('Neo intake gates', () => {
  test.each([
    { source: 'mcp', role: 'neo', sessionId: input.sessionId },
    { source: 'rpc' },
    { source: 'rpc', principal: 'remote' },
    { source: 'internal', principal: 'local' },
  ] satisfies OperationCaller[])('rejects nonhuman intake: %j', (caller) => {
    expect(admitNeoIntake(input, caller)).toEqual({
      reason: { ok: false, reason: 'Only the human can submit a Neo ask.' },
    });
  });
  test('admits the local human without treating the caller session as the target', () => {
    expect(admitNeoIntake(input, { ...human, sessionId: 'unrelated' })).toEqual({ value: input });
    expect(requireNeoIntakeTarget(input, binding, target)).toEqual({ value: target });
  });
  test.each([
    { candidate: null, session: target },
    { candidate: { ...binding, kind: 'worker' as const }, session: target },
    { candidate: { ...binding, sessionId: 'other' }, session: target },
    { candidate: binding, session: null },
    { candidate: binding, session: { ...target, id: 'other' } },
    { candidate: binding, session: { ...target, status: 'archived' as const } },
  ])('rejects unavailable or noncoordinator targets: %j', ({ candidate, session }) => {
    expect(requireNeoIntakeTarget(input, candidate, session)).toHaveProperty('reason.ok', false);
  });
});

describe('durable Neo intake operation', () => {
  let mailbox: MailboxTestDb;
  let repo: NeoRepository;
  let db: Database;
  let sessions: Map<string, typeof target>;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration289(mailbox.db);
    mailbox.db.prepare('INSERT INTO sessions (id) VALUES (?)').run(input.sessionId);
    repo = new NeoRepository(mailbox.db);
    repo.reserveBinding(binding);
    sessions = new Map([[input.sessionId, target]]);
    db = {
      getDatabase: () => mailbox.db,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSession: (id: string) => sessions.get(id) as Session | undefined,
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
  test('registers the operation in the real Neo operation family', () => {
    const registry = createOperationRegistry(createNeoOperations({ db, repo } as NeoService));
    expect(registry.get('neo.message.send')?.policy?.safetyClass).toBe('human_only');
    expect(registry.get('neo.message.send')?.description).toContain('does not mean');
  });
  test('returns a durable receipt with trusted human provenance before any SDK work', async () => {
    expect(await invoke()).toEqual({
      kind: 'completed',
      value: { ok: true, requestId: input.requestId, messageId: input.requestId, created: true },
    });
    const rows = mailbox.sdkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: input.sessionId,
      sdk_uuid: input.requestId,
      send_status: 'enqueued',
      origin: null,
    });
    expect(JSON.parse(rows[0].sdk_message)).toMatchObject({
      inputKind: 'human',
      message: { content: [{ type: 'text', text: input.content }] },
    });
    const jobs = mailbox.jobsByQueue(MESSAGE_DELIVERY);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(JSON.parse(jobs[0].payload)).toMatchObject({
      sessionId: input.sessionId,
      messageUuid: input.requestId,
      origin: 'chat',
      released: true,
    });
    expect(repo.listConcerns()).toEqual([]);
    expect(repo.listWork()).toEqual([]);
  });
  test('accepts another concern while the previous delivery remains processing', async () => {
    await invoke();
    const [previous] = mailbox.jobQueue.dequeue(MESSAGE_DELIVERY, 1);
    expect(previous.status).toBe('processing');
    const other = {
      ...input,
      requestId: crypto.randomUUID(),
      content: 'And what about company B?',
    };
    expect(await invoke(other)).toMatchObject({
      kind: 'completed',
      value: { ok: true, requestId: other.requestId },
    });
    expect(mailbox.jobQueue.getJob(previous.id)?.status).toBe('processing');
    expect(mailbox.sdkRows().map((row) => row.sdk_uuid)).toEqual([
      input.requestId,
      other.requestId,
    ]);
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(2);
    expect(repo.listConcerns()).toEqual([]);
  });
  test('same-ID concurrent retries preserve one prompt and one delivery job', async () => {
    const receipts = await Promise.all([invoke(), invoke(), invoke()]);
    expect(receipts.map((receipt) => receipt.kind === 'completed' && receipt.value)).toEqual([
      { ok: true, requestId: input.requestId, messageId: input.requestId, created: true },
      { ok: true, requestId: input.requestId, messageId: input.requestId, created: false },
      { ok: true, requestId: input.requestId, messageId: input.requestId, created: false },
    ]);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
  });
  test('a retry after consumption does not rerun the ask', async () => {
    await invoke();
    const [job] = mailbox.jobQueue.dequeue(MESSAGE_DELIVERY, 1);
    mailbox.jobQueue.complete(job.id, {}, job.claimToken);
    mailbox.db
      .prepare(
        "UPDATE sdk_messages SET send_status = 'consumed', consumed_seq = 1 WHERE sdk_uuid = ?"
      )
      .run(input.requestId);
    expect(await invoke()).toMatchObject({ value: { ok: true, created: false } });
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)[0].status).toBe('completed');
  });
  test('changed-content retries reject without replacing the original ask', async () => {
    await invoke();
    expect(await invoke({ ...input, content: 'A different request' })).toMatchObject({
      value: { ok: false, reason: 'This request id already belongs to a different ask.' },
    });
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
    expect(JSON.parse(mailbox.sdkRows()[0].sdk_message).message.content[0].text).toBe(
      input.content
    );
  });
  test('preserves photos and attached text; photos alone are accepted', async () => {
    const photo = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    };
    const content = [photo, { type: 'text', text: '```txt\nnotes from a file\n```' }];
    expect(await invoke({ ...input, content })).toMatchObject({ value: { ok: true } });
    expect(JSON.parse(mailbox.sdkRows()[0].sdk_message).message.content).toEqual(content);
    expect(
      await invoke({ ...input, requestId: crypto.randomUUID(), content: [photo] })
    ).toMatchObject({ value: { ok: true } });
    expect(mailbox.sdkRows()).toHaveLength(2);
  });
  test('honors an existing manual query setting instead of releasing it silently', async () => {
    sessions.set(input.sessionId, { ...target, config: { queryMode: 'manual' } } as typeof target);
    expect(await invoke()).toMatchObject({ value: { ok: true } });
    expect(mailbox.sdkRows()[0].send_status).toBe('deferred');
    expect(JSON.parse(mailbox.jobsByQueue(MESSAGE_DELIVERY)[0].payload).released).toBe(false);
  });
  test.each([
    { ...input, requestId: 'not-a-uuid' },
    { ...input, content: '' },
    { ...input, content: [] },
    {
      ...input,
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'x'.repeat(5 * 1024 * 1024 + 1),
          },
        },
      ],
    },
  ])('rejects invalid input before writes: %j', async (value) => {
    expect(await invoke(value)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });
  test('caller admission precedes target reads or persistence', async () => {
    mailbox.db.exec('DROP TABLE neo_session_bindings');
    expect(
      await invoke(input, { source: 'mcp', role: 'neo', sessionId: input.sessionId })
    ).toMatchObject({ value: { ok: false, reason: 'Only the human can submit a Neo ask.' } });
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });
  test('missing and archived conversations reject before writes', async () => {
    sessions.delete(input.sessionId);
    expect(await invoke()).toMatchObject({ value: { ok: false } });
    sessions.set(input.sessionId, { ...target, status: 'archived' } as typeof target);
    expect(await invoke()).toMatchObject({ value: { ok: false } });
    expect(mailbox.sdkRows()).toEqual([]);
    expect(mailbox.rows()).toEqual([]);
  });
  test('a storage fault rolls back the prompt and never reports acceptance', async () => {
    mailbox.db.exec('DROP TABLE job_queue');
    expect(await invoke()).toMatchObject({ kind: 'failed', code: 'execution_failed' });
    expect(mailbox.sdkRows()).toEqual([]);
  });
});
