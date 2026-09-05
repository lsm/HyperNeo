import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createMailboxExpireHandler,
  enqueueMailboxExpireIfMissing,
} from '../../../../src/lib/job-handlers/mailbox-expire.handler';
import { MAILBOX_EXPIRE_FIRE } from '../../../../src/lib/job-queue-constants';
import { enqueueMailboxEntry } from '../../../../src/lib/mailbox/enqueue';
import type { MailboxEntry } from '../../../../src/lib/mailbox/entry';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const fakeJob = {
  id: 'mailbox-expire-job',
  queue: MAILBOX_EXPIRE_FIRE,
  status: 'processing',
  payload: {},
  result: null,
  error: null,
  priority: 0,
  maxRetries: 3,
  retryCount: 0,
  runAt: Date.now(),
  createdAt: Date.now(),
  startedAt: Date.now(),
  heartbeatAt: Date.now(),
  completedAt: null,
  claimToken: 'claim-1',
} as Job;

function expiredEntry(): MailboxEntry {
  return {
    id: createUlid(Date.now() - 120_000),
    to: { kind: 'session', sessionId: 'sess-1' },
    origin: 'test',
    deliveryMode: 'immediate',
    message: {
      type: 'user',
      message: { content: 'hello' },
      parent_tool_use_id: null,
    },
    status: 'enqueued',
    policy: { ttlMs: 60_000, maxAttempts: 5, priority: 0 },
  };
}

describe('createMailboxExpireHandler', () => {
  let mailbox: MailboxTestDb;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });

  afterEach(() => {
    mailbox.close();
  });

  test('expires mailbox entries and self-schedules the next sweep', async () => {
    const entry = expiredEntry();
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const before = Date.now();

    const result = await createMailboxExpireHandler(mailbox.jobQueue)(fakeJob);

    const after = Date.now();
    const expired = mailbox.rows().find((row) => JSON.parse(row.payload).id === entry.id);
    const pending = mailbox.jobQueue.listJobs({
      queue: MAILBOX_EXPIRE_FIRE,
      status: 'pending',
      limit: 10,
    });
    expect(expired?.status).toBe('dead');
    expect(result.expired).toBe(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].runAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(pending[0].runAt).toBeLessThanOrEqual(after + 60_000);
    expect(result.nextRunAt).toBe(pending[0].runAt);
  });

  test('re-seeds a missing sweep without duplicating a pending one', () => {
    enqueueMailboxExpireIfMissing(mailbox.jobQueue, 100);
    enqueueMailboxExpireIfMissing(mailbox.jobQueue, 200);

    const pending = mailbox.jobQueue.listJobs({
      queue: MAILBOX_EXPIRE_FIRE,
      status: 'pending',
      limit: 10,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].runAt).toBe(100);
  });
});
