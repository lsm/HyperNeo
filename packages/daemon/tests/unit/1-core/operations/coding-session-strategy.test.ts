import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createNeoOperations, createNeoService } from '../../helpers/neo-service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { MessageHub } from '@hyperneo/shared';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import {
  codingSessionStrategy,
  planCodingSessionDispatch,
} from '../../../../src/lib/neo/packs/coding/session-strategy.ts';

const ref = (id: string) => ({ adapter: 'claude-desktop', id });
const session = (id: string, name: string, state: 'available' | 'busy' | 'unknown') => ({
  ref: ref(id),
  name,
  state,
});

describe('sessionStrategy setting', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  const human: OperationCaller = { source: 'rpc', principal: 'local' };
  const scope = { kind: 'repo', key: 'synthetic/repo' };
  beforeEach(async () => {
    db = await createTestDb();
    await db.createSession(createTestSession('neo:root'));
    service = createNeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });
  const invoke = (name: string, input: unknown) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, human);

  test('is long-lived before an answer, without storing or reporting an answer', async () => {
    expect(codingSessionStrategy(db.getDatabase(), 'synthetic/repo')).toBe('long_lived');
    expect(
      await invoke('pack.preferences.get', { pack: 'coding', scope, key: 'sessionStrategy' })
    ).toMatchObject({ value: { preference: null } });
  });

  test('a human picks long-lived, per-task or per-PR for one repository', async () => {
    for (const [value, ok] of [
      ['per_pr', true],
      ['per_task', true],
      ['long_lived', true],
      ['per_feature', false],
    ] as const)
      expect(
        await invoke('pack.preferences.set', {
          pack: 'coding',
          scope,
          key: 'sessionStrategy',
          value,
        })
      ).toMatchObject({ value: { ok } });
    await invoke('pack.preferences.set', {
      pack: 'coding',
      scope,
      key: 'sessionStrategy',
      value: 'per_task',
    });
    expect(codingSessionStrategy(db.getDatabase(), 'synthetic/repo')).toBe('per_task');
    expect(codingSessionStrategy(db.getDatabase(), 'synthetic/other')).toBe('long_lived');
    expect(codingSessionStrategy(db.getDatabase(), 'Synthetic/Repo')).toBe('per_task');
  });
});

describe('planCodingSessionDispatch', () => {
  test('long-lived work for a feature goes to its session, and queues there while busy', () => {
    const assigned = session('backend', 'backend', 'available');
    const pool = [assigned, session('frontend', 'frontend', 'available')];
    expect(
      planCodingSessionDispatch({ strategy: 'long_lived', workType: 'backend', assigned, pool })
    ).toEqual({ verb: 'send', ref: ref('backend'), bind: false });
    const busy = { ...assigned, state: 'busy' as const };
    expect(
      planCodingSessionDispatch({
        strategy: 'long_lived',
        workType: 'backend',
        assigned: busy,
        pool: [busy, session('frontend', 'frontend', 'available')],
      })
    ).toEqual({ verb: 'queue', ref: ref('backend') });
  });

  test('unrelated long-lived work reuses an idle session, preferring its work type', () => {
    const pool = [
      session('frontend', 'frontend', 'available'),
      session('backend', 'backend', 'available'),
    ];
    expect(
      planCodingSessionDispatch({ strategy: 'long_lived', workType: 'backend', pool })
    ).toEqual({ verb: 'send', ref: ref('backend'), bind: true });
    expect(planCodingSessionDispatch({ strategy: 'long_lived', workType: 'ios', pool })).toEqual({
      verb: 'send',
      ref: ref('frontend'),
      bind: true,
    });
  });

  test('a new long-lived session starts only when every session is busy, named for its work type', () => {
    expect(
      planCodingSessionDispatch({ strategy: 'long_lived', workType: 'dev', pool: [] })
    ).toEqual({ verb: 'start', name: 'dev' });
    expect(
      planCodingSessionDispatch({
        strategy: 'long_lived',
        workType: 'dev',
        pool: [session('a', 'dev', 'busy'), session('b', 'dev-2', 'busy')],
      })
    ).toEqual({ verb: 'start', name: 'dev-3' });
  });

  test('unknown status waits instead of starting a duplicate session', () => {
    expect(
      planCodingSessionDispatch({
        strategy: 'long_lived',
        workType: 'dev',
        pool: [session('a', 'dev', 'busy'), session('b', 'backend', 'unknown')],
      })
    ).toEqual({ verb: 'wait' });
    const assigned = session('a', 'dev', 'unknown');
    for (const strategy of ['long_lived', 'per_task', 'per_pr'] as const)
      expect(
        planCodingSessionDispatch({ strategy, workType: 'dev', assigned, pool: [assigned] })
      ).toEqual({ verb: 'wait' });
  });

  test('per-task and per-PR keep their own session and start one for new work', () => {
    const idle = [session('a', 'dev', 'available')];
    for (const strategy of ['per_task', 'per_pr'] as const) {
      expect(planCodingSessionDispatch({ strategy, workType: 'dev', pool: idle })).toEqual({
        verb: 'start',
      });
      const assigned = session('mine', 'task', 'busy');
      expect(
        planCodingSessionDispatch({ strategy, workType: 'dev', assigned, pool: idle })
      ).toEqual({ verb: 'queue', ref: ref('mine') });
      expect(
        planCodingSessionDispatch({
          strategy,
          workType: 'dev',
          assigned: { ...assigned, state: 'available' },
          pool: idle,
        })
      ).toEqual({ verb: 'send', ref: ref('mine'), bind: false });
    }
  });
});
