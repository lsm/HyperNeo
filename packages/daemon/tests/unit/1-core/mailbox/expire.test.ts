import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import type {
  MailboxEntry,
  MailboxEntryPolicy,
  MailboxMessage,
} from '../../../../src/lib/mailbox/entry';
import { expireMailboxEntries, MAILBOX_SCAN_PAGE_SIZE } from '../../../../src/lib/mailbox/expire';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import {
  createMailboxTestDb,
  type MailboxJobRow,
  type MailboxTestDb,
} from '../../../helpers/mailbox-test-db';

const NOW = 1_760_000_000_000;
const TTL_MS = 60_000;

const message: MailboxMessage = {
  type: 'user',
  message: { content: 'hello' },
  parent_tool_use_id: null,
};

function makeEntry(overrides?: {
  id?: string;
  policy?: Partial<MailboxEntryPolicy>;
}): MailboxEntry {
  return {
    id: overrides?.id ?? createUlid(NOW),
    to: { kind: 'session', sessionId: 'sess-1' },
    origin: 'test',
    message,
    status: 'enqueued',
    policy: { ttlMs: TTL_MS, maxAttempts: 5, priority: 0, ...overrides?.policy },
  };
}

function rowFor(mailbox: MailboxTestDb, entryId: string): MailboxJobRow {
  const row = mailbox.rows().find((candidate) => {
    const payload = JSON.parse(candidate.payload) as { id?: string };
    return payload.id === entryId;
  });
  if (row === undefined) throw new Error(`no job row carries entry id ${entryId}`);
  return row;
}

function corruptRow(mailbox: MailboxTestDb): MailboxJobRow {
  return mailbox.rows().find((candidate) => {
    const payload = JSON.parse(candidate.payload) as { garbage?: boolean };
    return payload.garbage === true;
  }) as MailboxJobRow;
}

describe('expireMailboxEntries', () => {
  let mailbox: MailboxTestDb;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });

  afterEach(() => {
    mailbox.close();
  });

  test('waits for an expiry receipt and calls notifications outside the transaction', async () => {
    const entry = makeEntry({ id: createUlid(NOW - 2 * TTL_MS) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const inline = new DbGateway(':memory:', mailbox.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    bindGateway(mailbox.db, {
      call: async (op, method, ...args) => {
        if (method === 'expire') {
          entered();
          await gate;
        }
        return Reflect.apply(inline.call, inline, [op, method, ...args]);
      },
    } as DbGateway);
    let notified = 0;
    const sweep = expireMailboxEntries({
      jobQueue: mailbox.jobQueue,
      now: NOW,
      onExpired: (job) => {
        expect(mailbox.jobQueue.getJob(job.id)?.status).toBe('dead');
        mailbox.db.exec('BEGIN');
        mailbox.db.exec('ROLLBACK');
        notified++;
      },
    });
    await requested;
    try {
      expect(notified).toBe(0);
      expect(rowFor(mailbox, entry.id).status).toBe('pending');
    } finally {
      release();
    }
    expect(await sweep).toBe(1);
    expect(notified).toBe(1);
  });

  test('a callback failure stops later candidates after only the first expiry commits', async () => {
    const first = makeEntry({ id: createUlid(NOW - 2 * TTL_MS) });
    const second = makeEntry({ id: createUlid(NOW - 2 * TTL_MS) });
    mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { ...first }, createdAt: 1 });
    mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { ...second }, createdAt: 2 });
    let notified = 0;
    await expect(
      expireMailboxEntries({
        jobQueue: mailbox.jobQueue,
        now: NOW,
        onExpired: () => {
          notified++;
          throw new Error('notification failed');
        },
      })
    ).rejects.toThrow('notification failed');
    expect(notified).toBe(1);
    expect(rowFor(mailbox, first.id).status).toBe('dead');
    expect(rowFor(mailbox, second.id).status).toBe('pending');
  });

  test('a rejected expiry rolls back without publishing failure', async () => {
    const entry = makeEntry({ id: createUlid(NOW - 2 * TTL_MS) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    mailbox.db.exec(
      "CREATE TRIGGER reject_expiry BEFORE UPDATE OF status ON job_queue BEGIN SELECT RAISE(ABORT, 'fixture rejected expiry'); END"
    );
    let notified = 0;
    await expect(
      expireMailboxEntries({
        jobQueue: mailbox.jobQueue,
        now: NOW,
        onExpired: () => {
          notified++;
        },
      })
    ).rejects.toThrow('fixture rejected expiry');
    expect(notified).toBe(0);
    expect(rowFor(mailbox, entry.id).status).toBe('pending');
  });

  test('receipt loading failure after the UPDATE rolls back the terminal transition', async () => {
    const entry = makeEntry({ id: createUlid(NOW - 2 * TTL_MS) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const original = JobQueueRepository.prototype.getJob;
    let reads = 0;
    const getJob = spyOn(JobQueueRepository.prototype, 'getJob').mockImplementation(function (id) {
      reads++;
      if (reads === 2) throw new Error('receipt unavailable');
      return original.call(this, id);
    });
    let notified = 0;
    try {
      await expect(
        expireMailboxEntries({
          jobQueue: mailbox.jobQueue,
          now: NOW,
          onExpired: () => {
            notified++;
          },
        })
      ).rejects.toThrow('receipt unavailable');
      expect(reads).toBe(2);
      expect(notified).toBe(0);
      expect(rowFor(mailbox, entry.id).status).toBe('pending');
      expect(rowFor(mailbox, entry.id).completed_at).toBeNull();
    } finally {
      getJob.mockRestore();
    }
  });

  for (const change of ['extend TTL', 'complete input']) {
    test(`revalidates a scanned candidate after another writer can ${change}`, async () => {
      const entry = makeEntry({ id: createUlid(NOW - 2 * TTL_MS) });
      enqueueMailboxEntry(mailbox.jobQueue, entry);
      const inline = new DbGateway(':memory:', mailbox.db);
      let writes = 0;
      bindGateway(mailbox.db, {
        call: async (op, method, ...args) => {
          if (method === 'expire') {
            writes++;
            if (change === 'extend TTL') {
              mailbox.db
                .prepare(
                  "UPDATE job_queue SET payload = json_set(payload, '$.policy.ttlMs', ?) WHERE id = ?"
                )
                .run(100 * TTL_MS, args[0] as string);
            } else {
              mailbox.db
                .prepare("UPDATE job_queue SET status = 'completed' WHERE id = ?")
                .run(args[0] as string);
            }
          }
          return Reflect.apply(inline.call, inline, [op, method, ...args]);
        },
      } as DbGateway);
      let notified = 0;
      expect(
        await expireMailboxEntries({
          jobQueue: mailbox.jobQueue,
          now: NOW,
          onExpired: () => {
            notified++;
          },
        })
      ).toBe(0);
      expect(writes).toBe(1);
      expect(notified).toBe(0);
      expect(rowFor(mailbox, entry.id).status).toBe(
        change === 'extend TTL' ? 'pending' : 'completed'
      );
    });
  }

  test('a fresh entry is untouched', async () => {
    const entry = makeEntry({ id: createUlid(NOW - TTL_MS / 2) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(0);
    const row = rowFor(mailbox, entry.id);
    expect(row.status).toBe('pending');
    expect(row.error).toBeNull();
  });

  test('an entry exactly at its ttl boundary survives (strict inequality)', async () => {
    const entry = makeEntry({ id: createUlid(NOW - TTL_MS) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(0);
    expect(rowFor(mailbox, entry.id).status).toBe('pending');
  });

  test('an expired entry is dead with the exact error string and no retry burn', async () => {
    const entry = makeEntry({ id: createUlid(NOW - TTL_MS - 1) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(1);
    const row = rowFor(mailbox, entry.id);
    expect(row.status).toBe('dead');
    expect(row.error).toBe('mailbox: entry expired (ttl)');
    expect(row.retry_count).toBe(0);
    expect(row.completed_at).not.toBeNull();
  });

  test('an expired entry keeps its payload and row — side effects stay on the job row', async () => {
    const entry = makeEntry({ id: createUlid(NOW - 2 * TTL_MS) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(1);
    expect(mailbox.rowCount()).toBe(1);
    expect(JSON.parse(rowFor(mailbox, entry.id).payload)).toEqual(entry);
  });

  test('a processing entry past its ttl is dead-lettered too', async () => {
    const entry = makeEntry({ id: createUlid(NOW - TTL_MS - 1) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const claimed = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('processing');

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(1);
    const row = rowFor(mailbox, entry.id);
    expect(row.status).toBe('dead');
    expect(row.error).toBe('mailbox: entry expired (ttl)');
  });

  test('a completed entry past its ttl is outside the scan and stays completed', async () => {
    const entry = makeEntry({ id: createUlid(NOW - 10 * TTL_MS) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const claimed = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
    mailbox.jobQueue.complete(claimed[0].id);
    expect(rowFor(mailbox, entry.id).status).toBe('completed');

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(0);
    expect(rowFor(mailbox, entry.id).status).toBe('completed');
  });

  test('a corrupt payload is skipped, not killed', async () => {
    mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { garbage: true } });

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(0);
    const row = corruptRow(mailbox);
    expect(row.status).toBe('pending');
    expect(row.error).toBeNull();
  });

  test('a payload whose id is not a ulid is skipped, not killed', async () => {
    const corrupted = { ...makeEntry({ id: createUlid(NOW - 10 * TTL_MS) }), id: 'not-a-ulid' };
    mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: corrupted });

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(0);
    expect(mailbox.rows()[0].status).toBe('pending');
    expect(mailbox.rows()[0].error).toBeNull();
  });

  test('jobs on other lanes are invisible to the scan', async () => {
    const foreign = makeEntry({ id: createUlid(NOW - 10 * TTL_MS) });
    mailbox.jobQueue.enqueue({ queue: 'other_lane', payload: { ...foreign } });

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(0);
    expect(mailbox.rows()[0].queue).toBe('other_lane');
    expect(mailbox.rows()[0].status).toBe('pending');
  });

  test('a second sweep over already-dead rows returns zero', async () => {
    const entry = makeEntry({ id: createUlid(NOW - TTL_MS - 1) });
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    const second = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(second).toBe(0);
    expect(rowFor(mailbox, entry.id).status).toBe('dead');
  });

  test('the count is exact across a mixed set', async () => {
    const fresh = makeEntry({ id: createUlid(NOW - 1_000) });
    const boundary = makeEntry({ id: createUlid(NOW - TTL_MS) });
    const oldest = makeEntry({ id: createUlid(NOW - 10 * TTL_MS) });
    const barely = makeEntry({ id: createUlid(NOW - TTL_MS - 1) });
    for (const entry of [fresh, boundary, oldest, barely]) {
      enqueueMailboxEntry(mailbox.jobQueue, entry);
    }
    mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { garbage: true } });

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(expired).toBe(2);
    expect(rowFor(mailbox, fresh.id).status).toBe('pending');
    expect(rowFor(mailbox, boundary.id).status).toBe('pending');
    expect(rowFor(mailbox, oldest.id).status).toBe('dead');
    expect(rowFor(mailbox, barely.id).status).toBe('dead');
    expect(corruptRow(mailbox).status).toBe('pending');
  });

  test('a sweep reaches an expired entry that a fixed newest-first window would starve', async () => {
    const expired = makeEntry({ id: createUlid(NOW - 10 * TTL_MS) });
    mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { ...expired } });
    for (let index = 0; index < MAILBOX_SCAN_PAGE_SIZE; index += 1) {
      mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { ...makeEntry() } });
    }
    expect(mailbox.rowCount()).toBe(MAILBOX_SCAN_PAGE_SIZE + 1);

    const count = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(count).toBe(1);
    expect(rowFor(mailbox, expired.id).status).toBe('dead');
  });

  test('a sweep pages through the whole active set beyond one page', async () => {
    for (let index = 0; index < MAILBOX_SCAN_PAGE_SIZE; index += 1) {
      mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { ...makeEntry() } });
    }
    const newest = makeEntry({ id: createUlid(NOW - TTL_MS - 1) });
    mailbox.jobQueue.enqueue({ queue: MAILBOX_LANE, payload: { ...newest } });
    expect(mailbox.rowCount()).toBe(MAILBOX_SCAN_PAGE_SIZE + 1);
    const timeout = spyOn(globalThis, 'setTimeout');

    const count = await expireMailboxEntries({ jobQueue: mailbox.jobQueue, now: NOW });

    expect(count).toBe(1);
    expect(rowFor(mailbox, newest.id).status).toBe('dead');
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 0);
    timeout.mockRestore();
  });

  test('now defaults to the wall clock', async () => {
    const ancient = makeEntry({ id: createUlid(Date.now() - 10 * TTL_MS) });
    enqueueMailboxEntry(mailbox.jobQueue, ancient);
    const current = makeEntry({ id: createUlid() });
    enqueueMailboxEntry(mailbox.jobQueue, current);

    const expired = await expireMailboxEntries({ jobQueue: mailbox.jobQueue });

    expect(expired).toBe(1);
    expect(rowFor(mailbox, ancient.id).status).toBe('dead');
    expect(rowFor(mailbox, current.id).status).toBe('pending');
  });
});
