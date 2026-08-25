import { describe, expect, it, mock } from 'bun:test';
import type { MessageContent, MessageHub, Provider, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  MESSAGE_DELIVERY,
  MESSAGE_DELIVERY_PARK_MS,
  type MessageDeliverySession,
} from '../../../../src/lib/agent/message-delivery';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
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
  | { op: 'db:markConsumed'; uuid: string; dbId: string | null }
  | { op: 'db:markConsumedBatch'; uuids: string[]; dbIds: string[] }
  | { op: 'db:markSubmittedBatch'; uuids: string[]; dbIds: string[] }
  | { op: 'db:markRetryable'; uuid: string; dbId: string | null }
  | { op: 'db:markFailed'; uuid: string; dbId: string | null }
  | { op: 'db:recordTurnEnd'; uuid: string }
  | { op: 'db:clearTurnEnd'; uuid: string }
  | { op: 'job:requeue'; jobId: string; runAt: number; claimToken: string | null }
  | { op: 'job:requeueParked'; jobId: string; runAt: number; claimToken: string | null }
  | { op: 'job:requeueAs'; jobId: string; role: string; runAt: number; claimToken: string | null }
  | { op: 'job:isClaimCurrent'; jobId: string; result: boolean; claimToken: string | null }
  | { op: 'job:getParkCount'; jobId: string; result: number }
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
    transcript.push({ op: 'db:markConsumed', uuid, dbId });
    return dbId;
  };
  sdkRepo.markDeliveryConsumedByUuids = (sessionId: string, uuids: string[]): string[] => {
    const dbIds = sdkOriginals.markDeliveryConsumedByUuids(sessionId, uuids);
    transcript.push({ op: 'db:markConsumedBatch', uuids, dbIds });
    return dbIds;
  };
  sdkRepo.markDeliverySubmittedByUuids = (sessionId: string, uuids: string[]): string[] => {
    const dbIds = sdkOriginals.markDeliverySubmittedByUuids(sessionId, uuids);
    transcript.push({ op: 'db:markSubmittedBatch', uuids, dbIds });
    return dbIds;
  };
  sdkRepo.markDeliveryRetryableByUuid = (sessionId: string, uuid: string): string | null => {
    const dbId = sdkOriginals.markDeliveryRetryableByUuid(sessionId, uuid);
    transcript.push({ op: 'db:markRetryable', uuid, dbId });
    return dbId;
  };
  sdkRepo.markDeliveryFailedByUuid = (sessionId: string, uuid: string): string | null => {
    const dbId = sdkOriginals.markDeliveryFailedByUuid(sessionId, uuid);
    transcript.push({ op: 'db:markFailed', uuid, dbId });
    return dbId;
  };
  sdkRepo.recordDeliveryTurnEnd = (
    sessionId: string,
    messageUuid: string,
    endedAt: string
  ): void => {
    sdkOriginals.recordDeliveryTurnEnd(sessionId, messageUuid, endedAt);
    transcript.push({ op: 'db:recordTurnEnd', uuid: messageUuid });
  };
  sdkRepo.clearDeliveryTurnEnd = (sessionId: string, messageUuid: string): void => {
    sdkOriginals.clearDeliveryTurnEnd(sessionId, messageUuid);
    transcript.push({ op: 'db:clearTurnEnd', uuid: messageUuid });
  };

  const jobOriginals = {
    requeue: jobRepo.requeue.bind(jobRepo),
    requeueParked: jobRepo.requeueParked.bind(jobRepo),
    requeueAs: jobRepo.requeueAs.bind(jobRepo),
    isClaimCurrent: jobRepo.isClaimCurrent.bind(jobRepo),
    getParkCount: jobRepo.getParkCount.bind(jobRepo),
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
      jobRepo.requeue = jobOriginals.requeue;
      jobRepo.requeueParked = jobOriginals.requeueParked;
      jobRepo.requeueAs = jobOriginals.requeueAs;
      jobRepo.isClaimCurrent = jobOriginals.isClaimCurrent;
      jobRepo.getParkCount = jobOriginals.getParkCount;
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
  const agentSession = new AgentSession(
    db.getSession(sessionId) ?? session,
    db,
    {} as MessageHub,
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

describe('delivery transcript parity harness (A1a)', () => {
  describe('feedDeliverySteer', () => {
    const steerUuid = 'msg-steer';
    const steerContent = 'steer content';

    it('consumes a steer by admission then marks consumed and resolves the ack', async () => {
      const { db, agentSession, harness } = await makeTestSession('sess-steer-consumed');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-steer-consumed', steerUuid, 'enqueued', steerContent);
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
          { op: 'db:markConsumed', uuid: steerUuid, dbId: expect.any(String) },
        ]);
      } finally {
        db.close();
      }
    });

    it('parks on queued status with no queue or DB mutations', async () => {
      const { db, agentSession, harness } = await makeTestSession('sess-steer-park');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-steer-park', steerUuid, 'enqueued', steerContent);
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
      const { db, agentSession, harness } = await makeTestSession('sess-steer-promote');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-steer-promote', steerUuid, 'enqueued', steerContent);
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
      const { db, agentSession, harness } = await makeTestSession('sess-steer-abort');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-steer-abort', steerUuid, 'enqueued', steerContent);
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
  });

  describe('driveDeliveryTurn', () => {
    const turnUuid = 'msg-turn';
    const turnContent = 'turn content';

    it('parks a blocked turn by setting queued and records no queue or DB marks', async () => {
      const { db, agentSession, harness } = await makeTestSession('sess-turn-blocked');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-turn-blocked', turnUuid, 'enqueued', turnContent);
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
      const { db, agentSession, harness } = await makeTestSession('sess-turn-abort-remove');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-turn-abort-remove', turnUuid, 'enqueued', turnContent);
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
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        stubLifecycleManager(agentSession, 'started');
        let resolveQuery = () => {};
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        harness.reset();

        const turnPromise = agentSession.driveDeliveryTurn(
          turnUuid,
          turnContent,
          null,
          false,
          () => true
        );
        for (let i = 0; i < 100; i++) {
          if (harness.transcript.some((e) => e.op === 'queue:admit' && e.messageId === turnUuid)) {
            break;
          }
          await Promise.resolve();
        }
        agentSession.messageQueue.remove(turnUuid);
        for (let i = 0; i < 100; i++) {
          if (
            harness.transcript.some(
              (e) =>
                (e.op === 'db:markConsumed' && e.uuid === turnUuid) ||
                (e.op === 'db:markConsumedBatch' && e.uuids.includes(turnUuid))
            )
          ) {
            break;
          }
          await Promise.resolve();
        }
        repo.saveSDKMessage(sessionId, {
          type: 'result',
          uuid: `${turnUuid}-result`,
          session_id: sessionId,
          parent_tool_use_id: null,
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
        await agentSession.stateManager.setIdle();
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
          { op: 'queue:remove', messageId: turnUuid, found: true },
          { op: 'queue:admitResolve', messageId: turnUuid },
          {
            op: 'db:markConsumedBatch',
            uuids: [turnUuid],
            dbIds: [expect.any(String)],
          },
          { op: 'db:recordTurnEnd', uuid: turnUuid },
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
      const { db, harness } = await makeTestSession('sess-handler-blocked');
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, 'sess-handler-blocked', handlerUuid, 'enqueued', handlerContent);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId: 'sess-handler-blocked',
            messageUuid: handlerUuid,
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
          },
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        const sessionMock: MessageDeliverySession = {
          driveDeliveryTurn: mock(async () => ({ outcome: 'blocked', retryAt: 12345 })),
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
        expect(harness.transcript).toEqual([
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:requeue', jobId: job.id, runAt: 12345, claimToken: job.claimToken },
        ]);
      } finally {
        db.close();
      }
    });

    it('promotes a steer by requeueing as turn', async () => {
      const { db, harness } = await makeTestSession('sess-handler-promote');
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, 'sess-handler-promote', handlerUuid, 'enqueued', handlerContent);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId: 'sess-handler-promote',
            messageUuid: handlerUuid,
            role: 'steer',
            origin: 'chat',
            parentToolUseId: null,
          },
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        const sessionMock: MessageDeliverySession = {
          driveDeliveryTurn: mock(async () => ({ outcome: 'completed' })),
          feedDeliverySteer: mock(async () => ({ outcome: 'promote' })),
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
        expect(harness.transcript).toEqual([
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
      const { db, agentSession, harness } = await makeTestSession('sess-handler-aborted');
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, 'sess-handler-aborted', handlerUuid, 'enqueued', handlerContent);
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId: 'sess-handler-aborted',
            messageUuid: handlerUuid,
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
          },
        });
        const [job] = jobRepo.dequeue(MESSAGE_DELIVERY, 1) as [Job | undefined];
        if (!job) throw new Error('job not claimed');

        const sessionMock: MessageDeliverySession = {
          driveDeliveryTurn: mock(async () => ({ outcome: 'aborted' })),
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
        expect(harness.transcript).toEqual([
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'job:isClaimCurrent', jobId: job.id, result: true, claimToken: job.claimToken },
          { op: 'state:clearQueuedIfOwnedBy', uuid: handlerUuid },
        ]);
      } finally {
        db.close();
      }
    });
  });
});
