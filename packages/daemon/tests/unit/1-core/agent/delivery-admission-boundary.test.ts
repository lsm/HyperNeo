import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageContent, Provider } from '@hyperneo/shared';
import { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  MESSAGE_DELIVERY,
  MessageDeliveryRecoverableTurnError,
} from '../../../../src/lib/agent/message-delivery';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import { setModelsCache } from '../../../../src/lib/model-service';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { Database } from '../../../../src/storage/database';
import type { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

type BoundarySession = {
  db: Database;
  agentSession: AgentSession;
};

async function makeBoundarySession(
  sessionId: string,
  opts?: { provider?: Provider }
): Promise<BoundarySession> {
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
    new MessageHub(),
    bus,
    mock(async () => 'test-api-key'),
    undefined,
    undefined,
    undefined,
    undefined,
    { autoReplayPendingMessages: false }
  );
  return { db, agentSession };
}

function stubLifecycleManager(agentSession: AgentSession, result: 'started' | 'blocked') {
  const ensureQueryStarted = mock(async () => result);
  (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
    ensureQueryStarted,
    executeDeferredRestartIfPending: mock(async () => {}),
  };
  return ensureQueryStarted;
}

function armNeverResolvingQuery(agentSession: AgentSession): void {
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

describe('delivery admission boundary (MDR 3/N)', () => {
  describe('driveDeliveryTurn completes at SDK admission', () => {
    it('completes on the yield attempt onSent while the turn is still running', async () => {
      const sessionId = 'sess-boundary-turn-completed';
      const messageUuid = 'msg-boundary-turn';
      const content = 'turn content';
      const { db, agentSession } = await makeBoundarySession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, messageUuid, 'enqueued', content);
        stubLifecycleManager(agentSession, 'started');
        armNeverResolvingQuery(agentSession);
        agentSession.messageQueue.start();
        const generator = agentSession.messageQueue.messageGenerator(sessionId);

        const turnPromise = agentSession.driveDeliveryTurn(
          messageUuid,
          content,
          null,
          false,
          () => true
        );
        const yielded = await generator.next();
        if (!yielded.value) throw new Error('message not yielded');
        yielded.value.onSent();

        const outcome = await turnPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(repo.getDeliveryContent(sessionId, messageUuid)?.sendStatus).toBe('consumed');
        await generator.return?.(undefined);
      } finally {
        agentSession.messageQueue.stop();
        db.close();
      }
    });

    it('never resolves success from a timeout — a message the SDK never takes fails retryably', async () => {
      const sessionId = 'sess-boundary-turn-timeout';
      const messageUuid = 'msg-boundary-turn-timeout';
      const content = 'unconsumed turn content';
      const { db, agentSession } = await makeBoundarySession(sessionId);
      const previousTimeout = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '60';
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, messageUuid, 'enqueued', content);
        stubLifecycleManager(agentSession, 'started');
        armNeverResolvingQuery(agentSession);

        const turnPromise = agentSession.driveDeliveryTurn(
          messageUuid,
          content,
          null,
          false,
          () => true
        );
        await expect(turnPromise).rejects.toBeInstanceOf(MessageDeliveryRecoverableTurnError);
        await expect(turnPromise).rejects.toThrow('Delivery not consumed within timeout');
        expect(repo.getDeliveryContent(sessionId, messageUuid)?.sendStatus).toBe('enqueued');
      } finally {
        if (previousTimeout === undefined) {
          delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
        } else {
          process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = previousTimeout;
        }
        agentSession.messageQueue.stop();
        db.close();
      }
    });

    it('rejects the in-flight admission on a user interrupt and leaves the row deliverable', async () => {
      const sessionId = 'sess-boundary-turn-interrupt';
      const messageUuid = 'msg-boundary-turn-interrupt';
      const content = 'interrupted turn content';
      const { db, agentSession } = await makeBoundarySession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, messageUuid, 'enqueued', content);
        stubLifecycleManager(agentSession, 'started');
        armNeverResolvingQuery(agentSession);
        agentSession.messageQueue.start();
        const generator = agentSession.messageQueue.messageGenerator(sessionId, {
          suppressPreYieldCallback: true,
        });

        const turnPromise = agentSession.driveDeliveryTurn(
          messageUuid,
          content,
          null,
          false,
          () => true
        );
        const yielded = await generator.next();
        if (!yielded.value) throw new Error('message not yielded');

        agentSession.messageQueue.clear();
        await expect(turnPromise).rejects.toThrow('Interrupted by user');
        expect(repo.getDeliveryContent(sessionId, messageUuid)?.sendStatus).toBe('enqueued');
        await generator.return?.(undefined);
      } finally {
        agentSession.messageQueue.stop();
        db.close();
      }
    });
  });

  describe('unified admission completes at SDK admission (steer-shaped)', () => {
    it('completes on the yield attempt onSent while the target turn keeps running', async () => {
      const sessionId = 'sess-boundary-steer-completed';
      const messageUuid = 'msg-boundary-steer';
      const content = 'steer content';
      const { db, agentSession } = await makeBoundarySession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, messageUuid, 'enqueued', content);
        stubLifecycleManager(agentSession, 'started');
        armNeverResolvingQuery(agentSession);
        agentSession.messageQueue.start();
        const generator = agentSession.messageQueue.messageGenerator(sessionId);

        const steerPromise = agentSession.driveDeliveryTurn(
          messageUuid,
          content,
          null,
          false,
          () => true
        );
        const yielded = await generator.next();
        if (!yielded.value) throw new Error('message not yielded');
        yielded.value.onSent();

        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(repo.getDeliveryContent(sessionId, messageUuid)?.sendStatus).toBe('consumed');
        await generator.return?.(undefined);
      } finally {
        agentSession.messageQueue.stop();
        db.close();
      }
    });

    it('starts the query and admits when the session is idle instead of promoting', async () => {
      const sessionId = 'sess-boundary-steer-idle';
      const messageUuid = 'msg-boundary-steer-idle';
      const content = 'steer from idle';
      const { db, agentSession } = await makeBoundarySession(sessionId);
      try {
        const repo = db.getSDKMessageRepo();
        saveUserMessage(repo, sessionId, messageUuid, 'enqueued', content);
        const ensureQueryStarted = stubLifecycleManager(agentSession, 'started');

        const steerPromise = agentSession.driveDeliveryTurn(
          messageUuid,
          content,
          null,
          false,
          () => true
        );
        for (let i = 0; i < 100; i += 1) {
          if (agentSession.messageQueue.hasPendingOrClaimed(messageUuid)) break;
          await Promise.resolve();
        }
        expect(ensureQueryStarted).toHaveBeenCalledTimes(1);

        agentSession.messageQueue.start();
        const generator = agentSession.messageQueue.messageGenerator(sessionId);
        const yielded = await generator.next();
        if (!yielded.value) throw new Error('message not yielded');
        yielded.value.onSent();

        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(repo.getDeliveryContent(sessionId, messageUuid)?.sendStatus).toBe('consumed');
        await generator.return?.(undefined);
      } finally {
        agentSession.messageQueue.stop();
        db.close();
      }
    });
  });

  describe('mid-turn survivors requeue as message_delivery jobs', () => {
    beforeEach(() => {
      setModelsCache(new Map());
    });

    afterEach(() => {
      setModelsCache(new Map());
      resetProviderRegistry();
    });

    function makeSurvivorQuery(stillQueued: string[]): QueryLike {
      return {
        async *[Symbol.asyncIterator]() {},
        interrupt: async () => ({ still_queued: stillQueued }),
        cancelAsyncMessage: async () => true,
        getContextUsage: async () => ({
          totalTokens: 190_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 95,
          categories: [{ name: 'context', tokens: 190_000 }],
          isAutoCompactEnabled: false,
        }),
        close: () => {},
      } as unknown as QueryLike;
    }

    it('requeues a cancelled in-flight survivor via deliverMessage as a durable recovery job', async () => {
      const sessionId = 'sess-boundary-survivor-yielded';
      const survivorUuid = 'msg-boundary-survivor-yielded';
      const content = 'finish the deploy';
      const { db, agentSession } = await makeBoundarySession(sessionId, { provider: 'openrouter' });
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, survivorUuid, 'enqueued', content);
        await agentSession.stateManager.setProcessing('mid-turn-boundary');
        agentSession.messageQueue.start();
        void agentSession.messageQueue
          .admitWithId(survivorUuid, content, false, { durable: true })
          .catch(() => {});
        const generator = agentSession.messageQueue.messageGenerator(sessionId);
        const yielded = await generator.next();
        if (!yielded.value) throw new Error('survivor not yielded');
        agentSession.queryObject = makeSurvivorQuery([survivorUuid]);

        await agentSession.midTurnContextBudgetCheck();

        const jobs = jobRepo.listJobs({ queue: MESSAGE_DELIVERY, status: 'pending' });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].payload).toMatchObject({
          sessionId,
          messageUuid: survivorUuid,
          origin: 'recovery',
          parentToolUseId: null,
        });
        expect(agentSession.messageQueue.hasPendingOrClaimed(survivorUuid)).toBe(true);
        await generator.return?.(undefined);
      } finally {
        agentSession.messageQueue.stop();
        db.close();
      }
    });

    it('requeues an evicted survivor with durable content via deliverMessage as a recovery job', async () => {
      const sessionId = 'sess-boundary-survivor-evicted';
      const survivorUuid = 'msg-boundary-survivor-evicted';
      const content = 'ship the release';
      const { db, agentSession } = await makeBoundarySession(sessionId, { provider: 'openrouter' });
      try {
        const repo = db.getSDKMessageRepo();
        const jobRepo = db.getJobQueueRepo();
        saveUserMessage(repo, sessionId, survivorUuid, 'enqueued', content);
        await agentSession.stateManager.setProcessing('mid-turn-boundary');
        agentSession.messageQueue.start();
        agentSession.queryObject = makeSurvivorQuery([survivorUuid]);

        await agentSession.midTurnContextBudgetCheck();

        const jobs = jobRepo.listJobs({ queue: MESSAGE_DELIVERY, status: 'pending' });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].payload).toMatchObject({
          sessionId,
          messageUuid: survivorUuid,
          origin: 'recovery',
        });
        expect(agentSession.messageQueue.hasPendingOrClaimed(survivorUuid)).toBe(true);
      } finally {
        agentSession.messageQueue.stop();
        db.close();
      }
    });
  });
});
