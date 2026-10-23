import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const messageId = '20000000-0000-4000-8000-000000000001';

describe('Neo turn end', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  let events: InternalEventBus<DaemonInternalEventMap>;
  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    db.createSession(createTestSession(root));
    service = createNeoService(
      db,
      { getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    service.asks.append({
      conversationId,
      requestId: messageId,
      askOrigin: { sessionId: root, messageId },
      content: 'What is the latest commit? One sentence.',
    });
  });
  afterEach(async () => {
    await service.dispose();
    db.close();
    vi.useRealTimers();
  });

  test.each(['success', 'error_max_turns'])(
    '%s does not publish reasoning text or manufacture another input',
    async (subtype) => {
      for (const message of [
        {
          type: 'assistant',
          uuid: 'thought',
          message: { role: 'assistant', content: 'Checking.' },
        },
        { type: 'result', uuid: 'result', subtype },
      ])
        db.getSDKMessageRepo().saveSDKMessage(root, {
          session_id: root,
          ...message,
          neoInputOrigin: { sessionId: root, messageId },
        } as unknown as SDKMessage);
      vi.useFakeTimers();
      await events.publish('session.updated', {
        sessionId: root,
        processingState: { status: 'idle' },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(service.publications.list(conversationId)).toEqual([]);
      expect(db.getSDKMessageRepo().listQueuedInputs(root)).toEqual([]);
      expect(
        service.asks.list(conversationId)?.find((ask) => ask.requestId === messageId)
      ).not.toBeNull();
    }
  );
});
