import { describe, expect, it, mock } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { deliverMessage } from '../../../../src/lib/agent/message-delivery';
import { clearProviderFailure } from '../../../../src/lib/providers/provider-failure-store';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

describe('provider auth rejection delivery policy', () => {
  it('fails queued inputs once instead of replaying them against a rejected key', async () => {
    const db = await createTestDb();
    const session = createTestSession('rejected-key');
    session.config.provider = 'glm';
    await db.createSession(session);
    clearProviderFailure('glm');
    const agent = new AgentSession(
      session,
      db,
      { event: mock(async () => {}) } as unknown as MessageHub,
      await createTestInternalEventBus(),
      mock(async () => 'unused-synthetic-key'),
      undefined,
      undefined,
      undefined,
      undefined,
      { autoReplayPendingMessages: false }
    );
    try {
      for (const uuid of ['report', 'notice']) {
        db.getSDKMessageRepo().saveUserMessage(
          session.id,
          {
            type: 'user',
            uuid,
            message: { role: 'user', content: uuid },
          },
          'enqueued'
        );
        await deliverMessage(db.getJobQueueRepo(), session.id, uuid, { origin: 'chat' });
      }
      await agent.onProviderAuthRejected('synthetic rejected key');
      const deadline = Date.now() + 1000;
      while (agent.isInterruptInProgress() && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 1));
      expect(agent.isInterruptInProgress()).toBe(false);
      for (const uuid of ['report', 'notice'])
        expect(db.getSDKMessageRepo().getDeliveryContent(session.id, uuid)?.sendStatus).toBe(
          'failed'
        );
      expect(db.getJobQueueRepo().activeDeliveryMessageUuids(session.id).size).toBe(0);
    } finally {
      await agent.cleanup();
      clearProviderFailure('glm');
      db.close();
    }
  });
});
