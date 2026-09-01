import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import {
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxDeliveryMode,
  type MailboxEntry,
  type MailboxEntryPolicy,
  type MailboxMessage,
} from '../../../../src/lib/mailbox/entry';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import { DeadLetterImmediatelyError } from '../../../../src/storage/job-queue-processor';
import type {
  Job,
  JobQueueRepository,
} from '../../../../src/storage/repositories/job-queue-repository';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const SESSION_ID = 'sess-1';

const message: MailboxMessage = {
  type: 'user',
  message: { content: 'hello from the mailbox' },
  parent_tool_use_id: null,
};

function makeEntry(overrides?: {
  id?: string;
  to?: MailboxEntry['to'];
  origin?: string;
  policy?: Partial<MailboxEntryPolicy>;
  message?: MailboxMessage;
  deliveryMode?: MailboxDeliveryMode;
}): MailboxEntry {
  return {
    id: overrides?.id ?? createUlid(),
    to: overrides?.to ?? { kind: 'session', sessionId: SESSION_ID },
    origin: overrides?.origin ?? 'test',
    message: overrides?.message ?? message,
    status: 'enqueued',
    policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY, ...overrides?.policy },
    deliveryMode: overrides?.deliveryMode ?? 'immediate',
  };
}

function expectedMessageUuid(entryId: string): string {
  const digest = createHash('sha256').update(entryId).digest('hex');
  return `mbox-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function deliveryPayloads(mailbox: MailboxTestDb, sessionId: string, messageUuid: string) {
  return mailbox
    .jobsByQueue(MESSAGE_DELIVERY)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    .filter((payload) => payload.sessionId === sessionId && payload.messageUuid === messageUuid);
}

function claimMailboxJob(mailbox: MailboxTestDb, entry: MailboxEntry): Job {
  const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);
  expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
  const claimed = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
  expect(claimed).toHaveLength(1);
  return claimed[0];
}

const HUMAN_PREDICATE_SQL = `
  SELECT COALESCE(origin, '') != 'system'
    AND COALESCE(CAST(json_extract(sdk_message, '$.isSynthetic') AS INTEGER), 0) = 0 AS isHuman
  FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`;

function humanPredicate(mailbox: MailboxTestDb, sessionId: string, messageUuid: string): boolean {
  const row = mailbox.db.prepare(HUMAN_PREDICATE_SQL).get(sessionId, messageUuid) as
    | { isHuman: number }
    | undefined;
  return row?.isHuman === 1;
}

describe('createMailboxDeliveryHandler', () => {
  let mailbox: MailboxTestDb;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });

  afterEach(() => {
    mailbox.close();
  });

  function makeHandler(
    getSession: (sessionId: string) => Promise<object | null> = async () => ({ ok: true }),
    isSessionArchived: (sessionId: string) => boolean = () => false
  ) {
    let sessionCalls = 0;
    let archivedCalls = 0;
    const handler = createMailboxDeliveryHandler({
      jobQueue: mailbox.jobQueue,
      db: mailbox.db,
      sdkMessageRepo: mailbox.sdkMessageRepo,
      getSession: async (sessionId: string): Promise<object | null> => {
        sessionCalls += 1;
        return getSession(sessionId);
      },
      isSessionArchived: (sessionId: string): boolean => {
        archivedCalls += 1;
        return isSessionArchived(sessionId);
      },
    });
    return { handler, sessionCalls: () => sessionCalls, archivedCalls: () => archivedCalls };
  }

  describe('corrupt payload', () => {
    test('dead-letters immediately with zero side effects and no attempt burn', async () => {
      const { handler } = makeHandler();
      const job = claimMailboxJob(mailbox, makeEntry());
      job.payload = { nonsense: true };

      await expect(handler(job)).rejects.toBeInstanceOf(DeadLetterImmediatelyError);
      await expect(handler(job)).rejects.toThrow('mailbox: corrupt entry payload');

      expect(mailbox.sdkRows()).toHaveLength(0);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);
      const row = mailbox.rows()[0];
      expect(row.status).toBe('processing');
      expect(row.retry_count).toBe(0);

      const dead = mailbox.jobQueue.markDead(
        job.id,
        'mailbox: corrupt entry payload',
        job.claimToken
      );
      expect(dead?.status).toBe('dead');
      expect(dead?.retryCount).toBe(0);
    });
  });

  describe('agent address', () => {
    test('dead-letters as corruption with zero side effects and no upstream checks', async () => {
      const { handler, sessionCalls, archivedCalls } = makeHandler();
      const entry = makeEntry({
        to: { kind: 'agent', spaceId: 'space-1', handle: 'worker', taskId: 't-1' },
      });
      const job = claimMailboxJob(mailbox, entry);

      await expect(handler(job)).rejects.toBeInstanceOf(DeadLetterImmediatelyError);
      await expect(handler(job)).rejects.toThrow(
        'mailbox: agent address reached delivery — resolution belongs upstream'
      );
      expect(sessionCalls()).toBe(0);
      expect(archivedCalls()).toBe(0);

      expect(mailbox.sdkRows()).toHaveLength(0);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);
      expect(mailbox.rows()[0].retry_count).toBe(0);
    });
  });

  describe('archived target', () => {
    test('dead-letters before any content row or session load', async () => {
      const { handler, sessionCalls } = makeHandler(undefined, () => true);
      const entry = makeEntry();
      const job = claimMailboxJob(mailbox, entry);

      await expect(handler(job)).rejects.toBeInstanceOf(DeadLetterImmediatelyError);
      await expect(handler(job)).rejects.toThrow('mailbox: target session archived');
      expect(sessionCalls()).toBe(0);

      expect(mailbox.sdkRows()).toHaveLength(0);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);

      const dead = mailbox.jobQueue.markDead(
        job.id,
        'mailbox: target session archived',
        job.claimToken
      );
      expect(dead?.status).toBe('dead');
      expect(dead?.retryCount).toBe(0);
    });

    test('a target archived while the session loads dead-letters on the post-load recheck', async () => {
      let releaseSession: ((session: object | null) => void) | undefined;
      let archived = false;
      const gatedGetSession = (_sessionId: string): Promise<object | null> =>
        new Promise((resolve) => {
          releaseSession = resolve;
        });
      const { handler, sessionCalls } = makeHandler(gatedGetSession, () => archived);
      const entry = makeEntry();
      const job = claimMailboxJob(mailbox, entry);

      const pending = handler(job);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sessionCalls()).toBe(1);

      archived = true;
      releaseSession?.({ ok: true });

      await expect(pending).rejects.toBeInstanceOf(DeadLetterImmediatelyError);
      await expect(pending).rejects.toThrow('mailbox: target session archived');

      expect(mailbox.sdkRows()).toHaveLength(0);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);
      expect(mailbox.rows()[0].retry_count).toBe(0);
    });
  });

  describe('missing session — bounded retry to dead', () => {
    test('throws normally, burns attempts with backoff, dead-letters at maxRetries, never writes content', async () => {
      const { handler } = makeHandler(async () => null);
      const entry = makeEntry();
      const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);
      expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
      expect(mailbox.rows()[0].max_retries).toBe(4);

      let job = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1)[0];
      let executions = 0;
      let settled: ReturnType<JobQueueRepository['fail']> = null;
      while (true) {
        executions += 1;
        await expect(handler(job)).rejects.toThrow(`mailbox: session ${SESSION_ID} not found`);
        expect(mailbox.sdkRows()).toHaveLength(0);
        expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);

        const before = Date.now();
        settled = mailbox.jobQueue.fail(
          job.id,
          `mailbox: session ${SESSION_ID} not found`,
          job.claimToken
        );
        expect(settled).not.toBeNull();
        if (settled?.status === 'dead') break;
        expect(settled?.status).toBe('pending');
        expect(settled?.retryCount).toBe(executions);
        expect(mailbox.rows()[0].run_at).toBeGreaterThanOrEqual(
          before + 2 ** (executions - 1) * 1000
        );

        mailbox.jobQueue.reschedulePending(job.id, Date.now());
        const reclaimed = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
        expect(reclaimed).toHaveLength(1);
        job = reclaimed[0];
      }

      expect(settled?.status).toBe('dead');
      expect(settled?.retryCount).toBe(4);
      expect(executions).toBe(DEFAULT_MAILBOX_ENTRY_POLICY.maxAttempts);
      expect(mailbox.sdkRows()).toHaveLength(0);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);
    });
  });

  describe('session rung — delivered', () => {
    test('injects exactly one content row and one delivery pointer, then completes', async () => {
      const { handler } = makeHandler();
      const entry = makeEntry({ origin: 'chat' });
      const job = claimMailboxJob(mailbox, entry);

      const result = await handler(job);

      expect(result).toEqual({ kind: 'delivered', sessionId: SESSION_ID });

      const rows = mailbox.sdkRows();
      expect(rows).toHaveLength(1);
      const messageUuid = expectedMessageUuid(entry.id);
      expect(rows[0].session_id).toBe(SESSION_ID);
      expect(rows[0].message_type).toBe('user');
      expect(rows[0].sdk_uuid).toBe(messageUuid);
      expect(rows[0].send_status).toBe('enqueued');
      expect(rows[0].origin).toBeNull();
      expect(JSON.parse(rows[0].sdk_message)).toEqual({
        ...message,
        uuid: messageUuid,
        session_id: SESSION_ID,
      });
      expect(humanPredicate(mailbox, SESSION_ID, messageUuid)).toBe(true);

      const pointers = deliveryPayloads(mailbox, SESSION_ID, messageUuid);
      expect(pointers).toHaveLength(1);
      expect(pointers[0].origin).toBe('chat');
      expect(pointers[0].parentToolUseId).toBeNull();

      const completed = mailbox.jobQueue.complete(
        job.id,
        result as Record<string, unknown>,
        job.claimToken
      );
      expect(completed?.status).toBe('completed');
    });

    test('projects text-block content verbatim into the content row', async () => {
      const { handler } = makeHandler();
      const blocksMessage: MailboxMessage = {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
        parent_tool_use_id: null,
        priority: 'next',
      };
      const entry = makeEntry({ message: blocksMessage, origin: 'space_agent' });
      const job = claimMailboxJob(mailbox, entry);

      await handler(job);

      const rows = mailbox.sdkRows();
      expect(rows).toHaveLength(1);
      const messageUuid = expectedMessageUuid(entry.id);
      expect(JSON.parse(rows[0].sdk_message)).toEqual({
        ...blocksMessage,
        uuid: messageUuid,
        session_id: SESSION_ID,
        isSynthetic: true,
      });
      expect(deliveryPayloads(mailbox, SESSION_ID, messageUuid)[0].origin).toBe('space_agent');
    });
  });

  describe('provenance law', () => {
    test('every non-chat origin persists as system + synthetic and fails the human predicate', async () => {
      for (const origin of ['space_inject', 'space_agent', 'long_term_agent', 'recovery']) {
        mailbox.close();
        mailbox = createMailboxTestDb();
        const { handler } = makeHandler();
        const entry = makeEntry({ origin });
        const job = claimMailboxJob(mailbox, entry);

        await handler(job);

        const rows = mailbox.sdkRows();
        expect(rows).toHaveLength(1);
        const messageUuid = expectedMessageUuid(entry.id);
        expect(rows[0].origin).toBe('system');
        expect(JSON.parse(rows[0].sdk_message)).toEqual({
          ...message,
          uuid: messageUuid,
          session_id: SESSION_ID,
          isSynthetic: true,
        });
        expect(humanPredicate(mailbox, SESSION_ID, messageUuid)).toBe(false);
      }
    });

    test('an unrecognized origin is delivery-mapped to space_inject and stamped synthetic', async () => {
      const { handler } = makeHandler();
      const entry = makeEntry({ origin: 'some_future_origin' });
      const job = claimMailboxJob(mailbox, entry);

      await handler(job);

      const messageUuid = expectedMessageUuid(entry.id);
      expect(deliveryPayloads(mailbox, SESSION_ID, messageUuid)[0].origin).toBe('space_inject');
      expect(mailbox.sdkRows()[0].origin).toBe('system');
      expect(humanPredicate(mailbox, SESSION_ID, messageUuid)).toBe(false);
    });
  });

  describe('origin mapping', () => {
    test('passes each known delivery origin through unmapped', async () => {
      for (const origin of ['chat', 'space_inject', 'space_agent', 'long_term_agent', 'recovery']) {
        mailbox.close();
        mailbox = createMailboxTestDb();
        const { handler } = makeHandler();
        const entry = makeEntry({ origin });
        const job = claimMailboxJob(mailbox, entry);

        await handler(job);

        const messageUuid = expectedMessageUuid(entry.id);
        expect(deliveryPayloads(mailbox, SESSION_ID, messageUuid)[0].origin).toBe(origin);
      }
    });
  });

  describe('deliveryMode mapping', () => {
    test('defer writes the content row held with no delivery release and completes the mailbox job', async () => {
      const { handler } = makeHandler();
      const entry = makeEntry({ origin: 'space_agent', deliveryMode: 'defer' });
      const job = claimMailboxJob(mailbox, entry);

      const result = await handler(job);

      expect(result).toEqual({ kind: 'delivered', sessionId: SESSION_ID });

      const rows = mailbox.sdkRows();
      expect(rows).toHaveLength(1);
      const messageUuid = expectedMessageUuid(entry.id);
      expect(rows[0].sdk_uuid).toBe(messageUuid);
      expect(rows[0].send_status).toBe('deferred');

      const pointers = deliveryPayloads(mailbox, SESSION_ID, messageUuid);
      expect(pointers).toHaveLength(1);
      expect(pointers[0].released).toBe(false);

      const completed = mailbox.jobQueue.complete(
        job.id,
        result as Record<string, unknown>,
        job.claimToken
      );
      expect(completed?.status).toBe('completed');
    });

    test('defer preserves the provenance law — system origin and synthetic stamp', async () => {
      const { handler } = makeHandler();
      const entry = makeEntry({ origin: 'space_agent', deliveryMode: 'defer' });
      const job = claimMailboxJob(mailbox, entry);

      await handler(job);

      const rows = mailbox.sdkRows();
      expect(rows[0].origin).toBe('system');
      const messageUuid = expectedMessageUuid(entry.id);
      expect(JSON.parse(rows[0].sdk_message)).toEqual({
        ...message,
        uuid: messageUuid,
        session_id: SESSION_ID,
        isSynthetic: true,
      });
      expect(humanPredicate(mailbox, SESSION_ID, messageUuid)).toBe(false);
    });

    test('immediate keeps the content row enqueued with a released delivery pointer', async () => {
      const { handler } = makeHandler();
      const entry = makeEntry({ origin: 'chat', deliveryMode: 'immediate' });
      const job = claimMailboxJob(mailbox, entry);

      const result = await handler(job);

      expect(result).toEqual({ kind: 'delivered', sessionId: SESSION_ID });
      const rows = mailbox.sdkRows();
      expect(rows).toHaveLength(1);
      const messageUuid = expectedMessageUuid(entry.id);
      expect(rows[0].send_status).toBe('enqueued');
      expect(deliveryPayloads(mailbox, SESSION_ID, messageUuid)[0].released).toBe(true);
    });

    test('a legacy payload without deliveryMode delivers immediately', async () => {
      const { handler } = makeHandler();
      const entry = makeEntry({ origin: 'chat' });
      const job = claimMailboxJob(mailbox, entry);
      delete (job.payload as Record<string, unknown>).deliveryMode;

      const result = await handler(job);

      expect(result).toEqual({ kind: 'delivered', sessionId: SESSION_ID });
      expect(mailbox.sdkRows()[0].send_status).toBe('enqueued');
    });

    describe('retry-convergence law under hold', () => {
      test('a reclaim re-run converges on the single held row without minting or releasing', async () => {
        const { handler } = makeHandler();
        const entry = makeEntry({ origin: 'recovery', deliveryMode: 'defer' });
        const firstJob = claimMailboxJob(mailbox, entry);

        await handler(firstJob);

        expect(mailbox.sdkRows()).toHaveLength(1);
        expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
        expect(mailbox.sdkRows()[0].send_status).toBe('deferred');

        mailbox.jobQueue.reclaimStale(Date.now() + 60_000, [MAILBOX_LANE]);
        expect(mailbox.rows()[0].status).toBe('pending');

        const reclaims = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
        expect(reclaims).toHaveLength(1);
        const secondJob = reclaims[0];

        const secondResult = await handler(secondJob);

        expect(secondResult).toEqual({ kind: 'delivered', sessionId: SESSION_ID });
        const rows = mailbox.sdkRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].sdk_uuid).toBe(expectedMessageUuid(entry.id));
        expect(rows[0].send_status).toBe('deferred');
        expect(rows[0].origin).toBe('system');
        const pointers = deliveryPayloads(mailbox, SESSION_ID, expectedMessageUuid(entry.id));
        expect(pointers).toHaveLength(1);
        expect(pointers[0].released).toBe(false);
      });
    });
  });

  describe('retry-convergence law', () => {
    test('a reclaim re-run converges on the single content row instead of minting another', async () => {
      const { handler } = makeHandler();
      const entry = makeEntry({ origin: 'recovery' });
      const firstJob = claimMailboxJob(mailbox, entry);

      await handler(firstJob);

      expect(mailbox.sdkRows()).toHaveLength(1);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);

      mailbox.jobQueue.reclaimStale(Date.now() + 60_000, [MAILBOX_LANE]);
      expect(mailbox.rows()[0].status).toBe('pending');

      const reclaims = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
      expect(reclaims).toHaveLength(1);
      const secondJob = reclaims[0];

      const secondResult = await handler(secondJob);

      expect(secondResult).toEqual({ kind: 'delivered', sessionId: SESSION_ID });
      const rows = mailbox.sdkRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].sdk_uuid).toBe(expectedMessageUuid(entry.id));
      expect(rows[0].origin).toBe('system');
      expect(JSON.parse(rows[0].sdk_message)).toEqual({
        ...message,
        uuid: expectedMessageUuid(entry.id),
        session_id: SESSION_ID,
        isSynthetic: true,
      });
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
    });
  });

  describe('claim fence', () => {
    test('a claim that goes stale mid-handler injects nothing', async () => {
      let releaseSession: ((session: object | null) => void) | undefined;
      const gatedGetSession = (_sessionId: string): Promise<object | null> =>
        new Promise((resolve) => {
          releaseSession = resolve;
        });
      const { handler } = makeHandler(gatedGetSession);
      const entry = makeEntry();
      const job = claimMailboxJob(mailbox, entry);

      const pending = handler(job);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(releaseSession).toBeDefined();

      mailbox.jobQueue.reclaimStale(Date.now() + 60_000, [MAILBOX_LANE]);
      releaseSession?.({ ok: true });

      const result = await pending;
      expect(result).toEqual({ outcome: 'stale_attempt' });

      expect(mailbox.sdkRows()).toHaveLength(0);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);
    });
  });
});
