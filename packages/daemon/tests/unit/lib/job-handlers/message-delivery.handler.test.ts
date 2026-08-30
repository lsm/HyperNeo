import { describe, expect, it, mock } from 'bun:test';
import type {
  DeliveryOutcome,
  MessageDeliverySession,
} from '../../../../src/lib/agent/message-delivery';
import { MAX_STEER_PARKS } from '../../../../src/lib/agent/message-delivery';
import type { DeliveryMetrics } from '../../../../src/lib/agent/message-delivery-metrics';
import {
  createMessageDeliveryHandler,
  type MessageDeliveryHandlerDeps,
} from '../../../../src/lib/job-handlers/message-delivery.handler';
import type {
  Job,
  JobQueueRepository,
} from '../../../../src/storage/repositories/job-queue-repository';

const TURN_PAYLOAD: Record<string, unknown> = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-1',
  role: 'turn',
  origin: 'chat',
};

const STEER_PAYLOAD: Record<string, unknown> = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-1',
  role: 'steer',
  origin: 'chat',
};

function makeJob(payload: Record<string, unknown>): Job {
  return { id: 'job-1', claimToken: 'claim-1', payload } as unknown as Job;
}

class MockSession implements MessageDeliverySession {
  driveResult: DeliveryOutcome = { outcome: 'completed' };
  feedResult: DeliveryOutcome = { outcome: 'completed' };
  waitingForInput = false;
  stuckMs: number | null = null;
  driveCalls = 0;
  feedCalls = 0;
  settleCalls: string[] = [];
  lastUuid?: string;

  stuckInitializingMs(): number | null {
    return this.stuckMs;
  }

  async driveDeliveryTurn(
    messageUuid: string,
    _content: unknown,
    _parentToolUseId?: string | null,
    _alreadyConsumed?: boolean,
    _claimGuard?: () => boolean,
    _batchUuids?: string[],
    _signal?: AbortSignal,
    _observer?: unknown,
    _deliveryClaimToken?: string | null
  ): Promise<DeliveryOutcome> {
    this.driveCalls++;
    this.lastUuid = messageUuid;
    return this.driveResult;
  }

  async feedDeliverySteer(
    messageUuid: string,
    _content: unknown,
    _parentToolUseId?: string | null,
    _claimGuard?: () => boolean,
    _signal?: AbortSignal,
    _observer?: unknown
  ): Promise<DeliveryOutcome> {
    this.feedCalls++;
    this.lastUuid = messageUuid;
    return this.feedResult;
  }

  async settleSkippedDelivery(messageUuid: string): Promise<void> {
    this.settleCalls.push(messageUuid);
  }

  isWaitingForInput(): boolean {
    return this.waitingForInput;
  }
}

function makeHarness(
  extra: Partial<MessageDeliveryHandlerDeps> = {},
  payload: Record<string, unknown> = TURN_PAYLOAD
) {
  const session = new MockSession();
  const jobQueue = {
    isClaimCurrent: mock((_id: string, _token: string | null) => true),
    getParkCount: mock((_id: string) => 0),
    requeue: mock((_id: string, _runAt: number, _token: string | null) => null),
    requeueParked: mock((_id: string, _runAt: number, _token: string | null) => null),
    requeueAs: mock((_id: string, _role: string, _runAt: number, _token: string | null) => null),
    getActiveDeliveryBatchUuids: mock(() => null),
  };
  const getSession = mock(() => session);
  const getMessageContent = mock(() => ({ content: 'hello', sendStatus: 'enqueued' }));
  const isSessionArchived = mock(() => false);
  const metrics = {
    recordReclaimSkip: mock(() => {}),
    recordStuckInitializingRefusal: mock(() => {}),
  };
  const deps: MessageDeliveryHandlerDeps = {
    jobQueue: jobQueue as unknown as JobQueueRepository,
    getSession,
    getMessageContent,
    isSessionArchived,
    metrics: metrics as unknown as DeliveryMetrics,
    ...extra,
  };
  const handler = createMessageDeliveryHandler(deps);
  const job = makeJob(payload);
  return {
    handler,
    session,
    jobQueue,
    getSession,
    getMessageContent,
    isSessionArchived,
    metrics,
    job,
  };
}

describe('createMessageDeliveryHandler', () => {
  describe('preflight gates', () => {
    it('throws on an unparseable payload before any other check runs', async () => {
      const { handler, jobQueue } = makeHarness();
      jobQueue.isClaimCurrent.mockImplementation(() => {
        throw new Error('must not run');
      });
      const bad = makeJob({ sessionId: 'sess-1' });
      await expect(handler(bad, {})).rejects.toThrow('message_delivery: invalid payload');
      expect(jobQueue.isClaimCurrent).not.toHaveBeenCalled();
    });

    it('returns stale_attempt for a stale claim before the archived/content checks', async () => {
      const { handler, jobQueue, isSessionArchived, getMessageContent, job } = makeHarness();
      jobQueue.isClaimCurrent.mockImplementation(() => false);
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'stale_attempt' });
      expect(isSessionArchived).not.toHaveBeenCalled();
      expect(getMessageContent).not.toHaveBeenCalled();
    });

    it('parks the job until a restored cooldown expires instead of driving the turn', async () => {
      const retryAt = Date.now() + 60_000;
      const { handler, session, jobQueue, getMessageContent, job } = makeHarness({
        getSessionCooldownRetryAt: () => retryAt,
      });
      const result = await handler(job, {});
      expect(result).toEqual({ parked: 'rate_limit_cooldown', retryAt });
      expect(jobQueue.requeueParked).toHaveBeenCalledWith('job-1', retryAt, 'claim-1');
      expect(session.driveCalls).toBe(0);
      expect(getMessageContent).not.toHaveBeenCalled();
    });

    it('returns stale_attempt when the claim expires before parking for a cooldown', async () => {
      const { handler, jobQueue, job } = makeHarness({
        getSessionCooldownRetryAt: () => Date.now() + 60_000,
      });
      let claimChecks = 0;
      jobQueue.isClaimCurrent.mockImplementation(() => {
        claimChecks++;
        return claimChecks === 1;
      });
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'stale_attempt' });
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
    });

    it('proceeds to drive the turn when no restored cooldown is reported', async () => {
      const { handler, session, jobQueue, job } = makeHarness({
        getSessionCooldownRetryAt: () => null,
      });
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
      expect(session.driveCalls).toBe(1);
    });

    it('re-checks the claim after content loads before driving a turn', async () => {
      const { handler, session, jobQueue, getMessageContent, job } = makeHarness();
      let claimChecks = 0;
      jobQueue.isClaimCurrent.mockImplementation(() => {
        claimChecks++;
        return claimChecks === 1;
      });
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'stale_attempt' });
      expect(getMessageContent).toHaveBeenCalled();
      expect(session.driveCalls).toBe(0);
    });

    it('throws when the session is missing', async () => {
      const { handler, getSession, job } = makeHarness();
      getSession.mockImplementation(() => null);
      await expect(handler(job, {})).rejects.toThrow('message_delivery: session sess-1 not found');
    });

    it('settles as no_content and records the reclaim skip when content is missing', async () => {
      const { handler, getMessageContent, session, metrics, job } = makeHarness();
      getMessageContent.mockImplementation(() => null);
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'no_content' });
      expect(metrics.recordReclaimSkip).toHaveBeenCalledWith('noContent');
      expect(session.settleCalls).toEqual(['uuid-1']);
    });

    it('marks every batch member failed and settles for an archived session', async () => {
      const markFailedSpy = mock((_sessionId: string, uuid: string) => `db-${uuid}`);
      const publishSpy = mock(async () => {});
      const { handler, session, isSessionArchived, job } = makeHarness(
        { markDeliveryFailed: markFailedSpy, publishStatusChanged: publishSpy },
        {
          sessionId: 'sess-1',
          messageUuid: 'uuid-1',
          role: 'turn',
          origin: 'chat',
          batchUuids: ['uuid-1', 'uuid-2'],
        }
      );
      isSessionArchived.mockImplementation(() => true);
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'archived' });
      expect(markFailedSpy).toHaveBeenCalledWith('sess-1', 'uuid-1');
      expect(markFailedSpy).toHaveBeenCalledWith('sess-1', 'uuid-2');
      expect(publishSpy).toHaveBeenCalledWith('sess-1', ['db-uuid-1', 'db-uuid-2']);
      expect(session.settleCalls).toEqual(['uuid-1']);
    });
  });

  describe('role × sendStatus gates', () => {
    it('a consumed row returns completed without driving/feeding', async () => {
      const { handler, session, getMessageContent, job } = makeHarness({}, STEER_PAYLOAD);
      getMessageContent.mockImplementation(() => ({ content: 'steer', sendStatus: 'consumed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.feedCalls).toBe(0);
      expect(session.driveCalls).toBe(0);
      expect(session.settleCalls).toEqual([]);
    });

    it('a deferred turn settles as skipped', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'x', sendStatus: 'deferred' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'skipped', sendStatus: 'deferred' });
      expect(session.settleCalls).toEqual(['uuid-1']);
      expect(session.driveCalls).toBe(0);
    });

    it('a failed steer settles as skipped', async () => {
      const { handler, session, getMessageContent, job } = makeHarness({}, STEER_PAYLOAD);
      getMessageContent.mockImplementation(() => ({ content: 'x', sendStatus: 'failed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'skipped', sendStatus: 'failed' });
      expect(session.settleCalls).toEqual(['uuid-1']);
      expect(session.feedCalls).toBe(0);
    });

    it('a submitted row is still admitted', async () => {
      const { handler, session, getMessageContent, job } = makeHarness({}, STEER_PAYLOAD);
      getMessageContent.mockImplementation(() => ({ content: 'steer', sendStatus: 'submitted' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.feedCalls).toBe(1);
      expect(session.settleCalls).toEqual([]);
    });
  });

  describe('stuck-initializing admission gate', () => {
    it('refuses a turn for a session stuck initializing past the threshold', async () => {
      const { handler, session, jobQueue, metrics, job } = makeHarness();
      session.stuckMs = 200_000;
      const result = await handler(job, {});
      expect(result).toMatchObject({ parked: 'stuck_initializing' });
      expect(result.retryAt).toBeGreaterThan(Date.now());
      expect(jobQueue.requeueParked).toHaveBeenCalledWith('job-1', result.retryAt, 'claim-1');
      expect(metrics.recordStuckInitializingRefusal).toHaveBeenCalledWith(200_000);
      expect(session.driveCalls).toBe(0);
      expect(session.feedCalls).toBe(0);
      expect(session.settleCalls).toEqual([]);
    });

    it('refuses a steer the same way without feeding it', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.stuckMs = 200_000;
      const result = await handler(job, {});
      expect(result).toMatchObject({ parked: 'stuck_initializing' });
      expect(jobQueue.requeueParked).toHaveBeenCalledWith('job-1', result.retryAt, 'claim-1');
      expect(session.feedCalls).toBe(0);
    });

    it('an already-consumed row skips the stuck gate', async () => {
      const { handler, session, jobQueue, metrics, getMessageContent, job } = makeHarness(
        {},
        STEER_PAYLOAD
      );
      session.stuckMs = 200_000;
      getMessageContent.mockImplementation(() => ({ content: 'steer', sendStatus: 'consumed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
      expect(metrics.recordStuckInitializingRefusal).not.toHaveBeenCalled();
      expect(session.feedCalls).toBe(0);
    });

    it('admits when the session has been initializing only briefly', async () => {
      const { handler, session, jobQueue, job } = makeHarness();
      session.stuckMs = 1_000;
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
      expect(session.driveCalls).toBe(1);
    });

    it('admits when the session does not expose the probe', async () => {
      const { handler, session, job } = makeHarness();
      delete (session as Partial<MockSession>).stuckInitializingMs;
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.driveCalls).toBe(1);
    });

    it('dead-letters a refused delivery that exhausted its park budget', async () => {
      const { handler, session, jobQueue, job } = makeHarness();
      session.stuckMs = 200_000;
      jobQueue.getParkCount.mockImplementation(() => MAX_STEER_PARKS);
      await expect(handler(job, {})).rejects.toThrow('stuck initializing');
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
    });
  });

  describe('drive/feed outcome → requeue', () => {
    it('blocked turn requeues at the session retryAt', async () => {
      const { handler, session, jobQueue, job } = makeHarness();
      session.driveResult = { outcome: 'blocked', retryAt: 1234 };
      const result = await handler(job, {});
      expect(result).toEqual({ parked: 'sdk_resume_choice', retryAt: 1234 });
      expect(jobQueue.requeue).toHaveBeenCalledWith('job-1', 1234, 'claim-1');
      expect(session.settleCalls).toEqual([]);
    });

    it('blocked steer requeues at the session retryAt', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'blocked', retryAt: 1234 };
      const result = await handler(job, {});
      expect(result).toEqual({ parked: 'sdk_resume_choice', retryAt: 1234 });
      expect(jobQueue.requeue).toHaveBeenCalledWith('job-1', 1234, 'claim-1');
      expect(session.settleCalls).toEqual([]);
    });

    it('aborted settles and does not requeue', async () => {
      const { handler, session, job } = makeHarness();
      session.driveResult = { outcome: 'aborted' };
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'aborted' });
      expect(session.settleCalls).toEqual(['uuid-1']);
    });

    it('completed returns completed and does not settle', async () => {
      const { handler, session, jobQueue, job } = makeHarness();
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(jobQueue.requeue).not.toHaveBeenCalled();
      expect(session.settleCalls).toEqual([]);
    });
  });
});
