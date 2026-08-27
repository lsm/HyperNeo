import { describe, expect, it, mock } from 'bun:test';
import type {
  DriveTurnOutcome,
  FeedSteerOutcome,
  MessageDeliverySession,
} from '../../../../src/lib/agent/message-delivery';
import { MAX_ACP_STEER_PARKS, MAX_STEER_PARKS } from '../../../../src/lib/agent/message-delivery';
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
  driveResult: DriveTurnOutcome = { outcome: 'completed' };
  feedResult: FeedSteerOutcome = { outcome: 'consumed' };
  waitingForInput = false;
  stuckMs: number | null = null;
  driveCalls = 0;
  feedCalls = 0;
  settleCalls: string[] = [];
  lastUuid?: string;
  lastAlreadyConsumed = false;

  stuckInitializingMs(): number | null {
    return this.stuckMs;
  }

  async driveDeliveryTurn(
    messageUuid: string,
    _content: unknown,
    _parentToolUseId?: string | null,
    alreadyConsumed?: boolean
  ): Promise<DriveTurnOutcome> {
    this.driveCalls++;
    this.lastUuid = messageUuid;
    this.lastAlreadyConsumed = alreadyConsumed ?? false;
    return this.driveResult;
  }

  async feedDeliverySteer(messageUuid: string, _content: unknown): Promise<FeedSteerOutcome> {
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

    it('dedupes batch members when failing an archived session', async () => {
      const markFailedSpy = mock(() => 'db-x');
      const publishSpy = mock(async () => {});
      const { handler, isSessionArchived, job } = makeHarness(
        { markDeliveryFailed: markFailedSpy, publishStatusChanged: publishSpy },
        {
          sessionId: 'sess-1',
          messageUuid: 'uuid-1',
          role: 'turn',
          origin: 'chat',
          batchUuids: ['uuid-1', 'uuid-2', 'uuid-1'],
        }
      );
      isSessionArchived.mockImplementation(() => true);
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'archived' });
      expect(markFailedSpy).toHaveBeenCalledTimes(2);
      expect(publishSpy).toHaveBeenCalledWith('sess-1', ['db-x', 'db-x']);
    });

    it('does not publish status when no batch member flips to failed', async () => {
      const markFailedSpy = mock(() => null);
      const publishSpy = mock(async () => {});
      const { handler, session, isSessionArchived, job } = makeHarness({
        markDeliveryFailed: markFailedSpy,
        publishStatusChanged: publishSpy,
      });
      isSessionArchived.mockImplementation(() => true);
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'archived' });
      expect(publishSpy).not.toHaveBeenCalled();
      expect(session.settleCalls).toEqual(['uuid-1']);
    });
  });

  describe('role × sendStatus gates', () => {
    it('a submitted steer parks under the ACP acceptance budget (not skipped)', async () => {
      const { handler, session, jobQueue, getMessageContent, metrics, job } = makeHarness(
        {},
        STEER_PAYLOAD
      );
      getMessageContent.mockImplementation(() => ({ content: 'steer', sendStatus: 'submitted' }));
      const result = await handler(job, {});
      expect(result).toMatchObject({ parked: 'acp_awaiting_acceptance' });
      expect(result.retryAt).toBeGreaterThan(Date.now());
      expect(jobQueue.requeueParked).toHaveBeenCalledWith('job-1', result.retryAt, 'claim-1');
      expect(session.feedCalls).toBe(0);
      expect(session.settleCalls).toEqual([]);
      expect(metrics.recordReclaimSkip).toHaveBeenCalledWith('alreadySubmitted');
    });

    it('an identical submitted TURN settles as skipped (not parked)', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'turn', sendStatus: 'submitted' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'skipped', sendStatus: 'submitted' });
      expect(session.settleCalls).toEqual(['uuid-1']);
      expect(session.driveCalls).toBe(0);
    });

    it('a deferred turn settles as skipped', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'x', sendStatus: 'deferred' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'skipped', sendStatus: 'deferred' });
      expect(session.settleCalls).toEqual(['uuid-1']);
      expect(session.driveCalls).toBe(0);
    });

    it('a failed steer settles as skipped before the steer path runs', async () => {
      const { handler, session, getMessageContent, job } = makeHarness({}, STEER_PAYLOAD);
      getMessageContent.mockImplementation(() => ({ content: 'x', sendStatus: 'failed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'skipped', sendStatus: 'failed' });
      expect(session.settleCalls).toEqual(['uuid-1']);
      expect(session.feedCalls).toBe(0);
    });

    it('a consumed steer returns already_consumed without re-feeding or settling', async () => {
      const { handler, session, getMessageContent, metrics, job } = makeHarness({}, STEER_PAYLOAD);
      getMessageContent.mockImplementation(() => ({ content: 'steer', sendStatus: 'consumed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'already_consumed' });
      expect(session.feedCalls).toBe(0);
      expect(session.settleCalls).toEqual([]);
      expect(metrics.recordReclaimSkip).toHaveBeenCalledWith('alreadyConsumed');
    });

    it('a consumed turn still drives and forwards the already-consumed flag', async () => {
      const { handler, session, getMessageContent, job } = makeHarness();
      getMessageContent.mockImplementation(() => ({ content: 'x', sendStatus: 'consumed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.driveCalls).toBe(1);
      expect(session.lastAlreadyConsumed).toBe(true);
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

    it('settles an already-consumed steer before the gate even when stuck', async () => {
      const { handler, session, jobQueue, metrics, getMessageContent, job } = makeHarness(
        {},
        STEER_PAYLOAD
      );
      session.stuckMs = 200_000;
      getMessageContent.mockImplementation(() => ({ content: 'steer', sendStatus: 'consumed' }));
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'already_consumed' });
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

    it('admits when the session does not expose the probe (older session objects)', async () => {
      const { handler, session, job } = makeHarness();
      delete (session as Partial<MockSession>).stuckInitializingMs;
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'completed' });
      expect(session.driveCalls).toBe(1);
    });

    it('dead-letters a refused delivery that exhausted its park budget', async () => {
      const { handler, session, jobQueue, job } = makeHarness();
      session.stuckMs = 200_000;
      jobQueue.getParkCount.mockImplementation(() => 60);
      await expect(handler(job, {})).rejects.toThrow('stuck initializing');
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
    });
  });

  describe('drive-turn outcome → mutation table', () => {
    const DRIVE_TURN_ROWS: Array<{
      label: string;
      drive: DriveTurnOutcome;
      expected: Record<string, unknown>;
      requeue?: boolean;
      requeueAt?: number;
      settle?: boolean;
      reclaimSkip?: string;
    }> = [
      { label: 'completed', drive: { outcome: 'completed' }, expected: { outcome: 'completed' } },
      {
        label: 'blocked',
        drive: { outcome: 'blocked', retryAt: 5000 },
        expected: { parked: 'sdk_resume_choice', retryAt: 5000 },
        requeue: true,
        requeueAt: 5000,
      },
      {
        label: 'recovery_pending',
        drive: { outcome: 'recovery_pending', retryAt: 9000 },
        expected: { parked: 'limit_recovery', retryAt: 9000 },
        requeue: true,
        requeueAt: 9000,
      },
      {
        label: 'aborted',
        drive: { outcome: 'aborted' },
        expected: { outcome: 'aborted' },
        settle: true,
      },
      {
        label: 'turn_terminated',
        drive: { outcome: 'turn_terminated' },
        expected: { outcome: 'completed', skipped: 'turn_terminated' },
        settle: true,
        reclaimSkip: 'turn_terminated',
      },
    ];

    it.each(DRIVE_TURN_ROWS.map((row) => [row.label, row] as const))('%s', async (_label, row) => {
      const { handler, session, jobQueue, metrics, job } = makeHarness();
      session.driveResult = row.drive;
      const result = await handler(job, {});
      expect(result).toEqual(row.expected);
      expect(jobQueue.requeue).toHaveBeenCalledTimes(row.requeue ? 1 : 0);
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
      if (row.requeueAt !== undefined) {
        expect(jobQueue.requeue).toHaveBeenCalledWith('job-1', row.requeueAt, 'claim-1');
      }
      expect(session.settleCalls).toEqual(row.settle ? ['uuid-1'] : []);
      if (row.reclaimSkip) {
        expect(metrics.recordReclaimSkip).toHaveBeenCalledWith(row.reclaimSkip);
      }
    });
  });

  describe('feed-steer outcome → mutation table', () => {
    const FEED_STEER_ROWS: Array<{
      label: string;
      feed: FeedSteerOutcome;
      expected: Record<string, unknown>;
      park?: 'requeue' | 'requeueParked';
      promoteRole?: 'turn' | 'steer';
      settle?: boolean;
    }> = [
      { label: 'consumed', feed: { outcome: 'consumed' }, expected: { outcome: 'consumed' } },
      {
        label: 'aborted',
        feed: { outcome: 'aborted' },
        expected: { outcome: 'aborted' },
        settle: true,
      },
      {
        label: 'park (not waiting)',
        feed: { outcome: 'park' },
        expected: { parked: 'turn_blocked' },
        park: 'requeueParked',
      },
      {
        label: 'awaiting_acceptance',
        feed: { outcome: 'awaiting_acceptance' },
        expected: { parked: 'acp_awaiting_acceptance' },
        park: 'requeueParked',
      },
      {
        label: 'ack_timeout',
        feed: { outcome: 'ack_timeout' },
        expected: { parked: 'steer_ack_timeout' },
        park: 'requeueParked',
      },
      {
        label: 'promote',
        feed: { outcome: 'promote' },
        expected: { outcome: 'superseded', promoted: 'turn' },
        promoteRole: 'turn',
      },
    ];

    it.each(FEED_STEER_ROWS.map((row) => [row.label, row] as const))('%s', async (_label, row) => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = row.feed;
      const result = await handler(job, {});
      expect(result).toMatchObject(row.expected);
      expect(jobQueue.requeue).toHaveBeenCalledTimes(row.park === 'requeue' ? 1 : 0);
      expect(jobQueue.requeueParked).toHaveBeenCalledTimes(row.park === 'requeueParked' ? 1 : 0);
      if (row.park === 'requeueParked') {
        expect(result.retryAt).toBeGreaterThan(Date.now());
        expect(jobQueue.requeueParked).toHaveBeenCalledWith('job-1', result.retryAt, 'claim-1');
      }
      if (row.promoteRole) {
        expect(jobQueue.requeueAs).toHaveBeenCalledWith(
          'job-1',
          row.promoteRole,
          expect.any(Number),
          'claim-1'
        );
      }
      expect(session.settleCalls).toEqual(row.settle ? ['uuid-1'] : []);
    });
  });

  describe('promote UNIQUE fallback', () => {
    it('re-queues as steer when promoting to turn hits the UNIQUE constraint', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'promote' };
      jobQueue.requeueAs.mockImplementation((_id: string, role: string) => {
        if (role === 'turn') throw new Error('UNIQUE constraint failed: idx');
        return null;
      });
      const result = await handler(job, {});
      expect(result).toEqual({ outcome: 'superseded', promoted: 'steer' });
      expect(jobQueue.requeueAs).toHaveBeenCalledTimes(2);
      expect(jobQueue.requeueAs).toHaveBeenCalledWith(
        'job-1',
        'turn',
        expect.any(Number),
        'claim-1'
      );
      expect(jobQueue.requeueAs).toHaveBeenCalledWith(
        'job-1',
        'steer',
        expect.any(Number),
        'claim-1'
      );
      expect(session.settleCalls).toEqual([]);
    });

    it('re-throws a non-UNIQUE error from requeueAs', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'promote' };
      jobQueue.requeueAs.mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(handler(job, {})).rejects.toThrow('boom');
    });
  });

  describe('park budgets + waiting-for-input asymmetry', () => {
    it('a park while waiting for input requeues plain and bypasses the park budget', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'park' };
      session.waitingForInput = true;
      jobQueue.getParkCount.mockImplementation(() => MAX_STEER_PARKS);
      const result = await handler(job, {});
      expect(result).toMatchObject({ parked: 'turn_blocked_gate_open' });
      expect(result.retryAt).toBeGreaterThan(Date.now());
      expect(jobQueue.requeue).toHaveBeenCalledWith('job-1', result.retryAt, 'claim-1');
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
    });

    it('a park not waiting for input parks via requeueParked (never plain requeue)', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'park' };
      const result = await handler(job, {});
      expect(result).toMatchObject({ parked: 'turn_blocked' });
      expect(jobQueue.requeueParked).toHaveBeenCalledWith('job-1', result.retryAt, 'claim-1');
      expect(jobQueue.requeue).not.toHaveBeenCalled();
    });

    it('a park past MAX_STEER_PARKS dead-letters without requeueing', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'park' };
      jobQueue.getParkCount.mockImplementation(() => MAX_STEER_PARKS);
      await expect(handler(job, {})).rejects.toThrow('Steer parked past its budget');
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
      expect(jobQueue.requeue).not.toHaveBeenCalled();
    });

    it('awaiting_acceptance past MAX_ACP_STEER_PARKS dead-letters without requeueing', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'awaiting_acceptance' };
      jobQueue.getParkCount.mockImplementation(() => MAX_ACP_STEER_PARKS);
      await expect(handler(job, {})).rejects.toThrow(
        'ACP steer awaited acceptance past its budget'
      );
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
    });

    it('ack_timeout past MAX_STEER_PARKS dead-letters without requeueing', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'ack_timeout' };
      jobQueue.getParkCount.mockImplementation(() => MAX_STEER_PARKS);
      await expect(handler(job, {})).rejects.toThrow(
        'Steer acknowledgment timed out past its budget'
      );
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
      expect(jobQueue.requeue).not.toHaveBeenCalled();
    });

    it('a submitted steer preflight past MAX_ACP_STEER_PARKS dead-letters', async () => {
      const { handler, jobQueue, getMessageContent, job } = makeHarness({}, STEER_PAYLOAD);
      getMessageContent.mockImplementation(() => ({ content: 'steer', sendStatus: 'submitted' }));
      jobQueue.getParkCount.mockImplementation(() => MAX_ACP_STEER_PARKS);
      await expect(handler(job, {})).rejects.toThrow(
        'ACP steer awaited acceptance past its budget'
      );
      expect(jobQueue.requeueParked).not.toHaveBeenCalled();
    });
  });

  describe('outcome-routing read laziness (A3a)', () => {
    it('consumed and promote outcomes never read the park count', async () => {
      const consumed = makeHarness({}, STEER_PAYLOAD);
      consumed.session.feedResult = { outcome: 'consumed' };
      const consumedResult = await consumed.handler(consumed.job, {});
      expect(consumedResult).toEqual({ outcome: 'consumed' });
      expect(consumed.jobQueue.getParkCount).not.toHaveBeenCalled();

      const promoted = makeHarness({}, STEER_PAYLOAD);
      promoted.session.feedResult = { outcome: 'promote' };
      const promotedResult = await promoted.handler(promoted.job, {});
      expect(promotedResult).toEqual({ outcome: 'superseded', promoted: 'turn' });
      expect(promoted.jobQueue.getParkCount).not.toHaveBeenCalled();
    });

    it('park and awaiting_acceptance outcomes read the park count exactly once', async () => {
      const parked = makeHarness({}, STEER_PAYLOAD);
      parked.session.feedResult = { outcome: 'park' };
      await parked.handler(parked.job, {});
      expect(parked.jobQueue.getParkCount).toHaveBeenCalledTimes(1);

      const awaiting = makeHarness({}, STEER_PAYLOAD);
      awaiting.session.feedResult = { outcome: 'awaiting_acceptance' };
      await awaiting.handler(awaiting.job, {});
      expect(awaiting.jobQueue.getParkCount).toHaveBeenCalledTimes(1);
    });

    it('ack_timeout reads the park count exactly once', async () => {
      const { handler, session, jobQueue, job } = makeHarness({}, STEER_PAYLOAD);
      session.feedResult = { outcome: 'ack_timeout' };
      const result = await handler(job, {});
      expect(result).toMatchObject({ parked: 'steer_ack_timeout' });
      expect(jobQueue.getParkCount).toHaveBeenCalledTimes(1);
    });
  });

  describe('identical tuples, different mutations (role × outcome)', () => {
    it('aborted settles identically from drive and feed', async () => {
      const turn = makeHarness();
      turn.session.driveResult = { outcome: 'aborted' };
      const steer = makeHarness({}, STEER_PAYLOAD);
      steer.session.feedResult = { outcome: 'aborted' };
      const turnResult = await turn.handler(turn.job, {});
      const steerResult = await steer.handler(steer.job, {});
      expect(turnResult).toEqual({ outcome: 'aborted' });
      expect(steerResult).toEqual({ outcome: 'aborted' });
      expect(turn.session.settleCalls).toEqual(['uuid-1']);
      expect(steer.session.settleCalls).toEqual(['uuid-1']);
    });

    it('clean terminal outcomes differ: drive completed vs feed consumed', async () => {
      const turn = makeHarness();
      const steer = makeHarness({}, STEER_PAYLOAD);
      const turnResult = await turn.handler(turn.job, {});
      const steerResult = await steer.handler(steer.job, {});
      expect(turnResult).toEqual({ outcome: 'completed' });
      expect(steerResult).toEqual({ outcome: 'consumed' });
      expect(turn.session.driveCalls).toBe(1);
      expect(steer.session.feedCalls).toBe(1);
    });

    it('turn blocked requeues plain while steer park parks via requeueParked', async () => {
      const turn = makeHarness();
      turn.session.driveResult = { outcome: 'blocked', retryAt: 1111 };
      const steer = makeHarness({}, STEER_PAYLOAD);
      steer.session.feedResult = { outcome: 'park' };
      const turnResult = await turn.handler(turn.job, {});
      const steerResult = await steer.handler(steer.job, {});
      expect(turnResult).toEqual({ parked: 'sdk_resume_choice', retryAt: 1111 });
      expect(turn.jobQueue.requeue).toHaveBeenCalledWith('job-1', 1111, 'claim-1');
      expect(turn.jobQueue.requeueParked).not.toHaveBeenCalled();
      expect(steerResult).toMatchObject({ parked: 'turn_blocked' });
      expect(steer.jobQueue.requeueParked).toHaveBeenCalledWith(
        'job-1',
        steerResult.retryAt,
        'claim-1'
      );
      expect(steer.jobQueue.requeue).not.toHaveBeenCalled();
    });
  });
});
