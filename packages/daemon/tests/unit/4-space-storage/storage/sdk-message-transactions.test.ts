import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import type { TableChange } from '../../../../src/storage/db-gateway/db-op';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { sdkMessageWrites } from '../../../../src/storage/repositories/sdk-message-writes';
import {
  prepareNeoIntakeAsk,
  NeoConversationAskRepository,
} from '../../../../src/storage/repositories/neo-conversation-ask-repository';
import {
  SDK_MESSAGE_TRANSACTIONS,
  sdkTransactionArgs,
  sdkPromptEnsure,
  sdkPromptActivate,
  sdkPromptRetry,
  sdkNeoIntake,
  sdkDeliveryTeardown,
  sdkMailboxFailure,
  sdkColumnBackfillChunk,
  sdkColumnBackfillComplete,
  sdkDeliveryFencedStatus,
} from '../../../../src/storage/repositories/sdk-message-transactions';
import { selectSdkBodyWriteMode } from '../../../../src/storage/sdk-message-body-admission';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { DEFAULT_MAILBOX_ENTRY_POLICY } from '../../../../src/lib/mailbox/entry';
import { createUlid } from '../../../../src/lib/mailbox/ulid';

const sid = 'synthetic-writer';
const conversationId = '10000000-0000-4000-8000-000000000001';
const neoId = `neo:${conversationId}`;
const user = (uuid: string, session = sid) =>
  ({
    type: 'user',
    uuid,
    session_id: session,
    parent_tool_use_id: null,
    inputKind: 'human',
    message: { role: 'user', content: uuid },
  }) as SDKUserMessage;
let db: Database;
let gateway: DbGateway;
let messages: SDKMessageRepository;
let jobs: JobQueueRepository;
let changes: TableChange[];
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  for (const id of [sid, neoId])
    db.prepare(
      "INSERT INTO sessions(id,title,created_at,last_active_at,status,config,metadata) VALUES (?,'Synthetic',datetime('now'),datetime('now'),'active','{}','{}')"
    ).run(id);
  gateway = new DbGateway(':memory:', db);
  bindGateway(db, gateway);
  changes = [];
  gateway.onChanges = (recorded) => changes.push(...recorded);
  messages = new SDKMessageRepository(db);
  jobs = new JobQueueRepository(db);
});
afterEach(async () => {
  await gateway.close();
  db.close();
});
const pendingMailbox = (uuid: string) =>
  enqueueMailboxEntry(jobs, {
    id: createUlid(),
    to: { kind: 'session', sessionId: sid },
    origin: 'chat',
    messageUuid: uuid,
    message: { type: 'user', parent_tool_use_id: null, message: { content: uuid } },
    status: 'enqueued',
    deliveryMode: 'defer',
    policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY },
  });

describe('SDK transaction ops', () => {
  test('runs the transaction ops on a real worker while main stays read-only', () => {
    const run = mkdtempSync(join(tmpdir(), 'sdk-ops-worker-'));
    const root = resolve(import.meta.dirname, '../../../../../..');
    mkdirSync(join(run, 'home'));
    try {
      const child = spawnSync('bun', ['.claude/skills/verify/sdk-transaction-ops.ts', run], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          HOME: join(run, 'home'),
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'warn',
        },
      });
      expect({
        status: child.status,
        error: child.error?.message,
        stderr: child.stderr,
      }).toMatchObject({ status: 0 });
      const evidence = JSON.parse(
        readFileSync(join(run, 'evidence/sdk-transaction-ops.json'), 'utf8')
      );
      expect(evidence).toMatchObject({
        pass: true,
        sideOnly: true,
        rollback: true,
        mainQueryOnly: { query_only: 1 },
      });
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 30_000);

  test('removes main-only capabilities while preserving undefined input values', () => {
    const input = {
      sessionId: sid,
      message: user('transport'),
      timestamp: undefined,
      uuids: [undefined, 'kept'],
      db,
      sdkMessageRepo: messages,
      jobQueue: jobs,
      canDeliver: () => true,
      publishStatusChanged: () => {},
      deferPostSaveSideEffects: () => {},
    };
    const encoded = sdkTransactionArgs(input);
    expect(structuredClone(encoded)).toEqual({
      sessionId: sid,
      message: user('transport'),
      timestamp: undefined,
      uuids: [undefined, 'kept'],
    });
    expect(Object.hasOwn(encoded, 'timestamp')).toBe(true);
  });

  test('registers every transaction without routing a caller', () => {
    for (const op of SDK_MESSAGE_TRANSACTIONS) expect(DB_OPS.get(op.name)).toBe(op);
    expect(SDK_MESSAGE_TRANSACTIONS).toHaveLength(9);
  });
  test('ensures, activates and retries the same row with its job', async () => {
    const ensured = await gateway.run(sdkPromptEnsure, {
      sessionId: sid,
      message: user('outbox'),
      hold: 'manual',
      delivery: { origin: 'chat' },
    });
    expect(ensured.created).toBe(true);
    expect(
      db.prepare('SELECT sdk_message FROM sdk_messages WHERE id=?').get(ensured.dbMessageId)
    ).toEqual({ sdk_message: JSON.stringify(user('outbox')) });
    expect(messages.getDeliveryContent(sid, 'outbox')?.sendStatus).toBe('deferred');
    expect(
      await gateway.run(sdkPromptActivate, {
        sessionId: sid,
        messageUuids: ['outbox'],
        origin: 'chat',
      })
    ).toEqual({ activated: [{ dbId: ensured.dbMessageId, messageUuid: 'outbox' }] });
    messages.markDeliveryFailedByUuid(sid, 'outbox');
    expect(
      await gateway.run(sdkPromptRetry, { sessionId: sid, messageUuid: 'outbox', origin: 'chat' })
    ).toEqual({ dbId: ensured.dbMessageId, messageUuid: 'outbox' });
    expect(messages.getDeliveryContent(sid, 'outbox')?.sendStatus).toBe('enqueued');
  });
  test('rolls Neo ledger, prompt and job back together on insert failure', async () => {
    const message = user('20000000-0000-4000-8000-000000000001', neoId);
    const prepared = prepareNeoIntakeAsk(conversationId, message);
    if (!('value' in prepared)) throw new Error('invalid synthetic ask');
    db.exec(
      "CREATE TRIGGER fail_job BEFORE INSERT ON job_queue BEGIN SELECT RAISE(ABORT,'synthetic job fault'); END"
    );
    await expect(
      gateway.run(sdkNeoIntake, { ask: prepared.value, message, hold: 'immediate' })
    ).rejects.toThrow('synthetic job fault');
    expect(new NeoConversationAskRepository(db).list(conversationId)).toEqual([]);
    expect(messages.getStoredPromptsByUuid(neoId, message.uuid!)).toEqual([]);
    expect(changes).toEqual([]);
    db.exec('DROP TRIGGER fail_job');
    expect(
      await gateway.run(sdkNeoIntake, { ask: prepared.value, message, hold: 'immediate' })
    ).toMatchObject({ accepted: true, created: true });
  });
  test('rolls teardown cancellation back when failed-row materialization fails', async () => {
    pendingMailbox('teardown');
    db.exec(
      "CREATE TRIGGER fail_message BEFORE INSERT ON sdk_messages BEGIN SELECT RAISE(ABORT,'synthetic message fault'); END"
    );
    const input = {
      sessionId: sid,
      options: { deliveries: { failEnqueued: true, failDeferred: true } },
    };
    await expect(gateway.run(sdkDeliveryTeardown, input)).rejects.toThrow(
      'synthetic message fault'
    );
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM job_queue WHERE queue=?').get(MAILBOX_LANE)
    ).toEqual({ n: 1 });
    expect(changes).toEqual([]);
    db.exec('DROP TRIGGER fail_message');
    await gateway.run(sdkDeliveryTeardown, input);
    expect(messages.getDeliveryContent(sid, 'teardown')?.sendStatus).toBe('failed');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM job_queue WHERE queue=?').get(MAILBOX_LANE)
    ).toEqual({ n: 0 });
  });
  test('materializes a mailbox failure in one op', async () => {
    pendingMailbox('failure');
    const job = jobs.dequeue(MAILBOX_LANE, 1)[0];
    const result = await gateway.run(sdkMailboxFailure, { job });
    expect(result.failedId).toBeTruthy();
    expect(messages.getDeliveryContent(sid, 'failure')?.sendStatus).toBe('failed');
  });
  test('backfills a bounded chunk and finishes its marker separately', async () => {
    db.prepare('DELETE FROM migration_markers WHERE key=?').run(
      'sdk_message_columns_backfilled_v2'
    );
    const id = messages.saveUserMessage(sid, user('legacy'), 'enqueued');
    db.prepare('UPDATE sdk_messages SET input_kind=NULL WHERE id=?').run(id);
    const result = await gateway.run(sdkColumnBackfillChunk, { after: 0, ceiling: 1 });
    expect(result).toMatchObject({ through: 1, rows: 1 });
    expect(db.prepare('SELECT input_kind FROM sdk_messages WHERE id=?').get(id)).toEqual({
      input_kind: 'human',
    });
    await gateway.run(sdkColumnBackfillComplete, undefined);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM migration_markers WHERE key GLOB 'sdk_message_columns_backfill_v2:*'"
        )
        .get()
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM migration_markers WHERE key='sdk_message_columns_backfilled_v2'"
        )
        .get()
    ).toEqual({ n: 1 });
  });
  test('fences delivery status updates against a current claim', async () => {
    messages.saveUserMessage(sid, user('fenced'), 'enqueued');
    jobs.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: sid, messageUuid: 'kickoff' },
    });
    const claim = jobs.dequeue('message_delivery', 1)[0];
    const input = {
      sessionId: sid,
      kickoffUuid: 'kickoff',
      claimToken: claim.claimToken!,
      uuids: ['fenced'],
      fromStatus: 'enqueued' as const,
      toStatus: 'submitted' as const,
    };
    expect(await gateway.run(sdkDeliveryFencedStatus, { ...input, claimToken: 'stale' })).toEqual(
      []
    );
    expect(await gateway.run(sdkDeliveryFencedStatus, input)).toEqual(['fenced']);
  });
  test('keeps admitted side-only bodies out of the legacy column', async () => {
    db.prepare('INSERT INTO migration_markers(key,applied_at) VALUES (?,?)').run(
      'sdk_message_bodies_copy_v1:complete',
      Date.now()
    );
    expect(await selectSdkBodyWriteMode(db)).toEqual({ mode: 'side-only', reason: null });
    const saved = await gateway.run(sdkPromptEnsure, {
      sessionId: sid,
      message: user('side-only'),
      delivery: { origin: 'chat' },
    });
    expect(
      db.prepare('SELECT sdk_message FROM sdk_messages WHERE id=?').get(saved.dbMessageId)
    ).toEqual({ sdk_message: '' });
    expect(messages.getStoredPromptsByUuid(sid, 'side-only')).toEqual([user('side-only')]);
  });
  test('does not record a turn-end row for a missing session', async () => {
    await gateway.call(
      sdkMessageWrites,
      'recordDeliveryTurnEnd',
      'missing',
      'missing',
      new Date().toISOString()
    );
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM delivery_turn_end WHERE session_id='missing'").get()
    ).toEqual({ n: 0 });
  });
});
