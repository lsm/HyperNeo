import { describe, expect, it, mock } from 'bun:test';
import type { MessageHub, Provider, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  MESSAGE_DELIVERY,
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
  | { op: 'queue:admit'; messageId: string; durable?: boolean }
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
  | { op: 'job:requeue'; jobId: string; runAt: number }
  | { op: 'job:requeueParked'; jobId: string; runAt: number }
  | { op: 'job:requeueAs'; jobId: string; role: string; runAt: number }
  | { op: 'job:isClaimCurrent'; jobId: string; result: boolean }
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
    content: string | unknown[],
    internal: boolean,
    options?: { durable?: boolean; prepend?: boolean }
  ): Promise<void> => {
    transcript.push({ op: 'queue:admit', messageId, durable: options?.durable });
    const promise = originalAdmit(messageId, content as string, internal, options);
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

  const wrapRepo = (repo: SDKMessageRepository) => {
    const originals = {
      markDeliveryConsumedByUuid: repo.markDeliveryConsumedByUuid.bind(repo),
      markDeliveryConsumedByUuids: repo.markDeliveryConsumedByUuids.bind(repo),
      markDeliverySubmittedByUuids: repo.markDeliverySubmittedByUuids.bind(repo),
      markDeliveryRetryableByUuid: repo.markDeliveryRetryableByUuid.bind(repo),
      markDeliveryFailedByUuid: repo.markDeliveryFailedByUuid.bind(repo),
      recordDeliveryTurnEnd: repo.recordDeliveryTurnEnd.bind(repo),
      clearDeliveryTurnEnd: repo.clearDeliveryTurnEnd.bind(repo),
    };

    repo.markDeliveryConsumedByUuid = (sessionId: string, uuid: string): string | null => {
      const dbId = originals.markDeliveryConsumedByUuid(sessionId, uuid);
      transcript.push({ op: 'db:markConsumed', uuid, dbId });
      return dbId;
    };
    repo.markDeliveryConsumedByUuids = (sessionId: string, uuids: string[]): string[] => {
      const dbIds = originals.markDeliveryConsumedByUuids(sessionId, uuids);
      transcript.push({ op: 'db:markConsumedBatch', uuids, dbIds });
      return dbIds;
    };
    repo.markDeliverySubmittedByUuids = (sessionId: string, uuids: string[]): string[] => {
      const dbIds = originals.markDeliverySubmittedByUuids(sessionId, uuids);
      transcript.push({ op: 'db:markSubmittedBatch', uuids, dbIds });
      return dbIds;
    };
    repo.markDeliveryRetryableByUuid = (sessionId: string, uuid: string): string | null => {
      const dbId = originals.markDeliveryRetryableByUuid(sessionId, uuid);
      transcript.push({ op: 'db:markRetryable', uuid, dbId });
      return dbId;
    };
    repo.markDeliveryFailedByUuid = (sessionId: string, uuid: string): string | null => {
      const dbId = originals.markDeliveryFailedByUuid(sessionId, uuid);
      transcript.push({ op: 'db:markFailed', uuid, dbId });
      return dbId;
    };
    repo.recordDeliveryTurnEnd = (
      sessionId: string,
      messageUuid: string,
      endedAt: string
    ): void => {
      originals.recordDeliveryTurnEnd(sessionId, messageUuid, endedAt);
      transcript.push({ op: 'db:recordTurnEnd', uuid: messageUuid });
    };
    repo.clearDeliveryTurnEnd = (sessionId: string, messageUuid: string): void => {
      originals.clearDeliveryTurnEnd(sessionId, messageUuid);
      transcript.push({ op: 'db:clearTurnEnd', uuid: messageUuid });
    };
  };

  const wrapJobRepo = (repo: JobQueueRepository) => {
    const originals = {
      requeue: repo.requeue.bind(repo),
      requeueParked: repo.requeueParked.bind(repo),
      requeueAs: repo.requeueAs.bind(repo),
      isClaimCurrent: repo.isClaimCurrent.bind(repo),
      getParkCount: repo.getParkCount.bind(repo),
    };

    repo.requeue = (
      jobId: string,
      runAt: number,
      claimToken?: string | null
    ): ReturnType<JobQueueRepository['requeue']> => {
      transcript.push({ op: 'job:requeue', jobId, runAt });
      return originals.requeue(jobId, runAt, claimToken);
    };
    repo.requeueParked = (
      jobId: string,
      runAt: number,
      claimToken?: string | null
    ): ReturnType<JobQueueRepository['requeueParked']> => {
      transcript.push({ op: 'job:requeueParked', jobId, runAt });
      return originals.requeueParked(jobId, runAt, claimToken);
    };
    repo.requeueAs = (
      jobId: string,
      role: string,
      runAt: number,
      claimToken?: string | null
    ): ReturnType<JobQueueRepository['requeueAs']> => {
      transcript.push({ op: 'job:requeueAs', jobId, role, runAt });
      return originals.requeueAs(jobId, role, runAt, claimToken);
    };
    repo.isClaimCurrent = (jobId: string, claimToken: string | null): boolean => {
      const result = originals.isClaimCurrent(jobId, claimToken);
      transcript.push({ op: 'job:isClaimCurrent', jobId, result });
      return result;
    };
    repo.getParkCount = (jobId: string): number => {
      const result = originals.getParkCount(jobId);
      transcript.push({ op: 'job:getParkCount', jobId, result });
      return result;
    };
  };

  const wrapState = () => {
    const stateManager = (
      agentSession as unknown as {
        stateManager: {
          setQueuedIfIdle: (uuid: string) => Promise<boolean>;
          setQueued: (uuid: string) => Promise<void>;
          clearQueuedIfOwnedBy: (uuid: string) => Promise<boolean>;
        };
      }
    ).stateManager;
    const originals = {
      setQueuedIfIdle: stateManager.setQueuedIfIdle.bind(stateManager),
      setQueued: stateManager.setQueued.bind(stateManager),
      clearQueuedIfOwnedBy: stateManager.clearQueuedIfOwnedBy.bind(stateManager),
    };
    stateManager.setQueuedIfIdle = async (uuid: string): Promise<boolean> => {
      const result = await originals.setQueuedIfIdle(uuid);
      transcript.push({ op: 'state:setQueuedIfIdle', uuid, result });
      return result;
    };
    stateManager.setQueued = async (uuid: string): Promise<void> => {
      await originals.setQueued(uuid);
      transcript.push({ op: 'state:setQueued', uuid });
    };
    stateManager.clearQueuedIfOwnedBy = async (uuid: string): Promise<boolean> => {
      const result = await originals.clearQueuedIfOwnedBy(uuid);
      transcript.push({ op: 'state:clearQueuedIfOwnedBy', uuid });
      return result;
    };
  };

  wrapRepo(sdkRepo);
  wrapJobRepo(jobRepo);
  wrapState();

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
  status: 'enqueued' | 'consumed' = 'enqueued'
): void {
  repo.saveUserMessage(
    sessionId,
    {
      type: 'user',
      uuid,
      message: { role: 'user', content: 'hello' },
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
        saveUserMessage(repo, 'sess-steer-consumed', steerUuid);
        await agentSession.stateManager.setProcessing('active-msg');
        setNeverResolvingQuery(agentSession);
        harness.reset();

        const steerPromise = agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        for (let i = 0; i < 200; i++) {
          const done = await Promise.race([
            steerPromise.then(
              () => true,
              () => true
            ),
            Promise.resolve().then(() => agentSession.messageQueue.remove(steerUuid) || false),
          ]);
          if (done) break;
        }

        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'consumed' });
        expect(
          harness.transcript.some((e) => e.op === 'queue:admit' && e.messageId === steerUuid)
        ).toBe(true);
        expect(
          harness.transcript.some((e) => e.op === 'db:markConsumed' && e.uuid === steerUuid)
        ).toBe(true);
        expect(
          harness.transcript.some((e) => e.op === 'queue:admitResolve' && e.messageId === steerUuid)
        ).toBe(true);
      } finally {
        db.close();
      }
    });

    it('parks on queued status with no queue or DB mutations', async () => {
      const { db, agentSession, harness } = await makeTestSession('sess-steer-park');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-steer-park', steerUuid);
        await agentSession.stateManager.setQueued('active-msg');
        harness.reset();

        const outcome = await agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'park' });
        expect(harness.transcript.length).toBe(0);
      } finally {
        db.close();
      }
    });

    it('promotes from idle status with no queue or DB mutations', async () => {
      const { db, agentSession, harness } = await makeTestSession('sess-steer-promote');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-steer-promote', steerUuid);
        harness.reset();

        const outcome = await agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'promote' });
        expect(harness.transcript.length).toBe(0);
      } finally {
        db.close();
      }
    });

    it('aborts when the claim guard is superseded without mutating queue or DB', async () => {
      const { db, agentSession, harness } = await makeTestSession('sess-steer-abort');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-steer-abort', steerUuid);
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
        expect(harness.transcript.length).toBe(0);
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
        saveUserMessage(repo, 'sess-turn-blocked', turnUuid);
        stubLifecycleManager(agentSession, 'blocked');
        harness.reset();

        const outcome = await agentSession.driveDeliveryTurn(
          turnUuid,
          turnContent,
          null,
          false,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'blocked', retryAt: expect.any(Number) });
        expect(
          harness.transcript.some((e) => e.op === 'state:setQueued' && e.uuid === turnUuid)
        ).toBe(true);
      } finally {
        db.close();
      }
    });

    it('aborts a fresh turn whose pending queue entry is removed, resolving the ack', async () => {
      const { db, agentSession, harness } = await makeTestSession('sess-turn-abort-remove');
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, 'sess-turn-abort-remove', turnUuid);
        agentSession.messageQueue.admitWithId(turnUuid, 'different content', false, {
          durable: true,
        });
        stubLifecycleManager(agentSession, 'started');
        agentSession.queryPromise = Promise.resolve();
        harness.reset();

        const outcome = await agentSession.driveDeliveryTurn(
          turnUuid,
          turnContent,
          null,
          false,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'aborted' });
        expect(
          harness.transcript.some(
            (e) => e.op === 'queue:remove' && e.messageId === turnUuid && e.found === true
          )
        ).toBe(true);
        expect(
          harness.transcript.some((e) => e.op === 'queue:admitResolve' && e.messageId === turnUuid)
        ).toBe(true);
      } finally {
        db.close();
      }
    });

    it('turn_terminates a consumed reclaim with a terminal result and records no queue or DB marks', async () => {
      const sessionId = 'sess-turn-terminated';
      const { db, agentSession, harness } = await makeTestSession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, turnUuid, 'enqueued');
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
        expect(harness.transcript.length).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe('message delivery handler', () => {
    const handlerUuid = 'msg-handler';

    it('requeues a blocked turn and records the job requeue and settle', async () => {
      const { db } = await makeTestSession('sess-handler-blocked');
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, 'sess-handler-blocked', handlerUuid);
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
          getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
        });

        const result = await handler(job);
        expect(result).toMatchObject({ parked: 'sdk_resume_choice', retryAt: 12345 });
        expect(jobRepo.getJob(job.id)?.status).toBe('pending');
      } finally {
        db.close();
      }
    });

    it('promotes a steer by requeueing as turn', async () => {
      const { db } = await makeTestSession('sess-handler-promote');
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, 'sess-handler-promote', handlerUuid);
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
          getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
        });

        const result = await handler(job);
        expect(result).toMatchObject({ outcome: 'superseded', promoted: 'turn' });
        expect(jobRepo.getJob(job.id)?.status).toBe('pending');
      } finally {
        db.close();
      }
    });
  });
});
