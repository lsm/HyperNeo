import { describe, expect, mock, test } from 'bun:test';
import type { StructuredLogEvent } from '@hyperneo/shared';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import {
  clearStructuredLogSubscribers,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import {
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxEntryPolicy,
  type MailboxMessage,
} from '../../../../src/lib/mailbox/entry';
import {
  buildFailureMessageStage,
  createMailboxDeadHandler,
  type MailboxFailureCtx,
  type MailboxFailureDeps,
  materializeMailboxFailure,
  notifyFailureObserversStage,
  sessionFailureTarget,
} from '../../../../src/lib/mailbox/failure';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const SESSION_ID = 'sess-1';

const message: MailboxMessage = {
  type: 'user',
  message: { content: 'hello from the mailbox' },
  parent_tool_use_id: null,
};

const stubDeps = (overrides?: Partial<MailboxFailureDeps>): MailboxFailureDeps => ({
  sdkMessageRepo: {} as MailboxFailureDeps['sdkMessageRepo'],
  saveFailed: () => 'stub-row',
  ...overrides,
});

function makeEntry(overrides?: {
  id?: string;
  to?: MailboxEntry['to'];
  origin?: string;
  policy?: Partial<MailboxEntryPolicy>;
  message?: MailboxMessage;
  messageUuid?: string;
}): MailboxEntry {
  return {
    id: overrides?.id ?? createUlid(),
    to: overrides?.to ?? { kind: 'session', sessionId: SESSION_ID },
    origin: overrides?.origin ?? 'test',
    message: overrides?.message ?? message,
    ...(overrides?.messageUuid !== undefined ? { messageUuid: overrides.messageUuid } : {}),
    status: 'enqueued',
    policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY, ...overrides?.policy },
    deliveryMode: 'immediate',
  };
}

function makeDeadJob(payload: Record<string, unknown>, error: string | null): Job {
  return {
    id: 'job-1',
    queue: MAILBOX_LANE,
    status: 'dead',
    payload,
    result: null,
    error,
    priority: 0,
    maxRetries: 3,
    retryCount: 3,
    runAt: 1,
    createdAt: 1,
    startedAt: 1,
    heartbeatAt: 1,
    completedAt: 1,
    claimToken: null,
  } as Job;
}

function claimMailboxJob(mailbox: MailboxTestDb, entry: MailboxEntry): Job {
  const outcome = enqueueMailboxEntry(mailbox.jobQueue, entry);
  expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
  const claimed = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
  expect(claimed).toHaveLength(1);
  return claimed[0];
}

describe('createMailboxDeadHandler', () => {
  test('logs a valid entry id and job error without writing a settlement', () => {
    const messages: string[] = [];
    const handler = createMailboxDeadHandler((message) => messages.push(message));
    const job = makeDeadJob({ id: 'entry-1' }, 'delivery failed');

    expect(handler(job)).toBeUndefined();
    expect(messages).toEqual(['mailbox: entry entry-1 dead-lettered: delivery failed']);
    expect(job.result).toBeNull();
  });

  test('materializes a seeded failed row when delivery dies before content creation', async () => {
    const mailbox = createMailboxTestDb();
    const publishFailed = mock(async () => {});
    const entry = makeEntry({ origin: 'chat', messageUuid: 'accepted-message' });
    const job = claimMailboxJob(mailbox, entry);
    const settleSkipped = mock(async () => {});
    const handler = createMailboxDeadHandler(() => {}, {
      sdkMessageRepo: mailbox.sdkMessageRepo,
      saveFailed: (sessionId, message, origin) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, 'failed', origin),
      publishFailed,
      settleSkipped,
    });
    job.status = 'dead';
    job.error = 'mailbox: target session archived';

    handler(job);
    await Promise.resolve();

    const row = mailbox.sdkRows()[0];
    expect(row.sdk_uuid).toBe('accepted-message');
    expect(row.send_status).toBe('failed');
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(0);
    expect(publishFailed).toHaveBeenCalledWith(SESSION_ID, row.id);
    expect(settleSkipped).toHaveBeenCalledWith(SESSION_ID, 'accepted-message');
    mailbox.close();
  });

  test('reuses the existing failed row when delivery dies after marking the row failed', async () => {
    const mailbox = createMailboxTestDb();
    const entry = makeEntry({ origin: 'chat', messageUuid: 'archived-then-failed' });
    const persisted = mailbox.sdkMessageRepo.saveUserMessage(
      SESSION_ID,
      {
        ...message,
        uuid: 'archived-then-failed',
        session_id: SESSION_ID,
      },
      'failed'
    );
    const job = claimMailboxJob(mailbox, entry);
    const publishFailed = mock(async () => {});
    const saveFailed = mock(
      (_sessionId: string, _msg: typeof message, _origin?: string) => persisted
    );
    const handler = createMailboxDeadHandler(() => {}, {
      sdkMessageRepo: mailbox.sdkMessageRepo,
      saveFailed,
      publishFailed,
    });
    job.status = 'dead';
    job.error = 'mailbox: target session archived';

    handler(job);
    await Promise.resolve();

    expect(saveFailed).not.toHaveBeenCalled();
    expect(mailbox.sdkRows()).toHaveLength(1);
    expect(publishFailed).toHaveBeenCalledWith(SESSION_ID, persisted);
    mailbox.close();
  });

  test('logs a corrupt payload without throwing or writing a settlement', () => {
    const messages: string[] = [];
    const handler = createMailboxDeadHandler((message) => messages.push(message));
    const job = makeDeadJob({ garbage: true }, null);

    expect(handler(job)).toBeUndefined();
    expect(messages).toEqual(['mailbox: entry unknown dead-lettered: unknown error']);
    expect(job.result).toBeNull();
  });

  test('emits a structured error event instead of escaping when the chain throws', () => {
    const mailbox = createMailboxTestDb();
    const events: StructuredLogEvent[] = [];
    const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
    const publishFailed = mock(async () => {});
    const settleSkipped = mock(async () => {});
    const deps: MailboxFailureDeps = {
      sdkMessageRepo: mailbox.sdkMessageRepo,
      saveFailed: () => {
        throw new Error('boom');
      },
      publishFailed,
      settleSkipped,
    };
    const entry = makeEntry({ origin: 'chat', messageUuid: 'boom-uuid' });
    const job = claimMailboxJob(mailbox, entry);
    const handler = createMailboxDeadHandler(() => {}, deps);

    expect(() => handler(job)).not.toThrow();
    unsubscribe();
    clearStructuredLogSubscribers();

    const event = events.find(
      (candidate) => candidate.module === 'hyperneo:daemon:mailbox:materialize-failure'
    );
    expect(event?.level).toBe('error');
    expect(event?.metadata).toMatchObject({
      entryId: entry.id,
      sessionId: SESSION_ID,
      messageUuid: 'boom-uuid',
      error: 'boom',
    });
    expect(publishFailed).not.toHaveBeenCalled();
    expect(settleSkipped).toHaveBeenCalledWith(SESSION_ID, 'boom-uuid');
    mailbox.close();
  });
});

describe('materializeMailboxFailure', () => {
  test('skips entries addressed to an agent instead of a session', () => {
    const saveFailed = mock(() => 'should-not-happen');
    const entry = makeEntry({
      to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder' },
      messageUuid: 'agent-uuid',
    });

    materializeMailboxFailure(makeDeadJob(entry, 'delivery failed'), {
      sdkMessageRepo: {} as MailboxFailureDeps['sdkMessageRepo'],
      saveFailed,
    });

    expect(saveFailed).not.toHaveBeenCalled();
  });

  test('skips session entries admitted without a message uuid', () => {
    const saveFailed = mock(() => 'should-not-happen');
    const entry = makeEntry();

    materializeMailboxFailure(makeDeadJob(entry, 'delivery failed'), {
      sdkMessageRepo: {} as MailboxFailureDeps['sdkMessageRepo'],
      saveFailed,
    });

    expect(saveFailed).not.toHaveBeenCalled();
  });

  test('keeps the no-throw contract when publishFailed throws synchronously', async () => {
    const mailbox = createMailboxTestDb();
    const settleSkipped = mock(async () => {});
    const deps: MailboxFailureDeps = {
      sdkMessageRepo: mailbox.sdkMessageRepo,
      saveFailed: (sessionId, message, origin) =>
        mailbox.sdkMessageRepo.saveUserMessage(sessionId, message, 'failed', origin),
      publishFailed: () => {
        throw new Error('publish boom');
      },
      settleSkipped,
    };
    const entry = makeEntry({ origin: 'chat', messageUuid: 'sync-throw-uuid' });
    const job = claimMailboxJob(mailbox, entry);

    expect(() => materializeMailboxFailure(job, deps)).not.toThrow();
    await Promise.resolve();

    const row = mailbox.sdkRows()[0];
    expect(row.send_status).toBe('failed');
    expect(settleSkipped).toHaveBeenCalledWith(SESSION_ID, 'sync-throw-uuid');
    mailbox.close();
  });
});

describe('failure pipeline stages', () => {
  test('sessionFailureTarget targets only session entries admitted with a message uuid', () => {
    expect(sessionFailureTarget(makeEntry({ messageUuid: 'uuid-1' }))).toEqual({
      sessionId: SESSION_ID,
      messageUuid: 'uuid-1',
    });
    expect(
      sessionFailureTarget(
        makeEntry({
          to: { kind: 'agent', spaceId: 'sp-1', handle: 'coder' },
          messageUuid: 'uuid-1',
        })
      )
    ).toBeNull();
    expect(sessionFailureTarget(makeEntry())).toBeNull();
    expect(sessionFailureTarget(null)).toBeNull();
  });

  test('buildFailureMessageStage stamps synthetic provenance for non-chat origins', () => {
    const entry = makeEntry({ origin: 'space_agent', messageUuid: 'uuid-1' });
    const ctx = buildFailureMessageStage({
      job: makeDeadJob(entry, null),
      deps: stubDeps(),
      entry,
      target: sessionFailureTarget(entry) ?? undefined,
    });

    expect(ctx.message).toMatchObject({
      uuid: 'uuid-1',
      session_id: SESSION_ID,
      isSynthetic: true,
    });
  });

  test('buildFailureMessageStage keeps chat-origin messages human', () => {
    const entry = makeEntry({ origin: 'chat', messageUuid: 'uuid-2' });
    const ctx = buildFailureMessageStage({
      job: makeDeadJob(entry, null),
      deps: stubDeps(),
      entry,
      target: sessionFailureTarget(entry) ?? undefined,
    });

    expect(ctx.message).toMatchObject({ uuid: 'uuid-2', session_id: SESSION_ID });
    expect(ctx.message?.isSynthetic).toBeUndefined();
  });

  test('a synchronously throwing publishFailed does not escape and settleSkipped still runs', async () => {
    const settleSkipped = mock(async () => {});
    const ctx: MailboxFailureCtx = {
      job: makeDeadJob({}, null),
      deps: stubDeps({
        publishFailed: () => {
          throw new Error('sync boom');
        },
        settleSkipped,
      }),
      entry: null,
      target: { sessionId: SESSION_ID, messageUuid: 'uuid-1' },
      failedId: 'row-1',
    };

    expect(() => notifyFailureObserversStage(ctx)).not.toThrow();
    await Promise.resolve();

    expect(settleSkipped).toHaveBeenCalledWith(SESSION_ID, 'uuid-1');
  });

  test('settleSkipped still runs when the persist chain failed', async () => {
    const publishFailed = mock(async () => {});
    const settleSkipped = mock(async () => {});
    const ctx: MailboxFailureCtx = {
      job: makeDeadJob({}, null),
      deps: stubDeps({ publishFailed, settleSkipped }),
      entry: null,
      target: { sessionId: SESSION_ID, messageUuid: 'uuid-9' },
    };

    notifyFailureObserversStage(ctx);
    await Promise.resolve();

    expect(publishFailed).not.toHaveBeenCalled();
    expect(settleSkipped).toHaveBeenCalledWith(SESSION_ID, 'uuid-9');
  });
});
