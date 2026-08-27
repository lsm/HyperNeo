import { describe, expect, it, mock } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import type { MessageContent, Provider, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  buildBatchedDeliveryContent,
  MESSAGE_DELIVERY,
  MESSAGE_DELIVERY_MAX_RETRIES,
  MESSAGE_DELIVERY_PARK_MS,
  type DeliveryLoadResult,
  type MessageDeliveryAttemptObserver,
  type MessageDeliverySession,
} from '../../../../src/lib/agent/message-delivery';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import { deliveryMetrics } from '../../../../src/lib/agent/message-delivery-metrics';
import { createMessageDeliveryHandler } from '../../../../src/lib/job-handlers/message-delivery.handler';
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

type DeliveryTranscriptEvent =
  | {
      op: 'queue:admit';
      messageId: string;
      content: string | MessageContent[];
      internal: boolean;
      durable?: boolean;
      prepend?: boolean;
    }
  | { op: 'queue:admitResolve'; messageId: string }
  | { op: 'queue:remove'; messageId: string; found: boolean }
  | { op: 'queue:requeueYielded'; messageId: string; found: boolean }
  | { op: 'queue:clear' }
  | { op: 'db:markConsumed'; sessionId: string; uuid: string; dbId: string | null }
  | { op: 'db:updateMessageTimestamp'; sessionId: string; uuid: string; dbId: string; at: number }
  | { op: 'db:markConsumedBatch'; sessionId: string; uuids: string[]; dbIds: string[] }
  | { op: 'db:markSubmittedBatch'; sessionId: string; uuids: string[]; dbIds: string[] }
  | { op: 'db:markRetryable'; sessionId: string; uuid: string; dbId: string | null }
  | { op: 'db:markFailed'; sessionId: string; uuid: string; dbId: string | null }
  | { op: 'db:recordTurnEnd'; sessionId: string; uuid: string }
  | { op: 'db:clearTurnEnd'; sessionId: string; uuid: string }
  | { op: 'job:requeue'; jobId: string; runAt: number; claimToken: string | null }
  | { op: 'job:requeueParked'; jobId: string; runAt: number; claimToken: string | null }
  | { op: 'job:requeueAs'; jobId: string; role: string; runAt: number; claimToken: string | null }
  | { op: 'job:isClaimCurrent'; jobId: string; result: boolean; claimToken: string | null }
  | { op: 'job:getParkCount'; jobId: string; result: number }
  | {
      op: 'job:narrowBatch';
      sessionId: string;
      kickoffUuid: string;
      admitted: string[];
      dropped: string[];
      settleableDropped: string[];
      result: boolean;
    }
  | { op: 'state:clearQueuedIfOwnedBy'; uuid: string }
  | { op: 'state:setQueuedIfIdle'; uuid: string; result: boolean }
  | { op: 'state:setQueued'; uuid: string };

type DeliveryTranscriptHarness = {
  transcript: DeliveryTranscriptEvent[];
  reset: () => void;
  restore: () => void;
};

function instrumentDeliveryTranscript(
  db: Database,
  agentSession: AgentSession
): DeliveryTranscriptHarness {
  const transcript: DeliveryTranscriptEvent[] = [];
  const queue = agentSession.messageQueue as MessageQueue;
  const originalAdmit = queue.admitWithId.bind(queue);
  const originalRemove = queue.remove.bind(queue);
  const originalRequeueYielded = queue.requeueYielded.bind(queue);
  const originalClear = queue.clear.bind(queue);

  queue.admitWithId = (
    messageId: string,
    content: string | MessageContent[],
    internal: boolean,
    options?: { durable?: boolean; prepend?: boolean }
  ): Promise<void> => {
    const event: DeliveryTranscriptEvent = {
      op: 'queue:admit',
      messageId,
      content,
      internal,
    };
    if (options?.durable !== undefined) event.durable = options.durable;
    if (options?.prepend !== undefined) event.prepend = options.prepend;
    transcript.push(event);
    const promise = originalAdmit(messageId, content, internal, options);
    promise.then(
      () => {
        transcript.push({ op: 'queue:admitResolve', messageId });
      },
      () => {}
    );
    return promise;
  };

  queue.remove = (messageId: string): boolean => {
    const found = originalRemove(messageId);
    transcript.push({ op: 'queue:remove', messageId, found });
    return found;
  };

  queue.requeueYielded = (messageId: string): boolean => {
    const found = originalRequeueYielded(messageId);
    transcript.push({ op: 'queue:requeueYielded', messageId, found });
    return found;
  };

  queue.clear = (): void => {
    originalClear();
    transcript.push({ op: 'queue:clear' });
  };

  const sdkRepo = db.getSDKMessageRepo();
  const jobRepo = db.getJobQueueRepo();

  const sdkOriginals = {
    markDeliveryConsumedByUuid: sdkRepo.markDeliveryConsumedByUuid.bind(sdkRepo),
    markDeliveryConsumedByUuids: sdkRepo.markDeliveryConsumedByUuids.bind(sdkRepo),
    markDeliverySubmittedByUuids: sdkRepo.markDeliverySubmittedByUuids.bind(sdkRepo),
    markDeliveryRetryableByUuid: sdkRepo.markDeliveryRetryableByUuid.bind(sdkRepo),
    markDeliveryFailedByUuid: sdkRepo.markDeliveryFailedByUuid.bind(sdkRepo),
    recordDeliveryTurnEnd: sdkRepo.recordDeliveryTurnEnd.bind(sdkRepo),
    clearDeliveryTurnEnd: sdkRepo.clearDeliveryTurnEnd.bind(sdkRepo),
  };

  sdkRepo.markDeliveryConsumedByUuid = (sessionId: string, uuid: string): string | null => {
    const dbId = sdkOriginals.markDeliveryConsumedByUuid(sessionId, uuid);
    transcript.push({ op: 'db:markConsumed', sessionId, uuid, dbId });
    return dbId;
  };
  sdkRepo.markDeliveryConsumedByUuids = (sessionId: string, uuids: string[]): string[] => {
    const dbIds = sdkOriginals.markDeliveryConsumedByUuids(sessionId, uuids);
    transcript.push({ op: 'db:markConsumedBatch', sessionId, uuids, dbIds });
    return dbIds;
  };
  sdkRepo.markDeliverySubmittedByUuids = (sessionId: string, uuids: string[]): string[] => {
    const dbIds = sdkOriginals.markDeliverySubmittedByUuids(sessionId, uuids);
    transcript.push({ op: 'db:markSubmittedBatch', sessionId, uuids, dbIds });
    return dbIds;
  };
  sdkRepo.markDeliveryRetryableByUuid = (sessionId: string, uuid: string): string | null => {
    const dbId = sdkOriginals.markDeliveryRetryableByUuid(sessionId, uuid);
    transcript.push({ op: 'db:markRetryable', sessionId, uuid, dbId });
    return dbId;
  };
  sdkRepo.markDeliveryFailedByUuid = (sessionId: string, uuid: string): string | null => {
    const dbId = sdkOriginals.markDeliveryFailedByUuid(sessionId, uuid);
    transcript.push({ op: 'db:markFailed', sessionId, uuid, dbId });
    return dbId;
  };
  sdkRepo.recordDeliveryTurnEnd = (
    sessionId: string,
    messageUuid: string,
    endedAt: string
  ): void => {
    sdkOriginals.recordDeliveryTurnEnd(sessionId, messageUuid, endedAt);
    transcript.push({ op: 'db:recordTurnEnd', sessionId, uuid: messageUuid });
  };
  sdkRepo.clearDeliveryTurnEnd = (sessionId: string, messageUuid: string): void => {
    sdkOriginals.clearDeliveryTurnEnd(sessionId, messageUuid);
    transcript.push({ op: 'db:clearTurnEnd', sessionId, uuid: messageUuid });
  };

  const dbOriginals = {
    updateMessageStatus: db.updateMessageStatus.bind(db),
    updateMessageTimestamp: db.updateMessageTimestamp.bind(db),
  };

  const messageRowLookup = db
    .getDatabase()
    .prepare('SELECT session_id, sdk_uuid FROM sdk_messages WHERE id = ?');

  db.updateMessageStatus = (...args: Parameters<Database['updateMessageStatus']>) => {
    dbOriginals.updateMessageStatus(...args);
    const [messageIds, newStatus] = args;
    if (newStatus !== 'consumed') return;
    for (const dbId of [...new Set(messageIds)]) {
      const row = messageRowLookup.get(dbId) as
        | { session_id: string; sdk_uuid: string | null }
        | undefined;
      if (!row) continue;
      transcript.push({
        op: 'db:markConsumed',
        sessionId: row.session_id,
        uuid: row.sdk_uuid ?? '',
        dbId,
      });
    }
  };

  db.updateMessageTimestamp = (...args: Parameters<Database['updateMessageTimestamp']>) => {
    dbOriginals.updateMessageTimestamp(...args);
    const [dbId, timestampMs] = args;
    const row = messageRowLookup.get(dbId) as
      | { session_id: string; sdk_uuid: string | null }
      | undefined;
    if (!row) return;
    transcript.push({
      op: 'db:updateMessageTimestamp',
      sessionId: row.session_id,
      uuid: row.sdk_uuid ?? '',
      dbId,
      at: timestampMs ?? Date.now(),
    });
  };

  const jobOriginals = {
    requeue: jobRepo.requeue.bind(jobRepo),
    requeueParked: jobRepo.requeueParked.bind(jobRepo),
    requeueAs: jobRepo.requeueAs.bind(jobRepo),
    isClaimCurrent: jobRepo.isClaimCurrent.bind(jobRepo),
    getParkCount: jobRepo.getParkCount.bind(jobRepo),
    getActiveDeliveryBatchUuids: jobRepo.getActiveDeliveryBatchUuids.bind(jobRepo),
    narrowActiveDeliveryBatchUuids: jobRepo.narrowActiveDeliveryBatchUuids.bind(jobRepo),
  };

  jobRepo.requeue = (
    jobId: string,
    runAt: number,
    claimToken?: string | null
  ): ReturnType<JobQueueRepository['requeue']> => {
    transcript.push({ op: 'job:requeue', jobId, runAt, claimToken: claimToken ?? null });
    return jobOriginals.requeue(jobId, runAt, claimToken);
  };
  jobRepo.requeueParked = (
    jobId: string,
    runAt: number,
    claimToken?: string | null
  ): ReturnType<JobQueueRepository['requeueParked']> => {
    transcript.push({ op: 'job:requeueParked', jobId, runAt, claimToken: claimToken ?? null });
    return jobOriginals.requeueParked(jobId, runAt, claimToken);
  };
  jobRepo.requeueAs = (
    jobId: string,
    role: string,
    runAt: number,
    claimToken?: string | null
  ): ReturnType<JobQueueRepository['requeueAs']> => {
    transcript.push({ op: 'job:requeueAs', jobId, role, runAt, claimToken: claimToken ?? null });
    return jobOriginals.requeueAs(jobId, role, runAt, claimToken);
  };
  jobRepo.isClaimCurrent = (jobId: string, claimToken: string | null): boolean => {
    const result = jobOriginals.isClaimCurrent(jobId, claimToken);
    transcript.push({ op: 'job:isClaimCurrent', jobId, result, claimToken: claimToken ?? null });
    return result;
  };
  jobRepo.getParkCount = (jobId: string): number => {
    const result = jobOriginals.getParkCount(jobId);
    transcript.push({ op: 'job:getParkCount', jobId, result });
    return result;
  };
  jobRepo.narrowActiveDeliveryBatchUuids = (
    sessionId: string,
    kickoffUuid: string,
    admitted: string[]
  ): boolean => {
    const current = jobOriginals.getActiveDeliveryBatchUuids(sessionId, kickoffUuid) ?? [];
    const admittedSet = new Set(admitted);
    const dropped = current.filter((uuid) => !admittedSet.has(uuid));
    const sdkMessageRepo = db.getSDKMessageRepo();
    const settleableDropped: string[] = [];
    for (const uuid of dropped) {
      const loaded = sdkMessageRepo.getDeliveryContent(sessionId, uuid);
      if (loaded && (loaded.sendStatus === 'enqueued' || loaded.sendStatus === 'submitted')) {
        settleableDropped.push(uuid);
      }
    }
    const result = jobOriginals.narrowActiveDeliveryBatchUuids(sessionId, kickoffUuid, admitted);
    transcript.push({
      op: 'job:narrowBatch',
      sessionId,
      kickoffUuid,
      admitted,
      dropped,
      settleableDropped,
      result,
    });
    return result;
  };

  const stateManager = (
    agentSession as unknown as {
      stateManager: {
        setQueuedIfIdle: (uuid: string) => Promise<boolean>;
        setQueued: (uuid: string) => Promise<void>;
        clearQueuedIfOwnedBy: (uuid: string) => Promise<boolean>;
      };
    }
  ).stateManager;
  const stateOriginals = {
    setQueuedIfIdle: stateManager.setQueuedIfIdle.bind(stateManager),
    setQueued: stateManager.setQueued.bind(stateManager),
    clearQueuedIfOwnedBy: stateManager.clearQueuedIfOwnedBy.bind(stateManager),
  };

  stateManager.setQueuedIfIdle = async (uuid: string): Promise<boolean> => {
    const result = await stateOriginals.setQueuedIfIdle(uuid);
    transcript.push({ op: 'state:setQueuedIfIdle', uuid, result });
    return result;
  };
  stateManager.setQueued = async (uuid: string): Promise<void> => {
    await stateOriginals.setQueued(uuid);
    transcript.push({ op: 'state:setQueued', uuid });
  };
  stateManager.clearQueuedIfOwnedBy = async (uuid: string): Promise<boolean> => {
    const result = await stateOriginals.clearQueuedIfOwnedBy(uuid);
    transcript.push({ op: 'state:clearQueuedIfOwnedBy', uuid });
    return result;
  };

  return {
    transcript,
    reset: () => {
      transcript.length = 0;
    },
    restore: () => {
      queue.admitWithId = originalAdmit;
      queue.remove = originalRemove;
      queue.requeueYielded = originalRequeueYielded;
      queue.clear = originalClear;
      sdkRepo.markDeliveryConsumedByUuid = sdkOriginals.markDeliveryConsumedByUuid;
      sdkRepo.markDeliveryConsumedByUuids = sdkOriginals.markDeliveryConsumedByUuids;
      sdkRepo.markDeliverySubmittedByUuids = sdkOriginals.markDeliverySubmittedByUuids;
      sdkRepo.markDeliveryRetryableByUuid = sdkOriginals.markDeliveryRetryableByUuid;
      sdkRepo.markDeliveryFailedByUuid = sdkOriginals.markDeliveryFailedByUuid;
      sdkRepo.recordDeliveryTurnEnd = sdkOriginals.recordDeliveryTurnEnd;
      sdkRepo.clearDeliveryTurnEnd = sdkOriginals.clearDeliveryTurnEnd;
      db.updateMessageStatus = dbOriginals.updateMessageStatus;
      db.updateMessageTimestamp = dbOriginals.updateMessageTimestamp;
      jobRepo.requeue = jobOriginals.requeue;
      jobRepo.requeueParked = jobOriginals.requeueParked;
      jobRepo.requeueAs = jobOriginals.requeueAs;
      jobRepo.isClaimCurrent = jobOriginals.isClaimCurrent;
      jobRepo.getParkCount = jobOriginals.getParkCount;
      jobRepo.getActiveDeliveryBatchUuids = jobOriginals.getActiveDeliveryBatchUuids;
      jobRepo.narrowActiveDeliveryBatchUuids = jobOriginals.narrowActiveDeliveryBatchUuids;
      stateManager.setQueuedIfIdle = stateOriginals.setQueuedIfIdle;
      stateManager.setQueued = stateOriginals.setQueued;
      stateManager.clearQueuedIfOwnedBy = stateOriginals.clearQueuedIfOwnedBy;
    },
  };
}

type TestSession = {
  db: Database;
  session: Session;
  agentSession: AgentSession;
  harness: DeliveryTranscriptHarness;
  bus: Awaited<ReturnType<typeof createTestInternalEventBus>>;
};

async function makeTestSession(
  sessionId: string,
  opts?: { provider?: Provider }
): Promise<TestSession> {
  const db = await createTestDb();
  const session = createTestSession(sessionId);
  if (opts?.provider) {
    session.config.provider = opts.provider;
  }
  db.createSession(session);
  const bus = await createTestInternalEventBus();
  const messageHub = new MessageHub();
  const agentSession = new AgentSession(
    db.getSession(sessionId) ?? session,
    db,
    messageHub,
    bus,
    mock(async () => 'test-api-key'),
    undefined,
    undefined,
    undefined,
    undefined,
    { autoReplayPendingMessages: false }
  );
  const harness = instrumentDeliveryTranscript(db, agentSession);
  return { db, session, agentSession, harness, bus };
}

function stubLifecycleManager(
  agentSession: AgentSession,
  result: 'started' | 'blocked' | Error
): void {
  (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted: mock(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    executeDeferredRestartIfPending: mock(async () => {}),
  };
}

function setNeverResolvingQuery(agentSession: AgentSession): void {
  agentSession.queryPromise = new Promise<void>(() => {});
}

function saveUserMessage(
  repo: SDKMessageRepository,
  sessionId: string,
  uuid: string,
  status: 'enqueued' | 'consumed' = 'enqueued',
  content: string | MessageContent[] = 'hello'
): void {
  repo.saveUserMessage(
    sessionId,
    {
      type: 'user',
      uuid,
      message: { role: 'user', content },
    } as unknown as SDKMessage,
    status
  );
}

async function waitForTranscript(
  harness: DeliveryTranscriptHarness,
  predicate: (event: DeliveryTranscriptEvent) => boolean,
  maxTicks = 200
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (harness.transcript.some(predicate)) return;
    await Promise.resolve();
  }
}

describe('delivery transcript parity harness (A1a)', () => {
  describe('feedDeliverySteer', () => {
    const steerUuid = 'msg-steer';
    const steerContent = 'steer content';

    it('consumes a steer by admission then marks consumed and resolves the ack', async () => {
      const sessionId = 'sess-steer-consumed';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, steerUuid, 'enqueued', steerContent);
        await agentSession.stateManager.setProcessing('active-msg');
        setNeverResolvingQuery(agentSession);
        harness.reset();

        const steerPromise = agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        for (let i = 0; i < 100; i++) {
          if (harness.transcript.some((e) => e.op === 'queue:admit' && e.messageId === steerUuid)) {
            break;
          }
          await Promise.resolve();
        }
        agentSession.messageQueue.remove(steerUuid);

        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'consumed' });
        expect(harness.transcript).toEqual([
          {
            op: 'queue:admit',
            messageId: steerUuid,
            content: steerContent,
            internal: false,
            durable: true,
          },
          { op: 'queue:remove', messageId: steerUuid, found: true },
          { op: 'queue:admitResolve', messageId: steerUuid },
          { op: 'db:markConsumed', sessionId, uuid: steerUuid, dbId: expect.any(String) },
        ]);
      } finally {
        db.close();
      }
    });

    it('records the acknowledgment wait for a consumed steer', async () => {
      const sessionId = 'sess-steer-ack-wait-metric';
      const samples: Array<{ ms: number; outcome: 'acknowledged' | 'ack_timeout' }> = [];
      const original = deliveryMetrics.recordAckWait.bind(deliveryMetrics);
      deliveryMetrics.recordAckWait = (ms, outcome) => samples.push({ ms, outcome });
      try {
        const { db, agentSession, harness } = await makeTestSession(sessionId);
        try {
          saveUserMessage(db.getSDKMessageRepo(), sessionId, steerUuid, 'enqueued', steerContent);
          await agentSession.stateManager.setProcessing('active-msg');
          setNeverResolvingQuery(agentSession);
          const steerPromise = agentSession.feedDeliverySteer(
            steerUuid,
            steerContent,
            null,
            () => true
          );
          await waitForTranscript(
            harness,
            (e) => e.op === 'queue:admit' && e.messageId === steerUuid
          );
          agentSession.messageQueue.remove(steerUuid);
          const outcome = await steerPromise;
          expect(outcome).toEqual({ outcome: 'consumed' });
          expect(samples).toHaveLength(1);
          expect(samples[0].outcome).toBe('acknowledged');
          expect(samples[0].ms).toBeGreaterThanOrEqual(0);
        } finally {
          db.close();
        }
      } finally {
        deliveryMetrics.recordAckWait = original;
      }
    });

    it('parks on queued status with no queue or DB mutations', async () => {
      const sessionId = 'sess-steer-park';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, steerUuid, 'enqueued', steerContent);
        await agentSession.stateManager.setQueued('active-msg');
        harness.reset();

        const outcome = await agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'park' });
        expect(harness.transcript).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('promotes from idle status with no queue or DB mutations', async () => {
      const sessionId = 'sess-steer-promote';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, steerUuid, 'enqueued', steerContent);
        harness.reset();

        const outcome = await agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'promote' });
        expect(harness.transcript).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('aborts when the claim guard is superseded without mutating queue or DB', async () => {
      const sessionId = 'sess-steer-abort';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, steerUuid, 'enqueued', steerContent);
        await agentSession.stateManager.setProcessing('active-msg');
        setNeverResolvingQuery(agentSession);
        harness.reset();

        const outcome = await agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => false
        );
        expect(outcome).toEqual({ outcome: 'aborted' });
        expect(harness.transcript).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('reopens a steer for retry when the query ends before consumption', async () => {
      const sessionId = 'sess-steer-query-ended';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, steerUuid, 'enqueued', steerContent);
        await agentSession.stateManager.setProcessing('active-msg');
        let resolveQuery = () => {};
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        agentSession.messageQueue.start();
        const gen = agentSession.messageQueue.messageGenerator(sessionId);
        harness.reset();

        const steerPromise = agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        const yielded = await gen.next();
        if (!yielded.value) throw new Error('message not yielded');
        resolveQuery();

        try {
          await steerPromise;
          throw new Error('feedDeliverySteer should have thrown');
        } catch (error) {
          expect(error instanceof Error && error.message).toContain(
            'Steer target query ended before the SDK consumed the steer'
          );
        }

        expect(harness.transcript).toEqual([
          {
            op: 'queue:admit',
            messageId: steerUuid,
            content: steerContent,
            internal: false,
            durable: true,
          },
          { op: 'db:markConsumed', sessionId, uuid: steerUuid, dbId: expect.any(String) },
          {
            op: 'db:updateMessageTimestamp',
            sessionId,
            uuid: steerUuid,
            dbId: expect.any(String),
            at: expect.any(Number),
          },
          { op: 'queue:requeueYielded', messageId: steerUuid, found: true },
          { op: 'db:markRetryable', sessionId, uuid: steerUuid, dbId: expect.any(String) },
        ]);

        await gen.return?.(undefined);
      } finally {
        db.close();
      }
    });
  });

  describe('driveDeliveryTurn', () => {
    const turnUuid = 'msg-turn';
    const turnContent = 'turn content';

    it('parks a blocked turn by setting queued and records no queue or DB marks', async () => {
      const sessionId = 'sess-turn-blocked';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, turnUuid, 'enqueued', turnContent);
        stubLifecycleManager(agentSession, 'blocked');
        harness.reset();

        const before = Date.now();
        const outcome = await agentSession.driveDeliveryTurn(
          turnUuid,
          turnContent,
          null,
          false,
          () => true
        );
        const after = Date.now();
        if (outcome.outcome !== 'blocked') {
          throw new Error(`expected blocked, got ${outcome.outcome}`);
        }
        expect(outcome).toEqual({ outcome: 'blocked', retryAt: expect.any(Number) });
        expect(outcome.retryAt).toBeGreaterThanOrEqual(before + MESSAGE_DELIVERY_PARK_MS);
        expect(outcome.retryAt).toBeLessThanOrEqual(after + MESSAGE_DELIVERY_PARK_MS);
        expect(harness.transcript).toEqual([{ op: 'state:setQueued', uuid: turnUuid }]);
      } finally {
        db.close();
      }
    });

    it('aborts a fresh turn whose pending queue entry is removed, resolving the ack', async () => {
      const sessionId = 'sess-turn-abort-remove';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, turnUuid, 'enqueued', turnContent);
        agentSession.messageQueue.admitWithId(turnUuid, 'different content', false, {
          durable: true,
        });
        stubLifecycleManager(agentSession, 'started');
        agentSession.queryPromise = Promise.resolve();

        const outcome = await agentSession.driveDeliveryTurn(
          turnUuid,
          turnContent,
          null,
          false,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'aborted' });
        expect(harness.transcript).toEqual([
          {
            op: 'queue:admit',
            messageId: turnUuid,
            content: 'different content',
            internal: false,
            durable: true,
          },
          { op: 'queue:remove', messageId: turnUuid, found: true },
          { op: 'queue:admitResolve', messageId: turnUuid },
        ]);
      } finally {
        db.close();
      }
    });

    it('turn_terminates a consumed reclaim with a terminal result and records no queue or DB marks', async () => {
      const sessionId = 'sess-turn-terminated';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, turnUuid, 'enqueued', turnContent);
        repo.markDeliveryConsumedByUuid(sessionId, turnUuid);
        repo.saveSDKMessage(sessionId, {
          type: 'result',
          uuid: `${turnUuid}-result`,
          session_id: sessionId,
          parent_tool_use_id: null,
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
        repo.recordDeliveryTurnEnd(sessionId, turnUuid, '2026-08-13T00:00:42.000Z');
        harness.reset();

        stubLifecycleManager(agentSession, new Error('should not start'));

        const outcome = await agentSession.driveDeliveryTurn(
          turnUuid,
          turnContent,
          null,
          true,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'turn_terminated' });
        expect(harness.transcript).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('completes a fresh turn by SDK consumption and a terminal result', async () => {
      const sessionId = 'sess-turn-completed';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, turnUuid, 'enqueued', turnContent);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId,
            messageUuid: turnUuid,
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
          },
          maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        stubLifecycleManager(agentSession, 'started');
        let resolveQuery = () => {};
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        agentSession.messageQueue.start();
        const gen = agentSession.messageQueue.messageGenerator(sessionId);
        harness.reset();

        const turnPromise = agentSession.driveDeliveryTurn(
          turnUuid,
          turnContent,
          null,
          false,
          () => true
        );
        const yielded = await gen.next();
        if (!yielded.value) throw new Error('message not yielded');
        yielded.value.onSent();

        await waitForTranscript(
          harness,
          (e) => e.op === 'db:markConsumedBatch' && e.uuids.includes(turnUuid)
        );
        repo.saveSDKMessage(sessionId, {
          type: 'result',
          uuid: `${turnUuid}-result`,
          session_id: sessionId,
          parent_tool_use_id: null,
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
        await agentSession.stateManager.setIdle({ suppressIdleCallback: true });
        resolveQuery();

        const outcome = await turnPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(harness.transcript).toEqual([
          {
            op: 'queue:admit',
            messageId: turnUuid,
            content: turnContent,
            internal: false,
            durable: true,
          },
          { op: 'db:markConsumed', sessionId, uuid: turnUuid, dbId: expect.any(String) },
          {
            op: 'db:updateMessageTimestamp',
            sessionId,
            uuid: turnUuid,
            dbId: expect.any(String),
            at: expect.any(Number),
          },
          { op: 'queue:admitResolve', messageId: turnUuid },
          {
            op: 'db:markConsumedBatch',
            sessionId,
            uuids: [turnUuid],
            dbIds: [],
          },
          { op: 'db:recordTurnEnd', sessionId, uuid: turnUuid },
        ]);
      } finally {
        db.close();
      }
    });

    it('narrows a batched turn to settleable members and completes', async () => {
      const sessionId = 'sess-turn-batch-narrow';
      const kickoffUuid = 'msg-kickoff';
      const memberUuid = 'msg-member';
      const droppedUuid = 'msg-dropped';
      const kickoffContent = 'kickoff content';
      const memberContent = 'member content';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, kickoffUuid, 'enqueued', kickoffContent);
        saveUserMessage(repo, sessionId, memberUuid, 'enqueued', memberContent);
        saveUserMessage(repo, sessionId, droppedUuid, 'enqueued', []);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId,
            messageUuid: kickoffUuid,
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
            batchUuids: [kickoffUuid, memberUuid, droppedUuid],
          },
          maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        stubLifecycleManager(agentSession, 'started');
        let resolveQuery = () => {};
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        agentSession.messageQueue.start();
        const gen = agentSession.messageQueue.messageGenerator(sessionId);
        harness.reset();

        const turnPromise = agentSession.driveDeliveryTurn(
          kickoffUuid,
          kickoffContent,
          null,
          false,
          () => true,
          [kickoffUuid, memberUuid, droppedUuid]
        );
        const yielded = await gen.next();
        if (!yielded.value) throw new Error('message not yielded');
        yielded.value.onSent();

        await waitForTranscript(
          harness,
          (e) => e.op === 'db:recordTurnEnd' && e.uuid === kickoffUuid
        );
        repo.saveSDKMessage(sessionId, {
          type: 'result',
          uuid: `${kickoffUuid}-result`,
          session_id: sessionId,
          parent_tool_use_id: null,
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
        await agentSession.stateManager.setIdle({ suppressIdleCallback: true });
        resolveQuery();

        const outcome = await turnPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(harness.transcript).toEqual([
          {
            op: 'job:narrowBatch',
            sessionId,
            kickoffUuid,
            admitted: [kickoffUuid, memberUuid],
            dropped: [droppedUuid],
            settleableDropped: [droppedUuid],
            result: true,
          },
          {
            op: 'db:markSubmittedBatch',
            sessionId,
            uuids: [memberUuid],
            dbIds: [expect.any(String)],
          },
          {
            op: 'queue:admit',
            messageId: kickoffUuid,
            content: buildBatchedDeliveryContent([kickoffContent, memberContent]),
            internal: false,
            durable: true,
          },
          { op: 'db:markConsumed', sessionId, uuid: kickoffUuid, dbId: expect.any(String) },
          {
            op: 'db:updateMessageTimestamp',
            sessionId,
            uuid: kickoffUuid,
            dbId: expect.any(String),
            at: expect.any(Number),
          },
          { op: 'queue:admitResolve', messageId: kickoffUuid },
          {
            op: 'db:markConsumedBatch',
            sessionId,
            uuids: [kickoffUuid, memberUuid],
            dbIds: [expect.any(String)],
          },
          { op: 'db:recordTurnEnd', sessionId, uuid: kickoffUuid },
        ]);
      } finally {
        db.close();
      }
    });
  });

  describe('message delivery handler', () => {
    const handlerUuid = 'msg-handler';
    const handlerContent = 'handler content';

    it('requeues a blocked turn and records the job requeue without settling', async () => {
      const sessionId = 'sess-handler-blocked';
      const { db, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, handlerUuid, 'enqueued', handlerContent);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId,
            messageUuid: handlerUuid,
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
          },
          maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        let driveArgs: unknown[] = [];
        let driveClaimResult: boolean | undefined;
        const sessionMock: MessageDeliverySession = {
          driveDeliveryTurn: mock(async (...args: unknown[]) => {
            driveArgs = args;
            await Promise.resolve();
            const claimGuard = args[4] as () => boolean;
            driveClaimResult = claimGuard();
            return { outcome: 'blocked', retryAt: 12345 };
          }),
          feedDeliverySteer: mock(async () => ({ outcome: 'consumed' })),
          settleSkippedDelivery: mock(async () => {}),
        };

        const handler = createMessageDeliveryHandler({
          jobQueue: jobRepo,
          getSession: () => sessionMock,
          getMessageContent: () => ({ content: handlerContent, sendStatus: 'enqueued' }),
        });

        const result = await handler(job);
        expect(result).toEqual({ parked: 'sdk_resume_choice', retryAt: 12345 });
        expect(jobRepo.getJob(job.id)?.status).toBe('pending');
        expect(sessionMock.settleSkippedDelivery).not.toHaveBeenCalled();
        expect(driveArgs[0]).toBe(handlerUuid);
        expect(driveArgs[1]).toBe(handlerContent);
        expect(driveArgs[2]).toBe(null);
        expect(driveArgs[3]).toBe(false);
        expect(typeof driveArgs[4]).toBe('function');
        expect(driveArgs[5]).toBeUndefined();
        expect(driveClaimResult).toBe(true);
        expect(harness.transcript).toEqual([
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:requeue', jobId: job.id, runAt: 12345, claimToken: job.claimToken },
        ]);
      } finally {
        db.close();
      }
    });

    it('promotes a steer by requeueing as turn', async () => {
      const sessionId = 'sess-handler-promote';
      const { db, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, handlerUuid, 'enqueued', handlerContent);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId,
            messageUuid: handlerUuid,
            role: 'steer',
            origin: 'chat',
            parentToolUseId: null,
          },
          maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        let feedArgs: unknown[] = [];
        let feedClaimResult: boolean | undefined;
        const sessionMock: MessageDeliverySession = {
          driveDeliveryTurn: mock(async () => ({ outcome: 'completed' })),
          feedDeliverySteer: mock(async (...args: unknown[]) => {
            feedArgs = args;
            await Promise.resolve();
            const claimGuard = args[3] as () => boolean;
            feedClaimResult = claimGuard();
            return { outcome: 'promote' };
          }),
          settleSkippedDelivery: mock(async () => {}),
        };

        const handler = createMessageDeliveryHandler({
          jobQueue: jobRepo,
          getSession: () => sessionMock,
          getMessageContent: () => ({ content: handlerContent, sendStatus: 'enqueued' }),
        });

        const before = Date.now();
        const result = await handler(job);
        const after = Date.now();
        expect(result).toEqual({ outcome: 'superseded', promoted: 'turn' });

        const requeueAs = harness.transcript.find(
          (e): e is Extract<DeliveryTranscriptEvent, { op: 'job:requeueAs' }> =>
            e.op === 'job:requeueAs'
        );
        expect(requeueAs).toBeDefined();
        const runAt = requeueAs!.runAt;
        expect(runAt).toBeGreaterThanOrEqual(before);
        expect(runAt).toBeLessThanOrEqual(after);
        expect(jobRepo.getJob(job.id)?.payload).toMatchObject({ role: 'turn' });
        expect(sessionMock.settleSkippedDelivery).not.toHaveBeenCalled();
        expect(feedArgs[0]).toBe(handlerUuid);
        expect(feedArgs[1]).toBe(handlerContent);
        expect(feedArgs[2]).toBe(null);
        expect(typeof feedArgs[3]).toBe('function');
        expect(feedArgs[4]).toBeUndefined();
        expect(feedClaimResult).toBe(true);
        expect(harness.transcript).toEqual([
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          {
            op: 'job:requeueAs',
            jobId: job.id,
            role: 'turn',
            runAt,
            claimToken: job.claimToken,
          },
        ]);
      } finally {
        db.close();
      }
    });

    it('settles an aborted turn', async () => {
      const sessionId = 'sess-handler-aborted';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, handlerUuid, 'enqueued', handlerContent);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId,
            messageUuid: handlerUuid,
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
          },
          maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        let driveArgs: unknown[] = [];
        let driveClaimResult: boolean | undefined;
        const sessionMock: MessageDeliverySession = {
          driveDeliveryTurn: mock(async (...args: unknown[]) => {
            driveArgs = args;
            await Promise.resolve();
            const claimGuard = args[4] as () => boolean;
            driveClaimResult = claimGuard();
            return { outcome: 'aborted' };
          }),
          feedDeliverySteer: mock(async () => ({ outcome: 'consumed' })),
          settleSkippedDelivery: mock(agentSession.settleSkippedDelivery.bind(agentSession)),
        };

        const handler = createMessageDeliveryHandler({
          jobQueue: jobRepo,
          getSession: () => sessionMock,
          getMessageContent: () => ({ content: handlerContent, sendStatus: 'enqueued' }),
        });

        const result = await handler(job);
        expect(result).toEqual({ outcome: 'aborted' });
        expect(sessionMock.settleSkippedDelivery).toHaveBeenCalledTimes(1);
        expect(driveArgs[0]).toBe(handlerUuid);
        expect(driveArgs[1]).toBe(handlerContent);
        expect(driveArgs[2]).toBe(null);
        expect(driveArgs[3]).toBe(false);
        expect(typeof driveArgs[4]).toBe('function');
        expect(driveArgs[5]).toBeUndefined();
        expect(driveClaimResult).toBe(true);
        expect(harness.transcript).toEqual([
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'state:clearQueuedIfOwnedBy', uuid: handlerUuid },
        ]);
      } finally {
        db.close();
      }
    });

    it('forwards a batched turn payload and drives the full batch transcript', async () => {
      const sessionId = 'sess-handler-batch';
      const kickoffUuid = 'msg-kickoff';
      const memberUuid = 'msg-member';
      const droppedUuid = 'msg-dropped';
      const kickoffContent = 'kickoff content';
      const memberContent = 'member content';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, kickoffUuid, 'enqueued', kickoffContent);
        saveUserMessage(repo, sessionId, memberUuid, 'enqueued', memberContent);
        saveUserMessage(repo, sessionId, droppedUuid, 'enqueued', []);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId,
            messageUuid: kickoffUuid,
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
            batchUuids: [kickoffUuid, memberUuid, droppedUuid],
          },
          maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        stubLifecycleManager(agentSession, 'started');
        let resolveQuery = () => {};
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        agentSession.messageQueue.start();
        const gen = agentSession.messageQueue.messageGenerator(sessionId);
        harness.reset();

        let driveArgs: unknown[] = [];
        const sessionMock: MessageDeliverySession = {
          driveDeliveryTurn: mock(async (...args: unknown[]) => {
            driveArgs = args;
            return await agentSession.driveDeliveryTurn(
              args[0] as string,
              args[1] as string | MessageContent[],
              args[2] as string | null | undefined,
              args[3] as boolean | undefined,
              () => true,
              args[5] as string[] | undefined,
              args[6] as AbortSignal | undefined,
              args[7] as MessageDeliveryAttemptObserver | undefined
            );
          }),
          feedDeliverySteer: mock(async () => ({ outcome: 'consumed' })),
          settleSkippedDelivery: mock(agentSession.settleSkippedDelivery.bind(agentSession)),
        };

        const handler = createMessageDeliveryHandler({
          jobQueue: jobRepo,
          getSession: () => sessionMock,
          getMessageContent: (s: string, uuid: string): DeliveryLoadResult | null => {
            const loaded = repo.getDeliveryContent(s, uuid);
            return (loaded as DeliveryLoadResult | null) ?? null;
          },
        });

        const handlerPromise = handler(job);
        const yielded = await gen.next();
        if (!yielded.value) throw new Error('message not yielded');
        yielded.value.onSent();

        await waitForTranscript(
          harness,
          (e) => e.op === 'db:markConsumedBatch' && e.uuids.includes(kickoffUuid)
        );
        repo.saveSDKMessage(sessionId, {
          type: 'result',
          uuid: `${kickoffUuid}-result`,
          session_id: sessionId,
          parent_tool_use_id: null,
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
        await agentSession.stateManager.setIdle({ suppressIdleCallback: true });
        resolveQuery();

        const result = await handlerPromise;
        expect(result).toEqual({ outcome: 'completed' });
        expect(driveArgs[5]).toEqual([kickoffUuid, memberUuid, droppedUuid]);
        expect(harness.transcript).toEqual([
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          {
            op: 'job:narrowBatch',
            sessionId,
            kickoffUuid,
            admitted: [kickoffUuid, memberUuid],
            dropped: [droppedUuid],
            settleableDropped: [droppedUuid],
            result: true,
          },
          {
            op: 'db:markSubmittedBatch',
            sessionId,
            uuids: [memberUuid],
            dbIds: [expect.any(String)],
          },
          {
            op: 'queue:admit',
            messageId: kickoffUuid,
            content: buildBatchedDeliveryContent([kickoffContent, memberContent]),
            internal: false,
            durable: true,
          },
          { op: 'db:markConsumed', sessionId, uuid: kickoffUuid, dbId: expect.any(String) },
          {
            op: 'db:updateMessageTimestamp',
            sessionId,
            uuid: kickoffUuid,
            dbId: expect.any(String),
            at: expect.any(Number),
          },
          { op: 'queue:admitResolve', messageId: kickoffUuid },
          {
            op: 'db:markConsumedBatch',
            sessionId,
            uuids: [kickoffUuid, memberUuid],
            dbIds: [expect.any(String)],
          },
          { op: 'db:recordTurnEnd', sessionId, uuid: kickoffUuid },
        ]);
      } finally {
        db.close();
      }
    });
  });
});
