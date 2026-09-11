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
import { createDefaultSessionResolutionDeps } from '../../../../src/lib/session-resolution/default-deps';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';

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

  function sharedLookup() {
    const db = app!.db.getDatabase();
    return createDefaultSessionResolutionDeps({
      sessionManager: app!.sessionManager,
      taskAgentManager: app!.taskAgentManager,
      spaceRuntimeService: app!.spaceRuntimeService,
      nodeExecutionRepo: new NodeExecutionRepository(db),
      taskRepo: new SpaceTaskRepository(db),
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
    }).getSession;
  }

  function lookupSession(status = 'active', tools = false) {
    return {
      getSessionData: () => ({
        status,
        config: { mcpServers: tools ? { 'node-agent': { type: 'sdk' } } : {} },
      }),
    } as unknown as NonNullable<ReturnType<SessionManager['getCachedSession']>>;
  }

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

  describe.each(['indexed', 'async'] as const)('%s session lookup', (source) => {
    test.each([
      ['ordinary active', 'session', 'active', false, true, true],
      ['ordinary ended', 'session', 'ended', false, false, false],
      ['ordinary archived', 'session', 'archived', false, true, false],
      ['workflow bare', 'space:s:task:t:exec:e', 'active', false, false, false],
      ['workflow ready', 'space:s:task:t:exec:e', 'active', true, true, true],
      ['workflow archived', 'space:s:task:t:exec:e', 'archived', true, true, false],
    ] as const)(
      '%s preserves mailbox/shared eligibility',
      async (_label, sessionId, status, tools, mailboxAccepts, sharedAccepts) => {
        const session = lookupSession(status, tools);
        const indexed = spyOn(app!.taskAgentManager, 'getSubSession').mockReturnValue(
          source === 'indexed' ? session : undefined
        );
        const cached = spyOn(app!.sessionManager, 'getCachedSession').mockReturnValue(session);
        const asyncLookup = spyOn(app!.sessionManager, 'getSessionAsync').mockResolvedValue(
          session
        );
        expect(await deliveryDeps.getSession(sessionId)).toBe(mailboxAccepts ? session : null);
        expect(await sharedLookup()(sessionId)).toBe(sharedAccepts ? session : null);
        expect(indexed.mock.calls).toEqual([[sessionId], [sessionId]]);
        expect(cached.mock.calls).toEqual(source === 'indexed' ? [[sessionId], [sessionId]] : []);
        expect(asyncLookup.mock.calls).toEqual(
          source === 'async' ? [[sessionId], [sessionId]] : []
        );
      }
    );
  });

  test('both lookups fall back when the indexed session is not the cached instance', async () => {
    const stale = lookupSession('ended');
    const current = lookupSession();
    spyOn(app!.taskAgentManager, 'getSubSession').mockReturnValue(stale);
    spyOn(app!.sessionManager, 'getCachedSession').mockReturnValue(current);
    const asyncLookup = spyOn(app!.sessionManager, 'getSessionAsync').mockResolvedValue(current);
    expect(await deliveryDeps.getSession('session')).toBe(current);
    expect(await sharedLookup()('session')).toBe(current);
    expect(asyncLookup.mock.calls).toEqual([['session'], ['session']]);
  });

  test('both lookups preserve missing results and propagate async lookup errors', async () => {
    spyOn(app!.taskAgentManager, 'getSubSession').mockReturnValue(undefined);
    const cached = spyOn(app!.sessionManager, 'getCachedSession');
    const asyncLookup = spyOn(app!.sessionManager, 'getSessionAsync').mockResolvedValue(null);
    const resolve = sharedLookup();
    expect(await deliveryDeps.getSession('session')).toBeNull();
    expect(await resolve('session')).toBeNull();
    const error = new Error('lookup failed');
    asyncLookup.mockRejectedValue(error);
    await expect(deliveryDeps.getSession('session')).rejects.toBe(error);
    await expect(resolve('session')).rejects.toBe(error);
    expect(cached).not.toHaveBeenCalled();
    expect(asyncLookup.mock.calls).toEqual(Array.from({ length: 4 }, () => ['session']));
  });

  test('mailbox archive checks read current storage separately from session lookup', () => {
    const read = spyOn(app!.reactiveDb.db, 'getSession').mockReturnValue(null);
    expect(deliveryDeps.isSessionArchived('session')).toBe(false);
    read.mockReturnValue({ status: 'archived' } as NonNullable<
      ReturnType<DaemonAppContext['db']['getSession']>
    >);
    expect(deliveryDeps.isSessionArchived('session')).toBe(true);
    read.mockReturnValue({ status: 'active' } as NonNullable<
      ReturnType<DaemonAppContext['db']['getSession']>
    >);
    expect(deliveryDeps.isSessionArchived('session')).toBe(false);
    expect(read.mock.calls).toEqual([['session'], ['session'], ['session']]);
  });
});
