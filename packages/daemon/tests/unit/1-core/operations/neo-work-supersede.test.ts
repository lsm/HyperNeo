import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { requireNeoWorkSupersedable } from '../../../../src/lib/neo/work-supersede.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('requireNeoWorkSupersedable', () => {
  const old = { id: 'w1', status: 'failed' as const, concernId: null };
  test('passes a proposal that supersedes nothing', () => {
    expect(requireNeoWorkSupersedable({ concernId: null }, null, 'ok')).toEqual({ value: 'ok' });
  });

  test('passes failed or cancelled work in the same concern', () => {
    for (const status of ['failed', 'cancelled'] as const)
      expect(
        requireNeoWorkSupersedable({ supersedes: 'w1', concernId: null }, { ...old, status }, 'ok')
      ).toEqual({ value: 'ok' });
  });

  test('refuses missing, still-live or another concern’s work', () => {
    const input = { supersedes: 'w1', concernId: null };
    expect(requireNeoWorkSupersedable(input, null, 'ok')).toEqual({
      reason: { ok: false, reason: 'The work this supersedes was not found.' },
    });
    expect(requireNeoWorkSupersedable(input, { ...old, status: 'queued' }, 'ok')).toEqual({
      reason: {
        ok: false,
        reason: 'Only failed or cancelled work can be superseded; w1 is queued.',
      },
    });
    expect(requireNeoWorkSupersedable(input, { ...old, concernId: 'other' }, 'ok')).toEqual({
      reason: { ok: false, reason: 'The work this supersedes belongs to another concern.' },
    });
  });
});

describe('neo.work.propose with supersedes', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const neo = (messageId: string): OperationCaller => ({
    source: 'mcp',
    sessionId: 'root',
    role: 'neo',
    neoTurn: { messageId, human: true, isLive: () => true },
  });
  const invoke = (name: string, input: unknown, caller: OperationCaller) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, caller);
  const propose = async (requestKey: string, extra: Record<string, unknown> = {}) =>
    invoke(
      'neo.work.propose',
      {
        requestKey,
        targetSessionId: 'project',
        title: 'Fix the bug',
        instruction: 'Fix the bug and report.',
        ...extra,
      },
      neo(`ask-${requestKey}`)
    );
  const workOf = (outcome: unknown) => (outcome as { value: { work: NeoWork } }).value.work;

  beforeEach(async () => {
    db = await createTestDb();
    for (const id of ['root', 'project'])
      db.createSession({
        ...createTestSession(id),
        workspacePath: id === 'project' ? '/projects/app' : null,
      });
    service = new NeoService(
      db,
      {} as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  test('links the failed card to the work that replaces it in the snapshot', async () => {
    const first = workOf(await propose('A'));
    service.repo.transitionWork(first.id, first, { status: 'failed', report: 'It stopped.' });
    const second = workOf(await propose('B', { supersedes: first.id }));
    const snapshot = await invoke('neo.snapshot', {}, { source: 'rpc', principal: 'local' });
    expect((snapshot as { value: NeoSnapshot }).value.workSupersessions).toEqual([
      { workId: first.id, supersededBy: second.id, supersededAt: expect.any(Number) },
    ]);
  });

  test('refuses to supersede work that is still live, and records nothing', async () => {
    const first = workOf(await propose('A'));
    expect(await propose('B', { supersedes: first.id })).toMatchObject({
      value: {
        ok: false,
        reason: `Only failed or cancelled work can be superseded; ${first.id} is proposed.`,
      },
    });
    expect(service.workSupersessions.list([first.id])).toEqual([]);
  });
});
