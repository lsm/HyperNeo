import { describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  MESSAGE_DELIVERY,
  MESSAGE_DELIVERY_MAX_RETRIES,
} from '../../../../src/lib/agent/message-delivery';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type {
  Job,
  JobQueueRepository,
} from '../../../../src/storage/repositories/job-queue-repository';
import type { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

const SESSION = 'sess-admission';

type StartupController = {
  calls: number;
  resolve: (result: 'started' | 'blocked') => void;
  reject: (error: unknown) => void;
};

type Fixture = {
  db: Database;
  agentSession: AgentSession;
  jobRepo: JobQueueRepository;
  sdkRepo: SDKMessageRepository;
  startup: StartupController;
  published: Array<{ channel: string; payload: unknown }>;
  admitLog: string[];
};

let admissionSeq = 0;

function setQueryPromise(agentSession: AgentSession): void {
  (agentSession as unknown as { queryPromise: Promise<void> }).queryPromise = new Promise<void>(
    () => {}
  );
}

async function makeFixture(): Promise<Fixture> {
  const db = await createTestDb();
  const session = createTestSession(SESSION);
  db.createSession(session);
  const bus: InternalEventBus<DaemonInternalEventMap> = await createTestInternalEventBus();
  const published: Array<{ channel: string; payload: unknown }> = [];
  const originalPublish = bus.publish.bind(bus);
  bus.publish = (async (channel: never, payload: never) => {
    published.push({
      channel,
      payload: JSON.parse(JSON.stringify(payload)),
      seq: ++admissionSeq,
    } as unknown as { channel: string; payload: unknown });
    return originalPublish(channel, payload);
  }) as typeof bus.publish;

  const agentSession = new AgentSession(
    db.getSession(SESSION) ?? session,
    db,
    new MessageHub(),
    bus,
    mock(async () => 'test-api-key'),
    undefined,
    undefined,
    undefined,
    undefined,
    { autoReplayPendingMessages: false }
  );

  const jobRepo = db.getJobQueueRepo();
  const sdkRepo = db.getSDKMessageRepo();

  const admitLog: string[] = [];
  const originalAdmit = agentSession.messageQueue.admitWithId.bind(agentSession.messageQueue);
  agentSession.messageQueue.admitWithId = (
    messageId: string,
    content: Parameters<typeof originalAdmit>[1],
    internal: boolean,
    options?: Parameters<typeof originalAdmit>[3]
  ): Promise<void> => {
    admitLog.push(`${++admissionSeq}:${messageId}`);
    return originalAdmit(messageId, content, internal, options);
  };

  let resolveStartup!: (result: 'started' | 'blocked') => void;
  let rejectStartup!: (error: unknown) => void;
  const startup: StartupController = {
    calls: 0,
    resolve: (result) => resolveStartup(result),
    reject: (error) => rejectStartup(error),
  };
  (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted: mock(() => {
      startup.calls++;
      return new Promise<'started' | 'blocked'>((resolve, reject) => {
        resolveStartup = resolve;
        rejectStartup = reject;
      });
    }),
    executeDeferredRestartIfPending: mock(async () => {}),
  };

  return { db, agentSession, jobRepo, sdkRepo, startup, published, admitLog };
}

type MessageContentLike = Record<string, unknown>;

function saveDeliveryRow(
  repo: SDKMessageRepository,
  uuid: string,
  content: string | MessageContentLike[],
  sendStatus: 'enqueued' | 'consumed' = 'enqueued'
): void {
  repo.saveUserMessage(
    SESSION,
    { type: 'user', uuid, message: { role: 'user', content } } as unknown as SDKMessage,
    sendStatus
  );
}

function claimDeliveryJob(
  jobRepo: JobQueueRepository,
  messageUuid: string,
  batchUuids?: string[]
): { jobId: string; claimToken: string } {
  jobRepo.enqueue({
    queue: MESSAGE_DELIVERY,
    payload: {
      sessionId: SESSION,
      messageUuid,
      role: 'turn',
      origin: 'chat',
      parentToolUseId: null,
      ...(batchUuids ? { batchUuids } : {}),
    },
    maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
  });
  const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
  if (!job || typeof job.claimToken !== 'string') throw new Error('delivery job not claimed');
  return { jobId: job.id, claimToken: job.claimToken };
}

function reservationOf(jobRepo: JobQueueRepository, jobId: string, messageUuid: string): unknown {
  const payload = jobRepo.getJob(jobId)?.payload as
    | { __admissionReservations?: Record<string, string> }
    | undefined;
  return payload?.__admissionReservations?.[messageUuid];
}

function batchPayloadOf(jobRepo: JobQueueRepository, jobId: string): string[] | undefined {
  const payload = jobRepo.getJob(jobId)?.payload as { batchUuids?: string[] } | undefined;
  return payload?.batchUuids;
}

function statusOf(db: Database, uuid: string): string {
  const row = db
    .getDatabase()
    .prepare(`SELECT send_status AS s FROM sdk_messages WHERE sdk_uuid = ? AND session_id = ?`)
    .get(uuid, SESSION) as { s: string | null } | undefined;
  return row?.s ?? 'missing';
}

async function until(predicate: () => boolean, what: string, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`test wait exhausted: ${what}`);
}

function observerOf(agentSession: AgentSession): unknown {
  return (agentSession as unknown as { deliveryResponseObserver: unknown })
    .deliveryResponseObserver;
}

function bumpGeneration(agentSession: AgentSession): void {
  const holder = agentSession as unknown as { _queryGeneration: number };
  holder._queryGeneration += 1;
}

describe('delivery-turn admission pipeline (A4b)', () => {
  it('records the durable startup intent before the query starts and keeps it after failure', async () => {
    const f = await makeFixture();
    try {
      saveDeliveryRow(f.sdkRepo, 'msg-intent', 'hello');
      const { jobId, claimToken } = claimDeliveryJob(f.jobRepo, 'msg-intent');
      const drive = f.agentSession.driveDeliveryTurn(
        'msg-intent',
        'hello',
        null,
        false,
        () => true,
        undefined,
        undefined,
        undefined,
        claimToken
      );
      await until(() => reservationOf(f.jobRepo, jobId, 'msg-intent') !== undefined, 'reservation');
      expect(reservationOf(f.jobRepo, jobId, 'msg-intent')).toBe(claimToken);

      f.startup.reject(new Error('test: provider failed'));
      await expect(drive).rejects.toThrow('test: provider failed');
      expect(reservationOf(f.jobRepo, jobId, 'msg-intent')).toBe(claimToken);
      expect(observerOf(f.agentSession)).toBeNull();
    } finally {
      f.db.close();
    }
  });

  it('skips query startup entirely when the reservation reports a stale claim', async () => {
    const f = await makeFixture();
    try {
      saveDeliveryRow(f.sdkRepo, 'msg-stale', 'hello');
      claimDeliveryJob(f.jobRepo, 'msg-stale');
      const outcome = await f.agentSession.driveDeliveryTurn(
        'msg-stale',
        'hello',
        null,
        false,
        () => true,
        undefined,
        undefined,
        undefined,
        'superseded-claim-token'
      );
      expect(outcome).toEqual({ outcome: 'aborted' });
      expect(f.startup.calls).toBe(0);
      expect(f.admitLog).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it('retries idempotently under the same live claim and admits exactly once', async () => {
    const f = await makeFixture();
    try {
      saveDeliveryRow(f.sdkRepo, 'msg-retry', 'hello');
      const { jobId, claimToken } = claimDeliveryJob(f.jobRepo, 'msg-retry');
      let guardLive = true;
      const guard = (): boolean => guardLive;

      const first = f.agentSession.driveDeliveryTurn(
        'msg-retry',
        'hello',
        null,
        false,
        guard,
        undefined,
        undefined,
        undefined,
        claimToken
      );
      await until(() => reservationOf(f.jobRepo, jobId, 'msg-retry') !== undefined, 'reservation');
      guardLive = false;
      f.startup.resolve('started');
      expect(await first).toEqual({ outcome: 'aborted' });
      expect(f.admitLog).toEqual([]);

      guardLive = true;
      setQueryPromise(f.agentSession);
      f.agentSession.messageQueue.start();
      const abort = new AbortController();
      const second = f.agentSession.driveDeliveryTurn(
        'msg-retry',
        'hello',
        null,
        false,
        guard,
        undefined,
        abort.signal,
        undefined,
        claimToken
      );
      await until(() => f.startup.calls >= 2, 'second startup');
      f.startup.resolve('started');
      await until(() => f.admitLog.length > 0, 'admission');
      expect(f.admitLog).toHaveLength(1);
      expect(reservationOf(f.jobRepo, jobId, 'msg-retry')).toBe(claimToken);
      abort.abort();
      await expect(second).rejects.toBeInstanceOf(Error);
      expect(f.admitLog).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });

  it('aborts without installing a waiter when cleanup begins during startup', async () => {
    const f = await makeFixture();
    try {
      saveDeliveryRow(f.sdkRepo, 'msg-cleanup', 'hello', 'consumed');
      let waiterInstalls = 0;
      const stateManager = f.agentSession.stateManager as unknown as {
        waitForIdleTransition: (...args: unknown[]) => {
          promise: Promise<void>;
          cancel: () => void;
        };
      };
      const originalWait = stateManager.waitForIdleTransition.bind(stateManager);
      stateManager.waitForIdleTransition = (...args: unknown[]) => {
        waiterInstalls++;
        return originalWait(...args);
      };

      const drive = f.agentSession.driveDeliveryTurn(
        'msg-cleanup',
        'hello',
        null,
        true,
        () => true,
        undefined,
        undefined,
        { reportStage: () => {} }
      );
      await until(() => f.startup.calls > 0, 'startup reached');
      f.agentSession.setCleaningUp(true);
      f.startup.resolve('started');

      expect(await drive).toEqual({ outcome: 'aborted' });
      expect(waiterInstalls).toBe(0);
      expect(observerOf(f.agentSession)).toBeNull();
      expect(f.admitLog).toEqual([]);
      stateManager.waitForIdleTransition = originalWait;
    } finally {
      f.db.close();
    }
  });

  it('aborts when the claim is superseded during startup, before waiter or admission', async () => {
    const f = await makeFixture();
    try {
      saveDeliveryRow(f.sdkRepo, 'msg-superseded', 'hello', 'consumed');
      let guardLive = true;
      let waiterInstalls = 0;
      const stateManager = f.agentSession.stateManager as unknown as {
        waitForIdleTransition: (...args: unknown[]) => {
          promise: Promise<void>;
          cancel: () => void;
        };
      };
      const originalWait = stateManager.waitForIdleTransition.bind(stateManager);
      stateManager.waitForIdleTransition = (...args: unknown[]) => {
        waiterInstalls++;
        return originalWait(...args);
      };

      const drive = f.agentSession.driveDeliveryTurn(
        'msg-superseded',
        'hello',
        null,
        true,
        () => guardLive
      );
      await until(() => f.startup.calls > 0, 'startup reached');
      guardLive = false;
      f.startup.resolve('started');

      expect(await drive).toEqual({ outcome: 'aborted' });
      expect(waiterInstalls).toBe(0);
      expect(f.admitLog).toEqual([]);
      stateManager.waitForIdleTransition = originalWait;
    } finally {
      f.db.close();
    }
  });

  it('trips the admission boundary on a mid-pass replacement and unwinds fenced writes', async () => {
    const f = await makeFixture();
    try {
      const kickoff = 'msg-kick-replace';
      const member = 'msg-member-replace';
      const dropped = 'msg-dropped-replace';
      saveDeliveryRow(f.sdkRepo, kickoff, 'kickoff text');
      saveDeliveryRow(f.sdkRepo, member, 'member text');
      saveDeliveryRow(f.sdkRepo, dropped, []);
      const { jobId, claimToken } = claimDeliveryJob(f.jobRepo, kickoff, [
        kickoff,
        member,
        dropped,
      ]);

      const originalNarrow = f.jobRepo.updateDeliveryBatchUuidsFenced.bind(f.jobRepo);
      f.jobRepo.updateDeliveryBatchUuidsFenced = (args) => {
        const result = originalNarrow(args);
        bumpGeneration(f.agentSession);
        return result;
      };
      setQueryPromise(f.agentSession);

      const drive = f.agentSession.driveDeliveryTurn(
        kickoff,
        'kickoff text',
        null,
        false,
        () => true,
        [kickoff, member, dropped],
        undefined,
        undefined,
        claimToken
      );
      await until(() => f.startup.calls > 0, 'startup reached');
      f.startup.resolve('started');

      expect(await drive).toEqual({ outcome: 'aborted' });
      expect(batchPayloadOf(f.jobRepo, jobId)).toEqual([kickoff, member, dropped]);
      expect(statusOf(f.db, member)).toBe('enqueued');
      expect(f.admitLog).toEqual([]);
      expect(
        f.published.filter((event) => String(event.channel).includes('statusChanged'))
      ).toEqual([]);
      expect(observerOf(f.agentSession)).toBeNull();
    } finally {
      f.db.close();
    }
  });

  it('unwinds submissions on a thrown admission error and never publishes submitted', async () => {
    const f = await makeFixture();
    try {
      const kickoff = 'msg-kick-boom';
      const member = 'msg-member-boom';
      const dropped = 'msg-dropped-boom';
      saveDeliveryRow(f.sdkRepo, kickoff, 'kickoff text');
      saveDeliveryRow(f.sdkRepo, member, 'member text');
      saveDeliveryRow(f.sdkRepo, dropped, []);
      const { jobId, claimToken } = claimDeliveryJob(f.jobRepo, kickoff, [
        kickoff,
        member,
        dropped,
      ]);
      setQueryPromise(f.agentSession);

      const boom = new Error('admit exploded');
      f.agentSession.messageQueue.admitWithId = (() => {
        throw boom;
      }) as typeof f.agentSession.messageQueue.admitWithId;

      const drive = f.agentSession.driveDeliveryTurn(
        kickoff,
        'kickoff text',
        null,
        false,
        () => true,
        [kickoff, member, dropped],
        undefined,
        undefined,
        claimToken
      );
      await until(() => f.startup.calls > 0, 'startup reached');
      f.startup.resolve('started');

      let caught: unknown = null;
      try {
        await drive;
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(boom);
      expect(batchPayloadOf(f.jobRepo, jobId)).toEqual([kickoff, member, dropped]);
      expect(statusOf(f.db, member)).toBe('enqueued');
      expect(
        f.published.filter((event) => String(event.channel).includes('statusChanged'))
      ).toEqual([]);
      expect(observerOf(f.agentSession)).toBeNull();
    } finally {
      f.db.close();
    }
  });

  it('publishes the member submission only after admission commits', async () => {
    const f = await makeFixture();
    try {
      const kickoff = 'msg-kick-commit';
      const member = 'msg-member-commit';
      saveDeliveryRow(f.sdkRepo, kickoff, 'kickoff text');
      saveDeliveryRow(f.sdkRepo, member, 'member text');
      const { claimToken } = claimDeliveryJob(f.jobRepo, kickoff, [kickoff, member]);
      setQueryPromise(f.agentSession);
      const abort = new AbortController();

      const drive = f.agentSession.driveDeliveryTurn(
        kickoff,
        'kickoff text',
        null,
        false,
        () => true,
        [kickoff, member],
        abort.signal,
        undefined,
        claimToken
      );
      await until(() => f.startup.calls > 0, 'startup reached');
      f.startup.resolve('started');
      await until(
        () =>
          f.published.some(
            (event) =>
              String(event.channel).includes('statusChanged') &&
              JSON.stringify(event.payload).includes('submitted')
          ),
        'deferred submission publication'
      );
      expect(f.admitLog).toHaveLength(1);
      expect(Number(f.admitLog[0].split(':')[0])).toBeLessThan(admissionSeq);
      expect(statusOf(f.db, member)).toBe('submitted');

      abort.abort();
      await expect(drive).rejects.toBeInstanceOf(Error);
    } finally {
      f.db.close();
    }
  });

  it('restores an erased crash-recovery marker when the pass fails', async () => {
    const f = await makeFixture();
    try {
      saveDeliveryRow(f.sdkRepo, 'msg-redrive', 'hello', 'consumed');
      f.sdkRepo.recordDeliveryTurnEnd(SESSION, 'msg-redrive', '2026-08-25T00:00:00.000Z');
      expect(f.sdkRepo.hasDeliveryTurnEnd(SESSION, 'msg-redrive')).toBe(true);

      const drive = f.agentSession.driveDeliveryTurn('msg-redrive', 'hello', null, true);
      await until(() => f.startup.calls > 0, 'startup reached');
      f.startup.reject(new Error('test: startup rejected'));

      await expect(drive).rejects.toThrow('test: startup rejected');
      expect(f.sdkRepo.hasDeliveryTurnEnd(SESSION, 'msg-redrive')).toBe(true);
    } finally {
      f.db.close();
    }
  });

  it('halts at the entry gate before any effect, including query startup', async () => {
    const f = await makeFixture();
    try {
      const outcome = await f.agentSession.driveDeliveryTurn(
        'msg-missing-row',
        'hello',
        null,
        false,
        () => true
      );
      expect(outcome).toEqual({ outcome: 'aborted' });
      expect(f.startup.calls).toBe(0);
      expect(f.admitLog).toEqual([]);
      expect(f.published).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it('keeps the legacy no-claim path unfenced with immediate submission publication', async () => {
    const f = await makeFixture();
    try {
      const kickoff = 'msg-kick-legacy';
      const member = 'msg-member-legacy';
      const dropped = 'msg-dropped-legacy';
      saveDeliveryRow(f.sdkRepo, kickoff, 'kickoff text');
      saveDeliveryRow(f.sdkRepo, member, 'member text');
      saveDeliveryRow(f.sdkRepo, dropped, []);
      claimDeliveryJob(f.jobRepo, kickoff, [kickoff, member, dropped]);

      const failIfCalled = () => {
        throw new Error('fenced primitive must not run without a claim context');
      };
      f.jobRepo.updateDeliveryBatchUuidsFenced = failIfCalled as never;
      f.jobRepo.transitionDeliverySendStatusFenced = failIfCalled as never;
      f.jobRepo.reserveDeliveryAdmission = failIfCalled as never;

      const boom = new Error('admit exploded');
      f.agentSession.messageQueue.admitWithId = (() => {
        throw boom;
      }) as typeof f.agentSession.messageQueue.admitWithId;
      setQueryPromise(f.agentSession);

      const drive = f.agentSession.driveDeliveryTurn(
        kickoff,
        'kickoff text',
        null,
        false,
        () => true,
        [kickoff, member, dropped]
      );
      await until(() => f.startup.calls > 0, 'startup reached');
      f.startup.resolve('started');

      let caught: unknown = null;
      try {
        await drive;
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(boom);
      expect(statusOf(f.db, member)).toBe('submitted');
      expect(
        f.published.filter(
          (event) =>
            String(event.channel).includes('statusChanged') &&
            JSON.stringify(event.payload).includes('submitted')
        ).length
      ).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it('TODO(message-delivery redesign): a durable kickoff settled by the queue yield timeout is currently marked consumed exactly like a real send acceptance — tripwire: rewrite when the timeout stops counting as acceptance', async () => {
    const f = await makeFixture();
    try {
      const kickoff = 'msg-timeout-acceptance';
      saveDeliveryRow(f.sdkRepo, kickoff, 'kickoff text');
      setQueryPromise(f.agentSession);
      f.agentSession.messageQueue.overrideTimeoutMsForTest(25);
      const abort = new AbortController();

      const drive = f.agentSession.driveDeliveryTurn(
        kickoff,
        'kickoff text',
        null,
        false,
        () => true,
        undefined,
        abort.signal
      );
      await until(() => f.startup.calls > 0, 'startup reached');
      f.startup.resolve('started');
      await until(() => f.admitLog.length > 0, 'admission');

      f.agentSession.messageQueue.start();
      const transport = f.agentSession.messageQueue.messageGenerator(SESSION, {
        suppressPreYieldCallback: true,
        queryGeneration: 1,
      });
      const yielded = await transport.next();
      expect(yielded.value.message.uuid).toBe(kickoff);
      expect(statusOf(f.db, kickoff)).toBe('enqueued');

      await until(() => statusOf(f.db, kickoff) === 'consumed', 'timeout acceptance flip', 2000);

      abort.abort();
      await expect(drive).rejects.toBeInstanceOf(Error);
    } finally {
      f.db.close();
    }
  });

  it('TODO(message-delivery redesign, #1686): a pre-ack query restart currently re-feeds a consumed kickoff through the production requeue path — flip duplicateFed to false when the redesign fixes it', async () => {
    const f = await makeFixture();
    try {
      const kickoff = 'msg-consumed-requeue';
      saveDeliveryRow(f.sdkRepo, kickoff, 'kickoff text');
      let resolveQueryEnd!: () => void;
      (f.agentSession as unknown as { queryPromise: Promise<void> }).queryPromise =
        new Promise<void>((resolve) => {
          resolveQueryEnd = resolve;
        });
      const driveSettled = f.agentSession
        .driveDeliveryTurn(kickoff, 'kickoff text', null, false, () => true)
        .then(
          () => 'resolved',
          (error: unknown) => error
        );
      await until(() => f.startup.calls > 0, 'startup reached');
      f.startup.resolve('started');
      await until(() => f.admitLog.length > 0, 'admission');

      f.agentSession.messageQueue.start();
      const firstTransport = f.agentSession.messageQueue.messageGenerator(SESSION, {
        suppressPreYieldCallback: true,
        queryGeneration: 1,
      });
      const firstSubmission = await firstTransport.next();
      expect(firstSubmission.value.message.uuid).toBe(kickoff);
      expect(f.sdkRepo.markDeliveryConsumedByUuid(SESSION, kickoff)).not.toBeNull();

      resolveQueryEnd();
      await until(
        () => statusOf(f.db, kickoff) === 'enqueued',
        'delivery turn reopened the consumed kickoff'
      );

      const secondTransport = f.agentSession.messageQueue.messageGenerator(SESSION, {
        suppressPreYieldCallback: true,
        queryGeneration: 2,
      });
      const secondSubmission = await Promise.race([
        secondTransport.next(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 250)
        ),
      ]);
      const duplicateFed = !(
        secondSubmission.done === true && secondSubmission.value === undefined
      );
      expect(duplicateFed).toBe(true);

      expect(await driveSettled).toBeInstanceOf(Error);
    } finally {
      f.db.close();
    }
  });
});
