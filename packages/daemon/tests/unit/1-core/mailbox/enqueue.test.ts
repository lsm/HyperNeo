import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import {
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxEntryPolicy,
  type MailboxMessage,
} from '../../../../src/lib/mailbox/entry';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const message: MailboxMessage = {
  type: 'user',
  message: { content: 'hello' },
  parent_tool_use_id: null,
};

function makeEntry(overrides?: {
  id?: string;
  to?: MailboxEntry['to'];
  policy?: Partial<MailboxEntryPolicy>;
  message?: MailboxMessage;
}): MailboxEntry {
  return {
    id: overrides?.id ?? createUlid(),
    to: overrides?.to ?? { kind: 'session', sessionId: 'sess-1' },
    origin: 'test',
    message: overrides?.message ?? message,
    status: 'enqueued',
    policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY, ...overrides?.policy },
  };
}

describe('enqueueMailboxEntry', () => {
  let mailbox: MailboxTestDb;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });

  afterEach(() => {
    mailbox.close();
  });

  describe('happy path', () => {
    test('writes exactly one pending row on the mailbox lane whose payload deep-equals the entry', () => {
      const entry = makeEntry({ policy: { priority: 7 } });

      const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
      expect(mailbox.rowCount()).toBe(1);

      const row = mailbox.rows()[0];
      expect(row.queue).toBe('mailbox');
      expect(row.queue).toBe(MAILBOX_LANE);
      expect(row.status).toBe('pending');
      expect(row.priority).toBe(7);
      expect(JSON.parse(row.payload)).toEqual(entry);
      expect(row.id).not.toBe(entry.id);
    });

    test('round-trips an agent address and message priority through the payload', () => {
      const nowMessage: MailboxMessage = {
        type: 'user',
        message: { content: [{ type: 'text', text: 'urgent' }] },
        parent_tool_use_id: null,
        priority: 'now',
      };
      const entry = makeEntry({
        to: { kind: 'agent', spaceId: 'space-1', handle: 'worker', taskId: 't-1', node: 'Coding' },
        message: nowMessage,
      });

      const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
      expect(JSON.parse(mailbox.rows()[0].payload)).toEqual(entry);
    });
  });

  describe('idempotency', () => {
    test('enqueueing the same entry twice keeps one row and reports enqueued both times', () => {
      const entry = makeEntry();

      const first = enqueueMailboxEntry(mailbox.jobQueue, entry);
      const second = enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(first).toEqual({ kind: 'enqueued', id: entry.id });
      expect(second).toEqual({ kind: 'enqueued', id: entry.id });
      expect(mailbox.rowCount()).toBe(1);
      expect(mailbox.rows()[0].status).toBe('pending');
    });

    test('distinct entries with distinct ids produce two rows', () => {
      const first = makeEntry();
      const second = makeEntry();

      enqueueMailboxEntry(mailbox.jobQueue, first);
      enqueueMailboxEntry(mailbox.jobQueue, second);

      expect(mailbox.rowCount()).toBe(2);
      const payloadIds = mailbox.rows().map((row) => JSON.parse(row.payload).id);
      expect(payloadIds).toEqual([first.id, second.id]);
    });
  });

  describe('idempotency window', () => {
    test('a processing row with the same entry id still reports enqueued and writes no second row', () => {
      const entry = makeEntry();
      enqueueMailboxEntry(mailbox.jobQueue, entry);
      const claimed = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].payload.id).toBe(entry.id);
      expect(mailbox.rows()[0].status).toBe('processing');

      const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
      expect(mailbox.rowCount()).toBe(1);
      expect(mailbox.rows()[0].status).toBe('processing');
    });

    test('a completed row with the same entry id does not block a new row', () => {
      const entry = makeEntry();
      enqueueMailboxEntry(mailbox.jobQueue, entry);
      const claimed = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
      const completed = mailbox.jobQueue.complete(claimed[0].id);
      expect(completed?.status).toBe('completed');

      const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
      expect(mailbox.rowCount()).toBe(2);
      expect(mailbox.rows().map((row) => row.status)).toEqual(['completed', 'pending']);
      expect(JSON.parse(mailbox.rows()[1].payload)).toEqual(entry);
    });
  });

  describe('fail-closed serialization', () => {
    test('a circular reference rejects the entry with zero rows written', () => {
      const circular: Record<string, unknown> = { ...makeEntry() };
      circular.self = circular;
      const entry = circular as unknown as MailboxEntry;

      const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.reason).toContain('entry failed serialization:');
        expect(outcome.reason).toContain('Converting circular structure to JSON');
      }
      expect(mailbox.rowCount()).toBe(0);
    });

    test('a BigInt value rejects the entry with zero rows written', () => {
      const entry = {
        ...makeEntry(),
        policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY, priority: 1n },
      } as unknown as MailboxEntry;

      const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.reason).toContain('entry failed serialization:');
        expect(outcome.reason).toContain('Do not know how to serialize a BigInt');
      }
      expect(mailbox.rowCount()).toBe(0);
    });

    test('a rejected serialization leaves the queue untouched for later valid entries', () => {
      const bad = {
        ...makeEntry(),
        policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY, priority: 2n },
      } as unknown as MailboxEntry;
      enqueueMailboxEntry(mailbox.jobQueue, bad);

      const good = makeEntry();
      const outcome = enqueueMailboxEntry(mailbox.jobQueue, good);

      expect(outcome).toEqual({ kind: 'enqueued', id: good.id });
      expect(mailbox.rowCount()).toBe(1);
      expect(JSON.parse(mailbox.rows()[0].payload)).toEqual(good);
    });
  });

  describe('priority', () => {
    test('a non-zero policy priority lands in the row priority column', () => {
      const entry = makeEntry({ policy: { priority: 12 } });

      enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(mailbox.rows()[0].priority).toBe(12);
    });

    test('the default policy priority of zero lands as zero', () => {
      const entry = makeEntry({ policy: { priority: 0 } });

      enqueueMailboxEntry(mailbox.jobQueue, entry);

      expect(mailbox.rows()[0].priority).toBe(0);
    });
  });

  describe('claim order', () => {
    test('with equal priorities the earlier ULID is claimed first', () => {
      const baseMs = Date.now();
      const earlier = makeEntry({ id: createUlid(baseMs) });
      const later = makeEntry({ id: createUlid(baseMs + 5) });
      expect(later.id > earlier.id).toBe(true);

      enqueueMailboxEntry(mailbox.jobQueue, earlier);
      enqueueMailboxEntry(mailbox.jobQueue, later);

      const firstClaim = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
      expect(firstClaim).toHaveLength(1);
      expect(firstClaim[0].payload.id).toBe(earlier.id);

      const secondClaim = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
      expect(secondClaim).toHaveLength(1);
      expect(secondClaim[0].payload.id).toBe(later.id);
    });

    test('a higher-priority entry is claimed before an earlier lower-priority one', () => {
      const low = makeEntry({ policy: { priority: 1 } });
      const high = makeEntry({ policy: { priority: 9 } });

      enqueueMailboxEntry(mailbox.jobQueue, low);
      enqueueMailboxEntry(mailbox.jobQueue, high);

      const firstClaim = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
      expect(firstClaim).toHaveLength(1);
      expect(firstClaim[0].payload.id).toBe(high.id);
    });
  });
});
