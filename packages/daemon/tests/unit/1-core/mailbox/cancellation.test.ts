import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from '../../../../src/storage/database';
import { enqueueMailboxEntry } from '../../../../src/lib/mailbox/enqueue';
import type { MailboxEntry } from '../../../../src/lib/mailbox/entry';
import { materializeMailboxFailuresForSession } from '../../../../src/lib/mailbox/cancellation';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
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
      message: { role: 'user', content: [{ type: 'text', text: 'queued then cancelled' }] },
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

  test('retains an accepted prompt as a failed row and deletes its mailbox job', () => {
    const entry = pendingEntry('accepted-then-cancelled');
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const publish = mock(async () => {});
    const settleSkipped = mock(async () => {});
    const db = {
      getJobQueueRepo: () => mailbox.jobQueue,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      saveUserMessage: (sessionId: string, message: never, status: string, origin?: string) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, status, origin),
    } as unknown as Database;

    const cancelled = materializeMailboxFailuresForSession(SESSION_ID, {
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

  test('is a no-op when the job queue lacks mailbox cancellation support', () => {
    const publish = mock(async () => {});
    const db = {
      getJobQueueRepo: () => ({ cancelForSessionWithMessages: () => [] }),
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
    } as unknown as Database;

    const cancelled = materializeMailboxFailuresForSession(SESSION_ID, {
      db,
      internalEventBus: { publish } as never,
    });

    expect(cancelled).toEqual([]);
    expect(mailbox.sdkRows()).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  test('preserveDeferred keeps deferred entries pending for post-interrupt replay', () => {
    const deferred = pendingEntry('queued-next-survives');
    const immediate: MailboxEntry = {
      ...pendingEntry('immediate-then-cancelled'),
      deliveryMode: 'immediate',
    };
    enqueueMailboxEntry(mailbox.jobQueue, deferred);
    enqueueMailboxEntry(mailbox.jobQueue, immediate);
    const publish = mock(async () => {});
    const db = {
      getJobQueueRepo: () => mailbox.jobQueue,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      saveUserMessage: (sessionId: string, message: never, status: string, origin?: string) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, status, origin),
    } as unknown as Database;

    const cancelled = materializeMailboxFailuresForSession(SESSION_ID, {
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
