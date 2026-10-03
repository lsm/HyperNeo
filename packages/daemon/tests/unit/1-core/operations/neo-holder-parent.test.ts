import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub, Session } from '@hyperneo/shared';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  type ReturnSessionCloneDependencies,
  loadClone,
} from '../../../../src/lib/session/clone-return-operation.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('Neo holder sessions', () => {
  let db: Database;
  let service: NeoService;
  const createSession = vi.fn(async (params: { sessionId: string }) => {
    db.createSession(createTestSession(params.sessionId));
    return params.sessionId;
  });
  beforeEach(async () => {
    db = await createTestDb();
    createSession.mockClear();
    service = new NeoService(
      db,
      { createSession, getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.saveConcern({ id: 'garden', title: 'Garden', summary: '', context: '' }, 0);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('nest under the root Neo session', async () => {
    const root = await service.open(null);
    const holder = await service.open('garden');
    expect(createSession.mock.calls[0][0]).toMatchObject({ sessionId: root });
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('parentSessionId', root);
    expect(createSession.mock.calls[1][0]).toMatchObject({
      sessionId: holder,
      parentSessionId: root,
    });
  });

  test('cannot use the clone return path into Neo', () => {
    const holder = { id: 'neo:holder', parentSessionId: 'neo:root' } as Session;
    const result = loadClone(
      { sessionId: holder.id } as never,
      {
        getSession: () => holder,
      } as unknown as ReturnSessionCloneDependencies
    );
    expect(result).toMatchObject({ reason: { reason: 'not_a_clone' } });
  });
});
