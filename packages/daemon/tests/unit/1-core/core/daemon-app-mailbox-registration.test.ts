import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { createDaemonApp, type DaemonAppContext } from '../../../../src/app';
import type { Config } from '../../../../src/config';
import { MAILBOX_EXPIRE_FIRE } from '../../../../src/lib/job-queue-constants';
import * as delivery from '../../../../src/lib/mailbox/delivery';
import * as replay from '../../../../src/lib/mailbox/deferred-replay-scheduler';
import * as failure from '../../../../src/lib/mailbox/failure';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { SessionManager } from '../../../../src/lib/session-manager';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';

if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
  (globalThis as { Bun?: unknown }).Bun = { serve: () => ({ stop() {} }) };
}

describe('Daemon app mailbox registration', () => {
  let app: DaemonAppContext | undefined;
  let settingsDir: string;
  let originalSettingsDir: string | undefined;
  let deliveryDeps: delivery.MailboxDeliveryDeps;
  let failureDeps: failure.MailboxFailureDeps;
  let deliveryHandler: ReturnType<typeof delivery.createMailboxDeliveryHandler>;
  let deadHandler: ReturnType<typeof failure.createMailboxDeadHandler>;
  let scheduler: ReturnType<typeof replay.createMailboxDeferredReplayScheduler>;
  let suppressReplay: (sessionId: string) => void;
  let registrations: Array<{
    owner: JobQueueProcessor;
    args: Parameters<JobQueueProcessor['register']>;
  }>;
  let lifecycle: string[];

  beforeEach(async () => {
    originalSettingsDir = process.env.TEST_USER_SETTINGS_DIR;
    settingsDir = mkdtempSync(join(tmpdir(), 'mailbox-registration-'));
    process.env.TEST_USER_SETTINGS_DIR = settingsDir;
    spyOn(Bun, 'serve').mockImplementation(() => ({ stop() {} }) as never);
    registrations = [];
    lifecycle = [];
    const register = JobQueueProcessor.prototype.register;
    spyOn(JobQueueProcessor.prototype, 'register').mockImplementation(function (...args) {
      registrations.push({ owner: this, args });
      lifecycle.push(args[0]);
      return register.apply(this, args);
    });
    spyOn(JobQueueProcessor.prototype, 'start').mockImplementation(() => {
      lifecycle.push('start');
    });
    const createDelivery = delivery.createMailboxDeliveryHandler;
    spyOn(delivery, 'createMailboxDeliveryHandler').mockImplementation((deps) => {
      deliveryDeps = deps;
      deliveryHandler = createDelivery(deps);
      return deliveryHandler;
    });
    const createFailure = failure.createMailboxDeadHandler;
    spyOn(failure, 'createMailboxDeadHandler').mockImplementation((log, deps) => {
      expect(deps).toBeDefined();
      failureDeps = deps!;
      deadHandler = createFailure(log, deps);
      return deadHandler;
    });
    const createReplay = replay.createMailboxDeferredReplayScheduler;
    spyOn(replay, 'createMailboxDeferredReplayScheduler').mockImplementation((deps) => {
      scheduler = createReplay(deps);
      return scheduler;
    });
    const setSuppressor = SessionManager.prototype.setMailboxDeferredReplaySuppressor;
    spyOn(SessionManager.prototype, 'setMailboxDeferredReplaySuppressor').mockImplementation(
      function (suppressor) {
        suppressReplay = suppressor;
        setSuppressor.call(this, suppressor);
      }
    );
    const config: Config = {
      host: 'localhost',
      port: 0,
      defaultModel: 'claude-sonnet-4-5-20250929',
      maxTokens: 8192,
      temperature: 1,
      dbPath: ':memory:',
      maxSessions: 10,
      maxSubscriptionsPerClient: 128,
      nodeEnv: 'test',
      disableWorktrees: true,
      structuredLogMaxBytes: 10 * 1024 * 1024,
      structuredLogRetainedFiles: 5,
      structuredLogMaxPendingBytes: 2 * 1024 * 1024,
    };
    app = await createDaemonApp({ config, verbose: false, standalone: false });
  }, 30_000);

  afterEach(async () => {
    try {
      await app?.cleanup();
    } finally {
      app = undefined;
      mock.restore();
      if (originalSettingsDir === undefined) delete process.env.TEST_USER_SETTINGS_DIR;
      else process.env.TEST_USER_SETTINGS_DIR = originalSettingsDir;
      rmSync(settingsDir, { recursive: true, force: true });
    }
  });

  test('registers session FIFO delivery and separate expiration before processors start', () => {
    const mailbox = registrations.filter(({ args }) => args[0] === MAILBOX_LANE);
    const expiration = registrations.filter(({ args }) => args[0] === MAILBOX_EXPIRE_FIRE);
    expect(mailbox).toHaveLength(1);
    expect(expiration).toHaveLength(1);
    expect(mailbox[0].owner).toBe(app!.jobProcessor);
    expect(mailbox[0].args[1]).toBe(deliveryHandler);
    expect(expiration[0].owner).not.toBe(app!.jobProcessor);
    expect(mailbox[0].args[2]).toEqual({
      dequeueMode: { kind: 'session-fifo', sessionIdPath: '$.to.sessionId' },
      onDead: deadHandler,
    });
    expect(lifecycle.indexOf(MAILBOX_EXPIRE_FIRE)).toBeLessThan(lifecycle.indexOf(MAILBOX_LANE));
    expect(lifecycle.indexOf(MAILBOX_LANE)).toBeLessThan(lifecycle.indexOf('start'));
    expect(deliveryDeps.jobQueue).toBe(app!.jobQueue);
    expect(deliveryDeps.db).toBe(app!.db.getDatabase());
    expect(deliveryDeps.sdkMessageRepo).toBe(app!.db.getSDKMessageRepo());
    expect(failureDeps.sdkMessageRepo).toBe(deliveryDeps.sdkMessageRepo);
  });

  test('publishes delivery, deferred and failure status using the current event bus', async () => {
    const publish = spyOn(app!.internalEventBus, 'publish').mockRejectedValue(new Error('offline'));
    deliveryDeps.publishStatusChanged!('session', 'enqueued-row', 'enqueued');
    await deliveryDeps.publishDeferredStatus!('session', 'deferred-row');
    await deliveryDeps.publishFailed!('session', 'failed-row');
    await failureDeps.publishFailed!('session', 'dead-row');
    expect(publish.mock.calls).toEqual([
      [
        'messages.statusChanged',
        { sessionId: 'session', messageIds: ['enqueued-row'], status: 'enqueued' },
      ],
      [
        'messages.statusChanged',
        { sessionId: 'session', messageIds: ['deferred-row'], status: 'deferred' },
      ],
      [
        'messages.statusChanged',
        { sessionId: 'session', messageIds: ['failed-row'], status: 'failed' },
      ],
      [
        'messages.statusChanged',
        { sessionId: 'session', messageIds: ['dead-row'], status: 'failed' },
      ],
    ]);
  });

  test('connects deferred replay scheduling and session suppression to the same owner', () => {
    const schedule = spyOn(scheduler, 'schedule').mockImplementation(() => {});
    const cancel = spyOn(scheduler, 'cancel').mockImplementation(() => {});
    deliveryDeps.scheduleDeferredReplay!('session');
    suppressReplay('session');
    expect(schedule.mock.calls).toEqual([['session']]);
    expect(cancel.mock.calls).toEqual([['session']]);
  });

  test('failure callbacks persist failed messages and look up the session when settling', async () => {
    const save = spyOn(app!.db, 'saveUserMessage').mockReturnValue('failed-row');
    const message = {
      type: 'user',
      session_id: 'session',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'undelivered' },
    } as SDKUserMessage;
    expect(failureDeps.saveFailed('session', message, 'system')).toBe('failed-row');
    expect(save.mock.calls).toEqual([['session', message, 'failed', 'system']]);
    const settle = mock(async () => {});
    const cached = spyOn(app!.sessionManager, 'getCachedSession').mockReturnValue(null);
    await failureDeps.settleSkipped!('session', 'message');
    cached.mockReturnValue({ settleSkippedDelivery: settle } as unknown as NonNullable<
      ReturnType<SessionManager['getCachedSession']>
    >);
    await failureDeps.settleSkipped!('session', 'message');
    expect(cached.mock.calls).toEqual([['session'], ['session']]);
    expect(settle.mock.calls).toEqual([['message']]);
  });
});
