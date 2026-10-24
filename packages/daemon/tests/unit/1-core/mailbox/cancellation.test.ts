import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { runMigration413 } from '../../../../src/storage/schema/m413-sdk-message-columns';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  materializeMailboxFailuresForSession,
  persistSessionDeliveryTeardown,
} from '../../../../src/lib/mailbox/cancellation';
import { enqueueMailboxEntry } from '../../../../src/lib/mailbox/enqueue';
import { parseMailboxEntry, type MailboxEntry } from '../../../../src/lib/mailbox/entry';
import { deterministicMailboxUuid } from '../../../../src/lib/mailbox/failure';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import type { Database } from '../../../../src/storage/database';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const SESSION_ID = 'sess-1';

function pendingEntry(messageUuid: string): MailboxEntry {
  return {
    id: createUlid(),
    to: { kind: 'session', sessionId: SESSION_ID },
    origin: 'chat',
    messageUuid,
    deliveryMode: 'defer',
    message: {
      type: 'user',
      message: { content: [{ type: 'text', text: 'queued then cancelled' }] },
      parent_tool_use_id: null,
    },
    status: 'enqueued',
    policy: { ttlMs: 60_000, maxAttempts: 5, priority: 0 },
  };
}

describe('materializeMailboxFailuresForSession', () => {
  let mailbox: MailboxTestDb;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });

  afterEach(() => {
    mailbox.close();
  });

  test('replays one scoped message change for a newly materialized failed row', async () => {
    enqueueMailboxEntry(mailbox.jobQueue, pendingEntry('scoped-failure'));
    const notifyChange = mock((_table: string, _scope?: unknown) => {});
    const db = {
      getDatabase: () => mailbox.db,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      notifyChange,
    } as unknown as Database;
    const gateway = new DbGateway(':memory:', mailbox.db);
    bindGateway(mailbox.db, gateway);
    gateway.onChanges = (changes) => {
      for (const change of changes) db.notifyChange(change.table, change.scope);
    };
    await materializeMailboxFailuresForSession(SESSION_ID, {
      db,
      internalEventBus: { publish: async () => {} } as never,
    });
    expect(mailbox.sdkRows()[0].send_status).toBe('failed');
    expect(notifyChange.mock.calls.filter((call) => call[0] === 'sdk_messages')).toEqual([
      ['sdk_messages', { sessionId: SESSION_ID, taskId: undefined }],
    ]);
  });

  test('retains an accepted prompt as a failed row and deletes its mailbox job', async () => {
    const entry = pendingEntry('accepted-then-cancelled');
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const publish = mock(async () => {});
    const settleSkipped = mock(async () => {});
    const db = {
      getDatabase: () => mailbox.db,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      saveUserMessage: async (sessionId: string, message: never, status: string, origin?: string) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, status, origin),
    } as unknown as Database;

    const cancelled = await materializeMailboxFailuresForSession(SESSION_ID, {
      db,
      internalEventBus: { publish } as never,
      settleSkipped,
    });

    expect(cancelled).toEqual(['accepted-then-cancelled']);
    const rows = mailbox.sdkRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sdk_uuid).toBe('accepted-then-cancelled');
    expect(rows[0].send_status).toBe('failed');
    expect(mailbox.rows().filter((row) => row.status !== 'completed')).toHaveLength(0);
    expect(publish).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: SESSION_ID,
      messageIds: [rows[0].id],
      status: 'failed',
    });
    expect(settleSkipped).toHaveBeenCalledWith(SESSION_ID, 'accepted-then-cancelled');
  });

  test('tells the sending session when teardown cancels its pending message', async () => {
    enqueueMailboxEntry(mailbox.jobQueue, {
      ...pendingEntry('neo-handoff'),
      origin: 'session:neo%3Aroot',
    });
    const db = {
      getDatabase: () => mailbox.db,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      saveUserMessage: async (sessionId: string, message: never, status: string, origin?: string) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, status, origin),
    } as unknown as Database;

    await materializeMailboxFailuresForSession(SESSION_ID, {
      db,
      internalEventBus: { publish: async () => {} } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const notices = mailbox.rows().filter((row) => row.status === 'pending');
    expect(notices).toHaveLength(1);
    const notice = parseMailboxEntry(JSON.parse(notices[0].payload));
    expect(notice?.to).toEqual({ kind: 'session', sessionId: 'neo:root' });
    expect(notice?.origin).toBe('system');
    expect(JSON.stringify(notice?.message)).toContain('cancelled by session abort');
  });

  test('reports the deterministic uuid for entries materialized without messageUuid', async () => {
    const entry: MailboxEntry = {
      id: createUlid(),
      to: { kind: 'session', sessionId: SESSION_ID },
      origin: 'chat',
      message: {
        type: 'user',
        message: { content: [{ type: 'text', text: 'unseeded then cancelled' }] },
        parent_tool_use_id: null,
      },
      status: 'enqueued',
      policy: { ttlMs: 60_000, maxAttempts: 5, priority: 0 },
      deliveryMode: 'immediate',
    };
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const publish = mock(async () => {});
    const db = {
      getDatabase: () => mailbox.db,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      saveUserMessage: async (sessionId: string, message: never, status: string, origin?: string) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, status, origin),
    } as unknown as Database;

    const cancelled = await materializeMailboxFailuresForSession(SESSION_ID, {
      db,
      internalEventBus: { publish } as never,
    });

    const expectedUuid = deterministicMailboxUuid(entry.id);
    expect(cancelled).toEqual([expectedUuid]);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.sdkRows()[0].sdk_uuid).toBe(expectedUuid);
    expect(mailbox.sdkRows()[0].send_status).toBe('failed');
  });

  test('is a no-op when the job queue lacks mailbox cancellation support', async () => {
    const publish = mock(async () => {});
    const db = {
      getJobQueueRepo: () => ({ cancelForSessionWithMessages: () => [] }),
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
    } as unknown as Database;

    const cancelled = await materializeMailboxFailuresForSession(SESSION_ID, {
      db,
      internalEventBus: { publish } as never,
    });

    expect(cancelled).toEqual([]);
    expect(mailbox.sdkRows()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  test('preserveDeferred keeps deferred entries pending for post-interrupt replay', async () => {
    const deferred = pendingEntry('queued-next-survives');
    const immediate: MailboxEntry = {
      ...pendingEntry('immediate-then-cancelled'),
      deliveryMode: 'immediate',
    };
    enqueueMailboxEntry(mailbox.jobQueue, deferred);
    enqueueMailboxEntry(mailbox.jobQueue, immediate);
    const publish = mock(async () => {});
    const db = {
      getDatabase: () => mailbox.db,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      saveUserMessage: async (sessionId: string, message: never, status: string, origin?: string) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, status, origin),
    } as unknown as Database;

    const cancelled = await materializeMailboxFailuresForSession(SESSION_ID, {
      db,
      internalEventBus: { publish } as never,
      preserveDeferred: true,
    });

    expect(cancelled).toEqual(['immediate-then-cancelled']);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.sdkRows()[0].sdk_uuid).toBe('immediate-then-cancelled');
    expect(mailbox.sdkRows()[0].send_status).toBe('failed');
    const remaining = mailbox.rows().filter((row) => row.status === 'pending');
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0].payload).messageUuid).toBe('queued-next-survives');
  });
});

describe('persistSessionDeliveryTeardown', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    runMigration413(mailbox.db);
  });
  afterEach(() => mailbox.close());
  const save = (uuid: string, status: 'enqueued' | 'deferred' | 'consumed') =>
    mailbox.sdkMessageRepo.saveUserMessage(
      SESSION_ID,
      {
        type: 'user',
        uuid,
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: uuid }] },
      },
      status
    );

  test('synchronously cancels mailbox and delivery jobs while retaining failed and consumed bodies', () => {
    enqueueMailboxEntry(mailbox.jobQueue, pendingEntry('mailbox-input'));
    const enqueued = save('job-input', 'enqueued');
    save('orphan-input', 'enqueued');
    save('deferred-input', 'deferred');
    save('consumed-input', 'consumed');
    mailbox.jobQueue.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: SESSION_ID, messageUuid: 'job-input' },
    });
    const result = persistSessionDeliveryTeardown(
      SESSION_ID,
      mailbox.jobQueue,
      mailbox.sdkMessageRepo,
      mailbox.sdkMessageRepo.getUserMessageIdsByStatus.bind(mailbox.sdkMessageRepo),
      { deliveries: { failEnqueued: true, failDeferred: true } }
    );
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.failedDbIds).toContain(enqueued);
    expect(mailbox.rows()).toEqual([]);
    const statuses = Object.fromEntries(
      mailbox.sdkRows().map((row) => [row.sdk_uuid, row.send_status])
    );
    expect(statuses).toEqual({
      'mailbox-input': 'failed',
      'job-input': 'failed',
      'orphan-input': 'failed',
      'deferred-input': 'failed',
      'consumed-input': 'consumed',
    });
    expect(mailbox.sdkRows()).toHaveLength(5);
    expect(
      JSON.parse(mailbox.sdkRows().find((row) => row.sdk_uuid === 'deferred-input')!.sdk_message)
        .message.content[0].text
    ).toBe('deferred-input');
  });

  test('preserves deferred entries and rows when the interrupt policy requests replay', () => {
    enqueueMailboxEntry(mailbox.jobQueue, pendingEntry('deferred-mailbox'));
    save('deferred-row', 'deferred');
    save('orphan-enqueued', 'enqueued');
    persistSessionDeliveryTeardown(
      SESSION_ID,
      mailbox.jobQueue,
      mailbox.sdkMessageRepo,
      mailbox.sdkMessageRepo.getUserMessageIdsByStatus.bind(mailbox.sdkMessageRepo),
      { preserveDeferred: true, deliveries: { failEnqueued: true, failDeferred: false } }
    );
    expect(mailbox.rows()).toHaveLength(1);
    expect(mailbox.sdkRows().map((row) => [row.sdk_uuid, row.send_status])).toEqual([
      ['deferred-row', 'deferred'],
      ['orphan-enqueued', 'failed'],
    ]);
  });

  test('all cancellation and row writes roll back with the owning transaction', () => {
    enqueueMailboxEntry(mailbox.jobQueue, pendingEntry('rollback-mailbox'));
    save('rollback-job', 'enqueued');
    mailbox.jobQueue.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: SESSION_ID, messageUuid: 'rollback-job' },
    });
    expect(() =>
      mailbox.db.transaction(() => {
        persistSessionDeliveryTeardown(
          SESSION_ID,
          mailbox.jobQueue,
          mailbox.sdkMessageRepo,
          mailbox.sdkMessageRepo.getUserMessageIdsByStatus.bind(mailbox.sdkMessageRepo),
          { deliveries: { failEnqueued: true, failDeferred: true } }
        );
        expect(mailbox.rows()).toEqual([]);
        throw new Error('outer rollback');
      })()
    ).toThrow('outer rollback');
    expect(mailbox.rows()).toHaveLength(2);
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(mailbox.sdkRows()[0].send_status).toBe('enqueued');
  });
});
