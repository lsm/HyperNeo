import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('Neo read-only work cards', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let registry: OperationRegistry;
  let read: ReturnType<typeof mock>;
  let returned: ReturnType<typeof spyOn>;
  const neo: OperationCaller = {
    source: 'mcp',
    role: 'neo',
    sessionId: 'root',
    neoTurn: { messageId: 'system-note', human: false, isLive: () => true },
  };
  const target = {
    verb: 'read' as const,
    operation: 'daemon.snapshot',
    input: { section: 'status' },
  };
  const proposal = {
    requestKey: 'readback',
    askId: 'ask',
    title: 'Read daemon status',
    instruction: 'Read the running daemon status.',
    work: target,
  };
  const invoke = (name: string, input: unknown, caller = neo) =>
    invokeOperation(registry, name, input, caller);
  function setRead(policy: OperationDefinition['policy'] = { safetyClass: 'read' }) {
    registry = createOperationRegistry([
      ...createNeoOperations(service),
      defineOperation({
        name: 'daemon.snapshot',
        description: 'Read daemon status',
        inputSchema: z.object({ section: z.literal('status') }),
        resultSchema: z.unknown(),
        policy,
        execute: read,
      }),
    ]);
  }
  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('root'));
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'root', projectId: null, kind: 'neo' });
    service.askRecords.open({
      id: 'ask',
      requestKey: 'ask',
      projectId: null,
      originSessionId: 'root',
      originMessageId: 'human-message',
      title: 'Inspect the daemon',
      ask: 'Inspect the daemon',
      doneWhen: 'Status is known',
      doneSource: 'human',
    });
    read = mock(async () => ({ ok: true, value: { running: true } }));
    returned = spyOn(
      service as unknown as { checkDone: () => Promise<string> },
      'checkDone'
    ).mockResolvedValue('checked');
    setRead();
  });
  afterEach(() => {
    returned.mockRestore();
    service.dispose();
    db.close();
  });

  test.each([undefined, 'consultation'])(
    'reads without approval during %s and replays once',
    async (consultationId) => {
      const caller = { ...neo, neoTurn: { ...neo.neoTurn!, consultationId } };
      const sibling = service.repo.proposeWork({
        id: 'sibling',
        requestKey: 'sibling',
        projectId: null,
        originSessionId: 'root',
        originMessageId: 'system-note',
        title: 'Change code',
        instruction: 'Make the fix.',
      });
      service.askRecords.link('ask', sibling.id);
      const result = await invoke('neo.work.propose', proposal, caller);
      expect(result).toMatchObject({
        value: { ok: true, work: { status: 'reported', sessionId: null } },
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(target.input, {
        source: 'mcp',
        role: 'neo',
        sessionId: 'root',
      });
      expect(service.repo.listWork().find((work) => work.id !== sibling.id)?.report).toContain(
        '"running":true'
      );
      expect(service.askRecords.get('ask')?.approvedAt).toBeNull();
      expect(service.repo.getWork(sibling.id)?.status).toBe('proposed');
      expect(await invoke('neo.work.start', { id: sibling.id }, caller)).toMatchObject({
        value: { ok: false },
      });
      expect(await invoke('neo.work.propose', proposal, caller)).toMatchObject({
        value: { ok: true, work: { status: 'reported' } },
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(returned).toHaveBeenCalledTimes(1);
    }
  );

  test('uses the existing GitHub reader for authoritative PR and CI state', async () => {
    const url = 'https://github.com/lsm/HyperNeo/pull/6727';
    service.readRefStates = async () => [
      { kind: 'pr', url, state: 'MERGED', at: 1, done: true, closedBy: null, parent: null },
    ];
    service.readPrs = async () => [
      { url, state: 'MERGED', checks: 'passing', review: 'approved', isDraft: false },
    ];
    const result = await invoke('neo.work.propose', {
      ...proposal,
      work: { verb: 'read', operation: 'neo.github.read', input: { url } },
    });
    expect(result).toMatchObject({
      value: {
        ok: true,
        work: { status: 'reported', report: expect.stringContaining('"checks":"passing"') },
      },
    });
    expect(service.repo.listWork()[0].report).toContain('"state":"MERGED"');
    expect(service.askRecords.get('ask')?.approvedAt).toBeNull();
  });

  test.each([
    { safetyClass: 'mutate' as const },
    { safetyClass: 'destructive' as const },
    { safetyClass: 'human_only' as const },
    { safetyClass: 'read' as const, roles: ['workflow_worker' as const] },
    undefined,
  ])('refuses an operation without Neo read authority before writing: %j', async (policy) => {
    setRead(policy);
    if (!policy) {
      registry = createOperationRegistry(
        registry.entries.map((operation) =>
          operation.name === target.operation ? { ...operation, policy: undefined } : operation
        )
      );
    }
    expect(await invoke('neo.work.propose', proposal)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('read_operation_required') },
    });
    expect(service.repo.listWork()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  test.each([
    { ...proposal, work: { ...target, operation: 'missing.read' } },
    { ...proposal, work: { ...target, ref: { adapter: 'hyperneo', id: 'worker' } } },
    { ...proposal, targetSessionId: 'worker' },
  ])('rejects missing or mixed execution targets', async (input) => {
    const result = await invoke('neo.work.propose', input);
    expect(
      result.kind === 'failed' ||
        ('value' in result && (result.value as { ok: boolean }).ok === false)
    ).toBe(true);
    expect(service.repo.listWork()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  test.each([
    { ...neo, sessionId: 'impostor' },
    { ...neo, neoTurn: { ...neo.neoTurn!, isLive: () => false } },
  ])('preserves caller and live-input admission', async (caller) => {
    expect(await invoke('neo.work.propose', proposal, caller)).toMatchObject({
      value: { ok: false },
    });
    expect(read).not.toHaveBeenCalled();
    expect(service.repo.listWork()).toEqual([]);
  });

  test.each(['failed', 'invalid', 'domain'] as const)(
    'records %s reads without claiming success and retries without approval',
    async (failure) => {
      read.mockImplementationOnce(async () => {
        if (failure === 'failed') throw new Error('unreachable');
        return { ok: false, reason: 'unreachable' };
      });
      const input =
        failure === 'invalid' ? { ...proposal, work: { ...target, input: {} } } : proposal;
      expect(await invoke('neo.work.propose', input)).toMatchObject({
        value: { ok: true, work: { status: 'failed' } },
      });
      const work = service.repo.listWork()[0];
      expect(work.report).toContain(failure === 'invalid' ? 'invalid_input' : 'unreachable');
      expect(service.askRecords.get('ask')?.approvedAt).toBeNull();
      if (failure !== 'invalid') {
        expect(await invoke('neo.work.retry', { id: work.id })).toMatchObject({
          value: { ok: true, work: { status: 'reported' } },
        });
        expect(read).toHaveBeenCalledTimes(2);
      } else expect(read).not.toHaveBeenCalled();
    }
  );

  test('a replay returns its read card, and a changed read target is a separate card', async () => {
    const first = await invoke('neo.work.propose', proposal);
    expect(await invoke('neo.work.propose', proposal)).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);
    const changed = await invoke('neo.work.propose', {
      ...proposal,
      work: { ...target, input: { section: 'changed' } },
    });
    expect(changed).toMatchObject({ value: { ok: true } });
    const cardId = (outcome: unknown) =>
      (outcome as { value: { work: { id: string } } }).value.work.id;
    expect(cardId(changed)).not.toBe(cardId(first));
    expect(service.repo.listWork()).toHaveLength(2);
  });

  test('coalesces concurrent proposals into one read and one card', async () => {
    const results = await Promise.all([
      invoke('neo.work.propose', proposal),
      invoke('neo.work.propose', proposal),
    ]);
    for (const result of results)
      expect(result).toMatchObject({ value: { ok: true, work: { status: 'reported' } } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(service.repo.listWork()).toHaveLength(1);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  test('refuses read proposals under a settled ask', async () => {
    const ask = service.askRecords.get('ask')!;
    service.askRecords.settle(ask, 'abandoned', 'Dropped', 'The user dropped this ask.');
    expect(await invoke('neo.work.propose', proposal)).toMatchObject({ value: { ok: false } });
    expect(read).not.toHaveBeenCalled();
    expect(service.repo.listWork()).toEqual([]);
  });

  test.each(['proposed', 'queued'] as const)(
    'recovers a %s read card once with no approval',
    async (status) => {
      const { work } = service.driverTargets.propose(
        service.repo,
        {
          id: 'read',
          requestKey: 'root:readback',
          projectId: null,
          originSessionId: 'root',
          originMessageId: 'system-note',
          title: proposal.title,
          instruction: proposal.instruction,
        },
        target
      );
      service.askRecords.link('ask', work.id);
      if (status === 'queued') service.repo.transitionWork(work.id, work, { status: 'queued' });
      await service.recover();
      expect(service.repo.getWork(work.id)?.status).toBe('reported');
      await service.recover();
      expect(read).toHaveBeenCalledTimes(1);
      expect(service.askRecords.get('ask')?.approvedAt).toBeNull();
    }
  );

  test('rechecks operation classification before starting persisted work', async () => {
    const { work } = service.driverTargets.propose(
      service.repo,
      {
        id: 'read',
        requestKey: 'root:readback',
        projectId: null,
        originSessionId: 'root',
        originMessageId: 'system-note',
        title: proposal.title,
        instruction: proposal.instruction,
      },
      target
    );
    setRead({ safetyClass: 'mutate' });
    await service.start(work.id);
    expect(read).not.toHaveBeenCalled();
    expect(service.repo.getWork(work.id)).toMatchObject({
      status: 'failed',
      report: expect.stringContaining('read_operation_required'),
    });
  });

  test('does not overwrite cancellation while the read is in flight', async () => {
    read.mockImplementationOnce(async () => {
      const work = service.repo.listWork()[0];
      await service.cancel(work.id);
      return { ok: true, value: 'late result' };
    });
    expect(await invoke('neo.work.propose', proposal)).toMatchObject({
      value: { ok: true, work: { status: 'cancelled' } },
    });
    expect(returned).not.toHaveBeenCalled();
    expect(service.repo.listWork()[0].report).toBeNull();
  });
});
