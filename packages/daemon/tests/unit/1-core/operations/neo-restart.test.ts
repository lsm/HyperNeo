import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('neo.restart operation', () => {
  test('clears context without enqueueing a seed after reset or compaction', async () => {
    const db = await createTestDb();
    await db.createSession(createTestSession('neo:root'));
    const clear = mock(async () => {});
    const events = new InternalEventBus();
    const service = createNeoService(
      db,
      {
        getSessionForControl: async () => ({ startFreshContext: clear }),
        updateSession: async (id: string, updates: Parameters<typeof db.updateSession>[1]) => {
          await db.updateSession(id, updates);
        },
      } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    try {
      expect(
        await invokeOperation(
          createOperationRegistry(createNeoOperations(service)),
          'neo.restart',
          {},
          { source: 'rpc', principal: 'local' }
        )
      ).toMatchObject({ value: { ok: true, sessionId: 'neo:root' } });
      expect(clear).toHaveBeenCalledOnce();
      await events.publish('session.compacted', { sessionId: 'neo:root' } as never);
      expect(
        db
          .getDatabase()
          .prepare(
            "SELECT count(*) AS n FROM job_queue WHERE queue IN ('mailbox', 'message_delivery')"
          )
          .get()
      ).toEqual({ n: 0 });
    } finally {
      await service.dispose();
      db.close();
    }
  });

  test('refuses every agent caller, Neo included', async () => {
    const db = await createTestDb();
    const service = createNeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    try {
      expect(
        await invokeOperation(
          createOperationRegistry(createNeoOperations(service)),
          'neo.restart',
          {},
          { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
        )
      ).toMatchObject({ value: { ok: false, reason: 'This action needs the user.' } });
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('the bound Neo session may open itself', async () => {
    const db = await createTestDb();
    await db.createSession(createTestSession('neo:root'));
    const updateSession = mock(async () => {});
    const events = new InternalEventBus();
    const service = createNeoService(
      db,
      {
        updateSession,
      } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    try {
      expect(
        await invokeOperation(
          createOperationRegistry(createNeoOperations(service)),
          'neo.open',
          {},
          { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
        )
      ).toMatchObject({ value: { sessionId: 'neo:root' } });
    } finally {
      await service.dispose();
      db.close();
    }
  });
});
