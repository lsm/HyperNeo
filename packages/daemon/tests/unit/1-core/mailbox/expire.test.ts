import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import type {
  MailboxEntry,
  MailboxEntryPolicy,
  MailboxMessage,
} from '../../../../src/lib/mailbox/entry';
import { expireMailboxEntries } from '../../../../src/lib/mailbox/expire';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
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
