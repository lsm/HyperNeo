import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { MessageHub, ModelInfo, Session, SessionConfig } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { MessageDeliveryTerminalTurnError } from '../../../../src/lib/agent/message-delivery';
import { initializeProviders } from '../../../../src/lib/providers/factory';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

describe('retired session provider', () => {
  it.each([false, true])(
    'fails a saved ACP selection with replacement available=%s',
    async (available) => {
      const db = await createTestDb();
      const registry = initializeProviders();
      const availability = registry
        .getAll()
        .map((provider) =>
          spyOn(provider, 'isAvailable').mockImplementation(
            async () => provider.id === 'anthropic' && available
          )
        );
      const models = spyOn(registry.get('anthropic')!, 'getModels').mockResolvedValue([
        {
          id: 'claude-sonnet-4-5-20250929',
          name: 'Sonnet',
          provider: 'anthropic',
          contextWindow: 200000,
        } as ModelInfo,
      ]);
      let agent: AgentSession | undefined;
      try {
        const session = createTestSession(crypto.randomUUID());
        session.config = {
          ...session.config,
          provider: ' acp ',
          model: 'acp-default',
        } as unknown as SessionConfig;
        await db.createSession(session);
        agent = new AgentSession(
          db.getSession(session.id) as Session,
          db,
          { event: mock(async () => {}) } as unknown as MessageHub,
          await createTestInternalEventBus(),
          mock(async () => undefined),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        const attempt = agent.driveDeliveryTurn('retired-input', 'Synthetic saved input');
        await expect(attempt).rejects.toBeInstanceOf(MessageDeliveryTerminalTurnError);
        await expect(attempt).rejects.toThrow(
          'ACP session providers have been retired. Choose another provider for this session.'
        );
        expect(agent.getSessionData().config.provider).toBe(' acp ');
        expect(db.getSession(session.id)?.config.provider).toBe(' acp ');
      } finally {
        models.mockRestore();
        for (const probe of availability) probe.mockRestore();
        await agent?.cleanup();
        await db.close();
      }
    }
  );
});
