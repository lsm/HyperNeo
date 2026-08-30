import { describe, expect, it, mock } from 'bun:test';
import type {
  DeliveryOutcome,
  MessageDeliverySession,
} from '../../../../src/lib/agent/message-delivery';
import type { DeliveryMetrics } from '../../../../src/lib/agent/message-delivery-metrics';
import {
  createMessageDeliveryHandler,
  type MessageDeliveryHandlerDeps,
} from '../../../../src/lib/job-handlers/message-delivery.handler';
import type {
  Job,
  JobQueueRepository,
} from '../../../../src/storage/repositories/job-queue-repository';

const CHAT_PAYLOAD: Record<string, unknown> = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-1',
  origin: 'chat',
};

const LEGACY_PAYLOAD: Record<string, unknown> = {
  sessionId: 'sess-1',
  messageUuid: 'uuid-1',
  origin: 'chat',
  role: 'steer',
  batchUuids: ['uuid-1', 'uuid-2'],
};

function makeJob(payload: Record<string, unknown>): Job {
  return { id: 'job-1', claimToken: 'claim-1', payload } as unknown as Job;
}

class MockSession implements MessageDeliverySession {
  driveResult: DeliveryOutcome = { outcome: 'completed' };
  waitingForInput = false;
  driveCalls = 0;
  settleCalls: string[] = [];
  lastUuid?: string;

  async driveDeliveryTurn(
    messageUuid: string,
    _content: unknown,
    _parentToolUseId?: string | null,
    _alreadyConsumed?: boolean,
    _claimGuard?: () => boolean,
    _signal?: AbortSignal,
    _observer?: unknown
  ): Promise<DeliveryOutcome> {
    this.driveCalls++;
    this.lastUuid = messageUuid;
    return this.driveResult;
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
  payload: Record<string, unknown> = CHAT_PAYLOAD
) {
  const session = new MockSession();
  const jobQueue = {
    isClaimCurrent: mock((_id: string, _token: string | null) => true),
    requeue: mock((_id: string, _runAt: number, _token: string | null) => null),
    requeueParked: mock((_id: string, _runAt: number, _token: string | null) => null),
  };
  const getSession = mock(() => session);
  const getMessageContent = mock(() => ({ content: 'hello', sendStatus: 'enqueued' }));
  const isSessionArchived = mock(() => false);
  const metrics = {
    recordReclaimSkip: mock(() => {}),
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

    it('marks the message failed and settles for an archived session', async () => {
      const markFailedSpy = mock((_sessionId: string, uuid: string) => `db-${uuid}`);
      const publishSpy = mock(async () => {});
      const { handler, session, isSessionArchived, job } = makeHarness(
        { markDeliveryFailed: markFailedSpy, publishStatusChanged: publishSpy },
        CHAT_PAYLOAD
      );
      isSessionArchived.mockImplementation(() => true);
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'archived' });
      expect(markFailedSpy).toHaveBeenCalledWith('sess-1', 'uuid-1');
      expect(publishSpy).toHaveBeenCalledWith('sess-1', ['db-uuid-1']);
      expect(session.settleCalls).toEqual(['uuid-1']);
    });
  });

  describe('unknown payload fields are ignorable (pre-FIFO queued jobs)', () => {
    it('a legacy payload carrying role and batchUuids parses and drives the turn', async () => {
      const { handler, session, job } = makeHarness({}, LEGACY_PAYLOAD);
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.driveCalls).toBe(1);
      expect(session.lastUuid).toBe('uuid-1');
    });
  });

  describe('sendStatus gates', () => {
    it('a consumed row returns completed without driving', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'hello', sendStatus: 'consumed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.driveCalls).toBe(0);
      expect(session.settleCalls).toEqual([]);
    });

    it('a deferred row settles as skipped', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'x', sendStatus: 'deferred' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'skipped', sendStatus: 'deferred' });
      expect(session.settleCalls).toEqual(['uuid-1']);
      expect(session.driveCalls).toBe(0);
    });

    it('a failed row settles as skipped', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'x', sendStatus: 'failed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'skipped', sendStatus: 'failed' });
      expect(session.settleCalls).toEqual(['uuid-1']);
      expect(session.driveCalls).toBe(0);
    });

    it('a submitted row is still admitted', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'hello', sendStatus: 'submitted' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.driveCalls).toBe(1);
      expect(session.settleCalls).toEqual([]);
    });
  });

  describe('drive outcome → requeue', () => {
    it('blocked requeues at the session retryAt', async () => {
      const { handler, session, jobQueue, job } = makeHarness();
      session.driveResult = { outcome: 'blocked', retryAt: 1234 };
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
