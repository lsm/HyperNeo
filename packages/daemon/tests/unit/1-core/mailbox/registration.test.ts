import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import { MAILBOX_EXPIRE_FIRE, MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import * as delivery from '../../../../src/lib/mailbox/delivery';
import { createMailboxEntry } from '../../../../src/lib/mailbox/entry';
import { enqueueMailboxEntry, MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { registerMailboxJobs } from '../../../../src/lib/mailbox/registration';
import { createUlid } from '../../../../src/lib/mailbox/ulid';
import type { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

type Deps = Parameters<typeof registerMailboxJobs>[0];
type Registration = Parameters<JobQueueProcessor['register']>;

describe('registerMailboxJobs', () => {
  let mailbox: MailboxTestDb;
  let deps: Deps;
  let calls: Registration[];
  let expiration: Registration[];
  let deliveryDeps: delivery.MailboxDeliveryDeps;
  let suppress: (sessionId: string) => void;
  let order: string[];

  beforeEach(() => {
    mailbox = createMailboxTestDb();
    calls = [];
    expiration = [];
    order = [];
    deps = {
      jobQueue: mailbox.jobQueue,
      jobProcessor: {
        register: (...args) => {
          calls.push(args);
          order.push(args[0]);
        },
      },
      mailboxExpireProcessor: {
        register: (...args) => {
          expiration.push(args);
          order.push(args[0]);
        },
      },
      db: {
        getDatabase: () => mailbox.db,
        getSDKMessageRepo: () => mailbox.sdkMessageRepo,
        saveUserMessage: mock(() => 'failed-row'),
      },
      internalEventBus: createDaemonInternalEventBus(),
      sessionManager: {
        getCachedSession: mock(() => null),
        setMailboxDeferredReplaySuppressor: (callback) => {
          suppress = callback;
          order.push('suppressor');
        },
      },
      isSessionHeldByTaskLimit: mock(() => false),
      getSession: mock(async () => ({})),
      isSessionArchived: mock(() => false),
      logError: mock(() => {}),
    };
    const create = delivery.createMailboxDeliveryHandler;
    spyOn(delivery, 'createMailboxDeliveryHandler').mockImplementation((input) => {
      deliveryDeps = input;
      return create(input);
    });
  });

  afterEach(() => {
    mock.restore();
    mailbox.close();
  });

  test('registers synchronously without looking up sessions or starting delivery', () => {
    const scheduler = registerMailboxJobs(deps);
    expect(order).toEqual(['suppressor', MAILBOX_EXPIRE_FIRE, MAILBOX_LANE]);
    expect(calls).toHaveLength(1);
    expect(expiration).toHaveLength(1);
    expect(calls[0][2]).toEqual({
      dequeueMode: { kind: 'session-fifo', sessionIdPath: '$.to.sessionId' },
      onDead: expect.any(Function),
    });
    expect(expiration[0][2]).toBeUndefined();
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(mailbox.rowCount()).toBe(0);
    const schedule = spyOn(scheduler, 'schedule').mockImplementation(() => {});
    const cancel = spyOn(scheduler, 'cancel').mockImplementation(() => {});
    deliveryDeps.scheduleDeferredReplay!('session');
    suppress('session');
    expect(schedule.mock.calls).toEqual([['session']]);
    expect(cancel.mock.calls).toEqual([['session']]);
  });

  test('registered delivery materializes a prompt and publishes its status', async () => {
    registerMailboxJobs(deps);
    const publish = spyOn(deps.internalEventBus, 'publish');
    const entry = createMailboxEntry({
      to: { kind: 'session', sessionId: 'session' },
      origin: 'chat',
      messageUuid: 'message',
      message: {
        type: 'user',
        message: { role: 'user', content: 'hello' },
        parent_tool_use_id: null,
      },
    });
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const [job] = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
    await calls[0][1](job);
    expect(deps.getSession).toHaveBeenCalledWith('session');
    expect(mailbox.sdkRows()[0].sdk_uuid).toBe('message');
    expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
    expect(publish).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: 'session',
      messageIds: [mailbox.sdkRows()[0].id],
      status: 'enqueued',
    });
  });

  test.each([
    'dead',
    'expired',
  ] as const)('%s messages use failure persistence and publication', async (kind) => {
    registerMailboxJobs(deps);
    const publish = spyOn(deps.internalEventBus, 'publish');
    const entry = createMailboxEntry({
      to: { kind: 'session', sessionId: 'session' },
      origin: 'chat',
      messageUuid: 'message',
      message: {
        type: 'user',
        message: { role: 'user', content: 'hello' },
        parent_tool_use_id: null,
      },
    });
    entry.id = createUlid(Date.now() - entry.policy.ttlMs - 1000);
    enqueueMailboxEntry(mailbox.jobQueue, entry);
    const [job] = mailbox.jobQueue.listJobs({ queue: MAILBOX_LANE });
    if (kind === 'dead') calls[0][2]!.onDead!(job);
    else expect(await expiration[0][1](job)).toMatchObject({ expired: 1 });
    expect(deps.db.saveUserMessage).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ uuid: 'message', session_id: 'session' }),
      'failed',
      undefined
    );
    expect(publish).toHaveBeenCalledWith('messages.statusChanged', {
      sessionId: 'session',
      messageIds: ['failed-row'],
      status: 'failed',
    });
    expect(deps.sessionManager!.getCachedSession).toHaveBeenCalledWith('session');
  });

  test('status callbacks tolerate rejected publications with no session manager', async () => {
    deps.sessionManager = null;
    registerMailboxJobs(deps);
    const publish = spyOn(deps.internalEventBus, 'publish').mockRejectedValue(new Error('offline'));
    expect(deliveryDeps.publishStatusChanged!('session', 'row', 'enqueued')).toBeUndefined();
    await expect(deliveryDeps.publishDeferredStatus!('session', 'row')).resolves.toBeUndefined();
    await expect(deliveryDeps.publishFailed!('session', 'row')).resolves.toBeUndefined();
    expect(publish.mock.calls.map(([, payload]) => payload)).toEqual([
      { sessionId: 'session', messageIds: ['row'], status: 'enqueued' },
      { sessionId: 'session', messageIds: ['row'], status: 'deferred' },
      { sessionId: 'session', messageIds: ['row'], status: 'failed' },
    ]);
  });
});
