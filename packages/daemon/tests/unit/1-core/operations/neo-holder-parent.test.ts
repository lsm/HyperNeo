import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub, Session } from '@hyperneo/shared';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
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

describe('Neo ordinary sessions', () => {
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
      {
        createSession,
        getSessionAsync: vi.fn(),
        updateSession: async (id: string, updates: Partial<Session>) =>
          db.updateSession(id, updates),
      } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.saveProject({ id: 'garden', title: 'Garden', summary: '', context: '' }, 0);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('opening Neo returns the root session and creates no holder', async () => {
    const root = await service.open();
    expect(await service.open()).toBe(root);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('parentSessionId');
  });

  test('opening preserves the same configured turn cap as any ordinary session', async () => {
    const root = await service.open();
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('config.maxTurns');
    const base = db.getSession(root)!;
    const sdkSessionId = crypto.randomUUID();
    db.updateSession(root, {
      sdkSessionId,
      config: { ...base.config, maxTurns: 32, systemPrompt: 'Stored context' },
    });
    expect(await service.open()).toBe(root);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(db.getSession(root)).toMatchObject({
      sdkSessionId,
      config: { systemPrompt: neoPrompt(service.packBriefs()) },
    });
    expect(db.getSession(root)?.config.maxTurns).toBe(32);
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

  test('a chat moved under another is not a clone that can return', () => {
    const moved = {
      id: 'moved',
      parentSessionId: 'parent',
      metadata: { movedUnderParent: true },
    } as unknown as Session;
    const result = loadClone(
      { sessionId: moved.id } as never,
      {
        getSession: () => moved,
      } as unknown as ReturnSessionCloneDependencies
    );
    expect(result).toMatchObject({ reason: { reason: 'not_a_clone' } });
  });
});
