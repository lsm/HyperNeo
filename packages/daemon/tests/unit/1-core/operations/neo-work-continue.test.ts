import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { readContinueBudget } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const HOUR = 60 * 60 * 1000;
const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 'local_ios' };

describe('readContinueBudget', () => {
  test('allows five continues within four hours of the start', () => {
    expect(readContinueBudget(null, 0, HOUR)).toBeNull();
    expect(readContinueBudget({ count: 4 }, 0, 3 * HOUR)).toBeNull();
    expect(readContinueBudget({ count: 5 }, 0, HOUR)).toContain('continue_budget_spent');
    expect(readContinueBudget({ count: 1 }, 0, 4 * HOUR)).toContain('continue_budget_spent');
  });
});

describe('neo.work.continue', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let sent: Array<{ ref: unknown; message: string }>;
  let lastActivityAt: number;
  let duringSend: () => Promise<void>;
  let delivered: boolean;
  const human: OperationCaller = { source: 'rpc', principal: 'local' };

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession({ ...createTestSession('root'), status: 'active' });
    sent = [];
    lastActivityAt = 0;
    duringSend = async () => {};
    delivered = true;
    const driverRegistry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'test status',
        inputSchema: z.object({ ref: z.unknown() }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({
          ok: true,
          value: { status: 'done', lastActivityAt, lastReply: 'Skeleton builds.' },
        }),
      }),
      defineOperation({
        name: 'work.send',
        description: 'test send',
        inputSchema: z.object({ ref: z.unknown(), message: z.string() }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'mutate' },
        execute: async (input: { ref: unknown; message: string }) => {
          sent.push(input);
          await duringSend();
          return { ok: true, value: { delivered } };
        },
      }),
    ]);
    service = new NeoService(
      db,
      { getOperationRegistry: () => driverRegistry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function reportedWork(): NeoWork {
    const { work } = service.driverTargets.propose(
      service.repo,
      {
        id: 'w-ios',
        requestKey: 'root:ios',
        concernId: null,
        originSessionId: 'root',
        title: 'Neo iOS app',
        instruction: 'Build the skeleton.',
      },
      { verb: 'start', adapter: 'claude-desktop', place: { machine: 'm5', name: 'neo-ios' } }
    );
    service.workGoals.record(work.id, 'A full-featured Neo iOS app', '- all screens work');
    service.driverTargets.recordRef(work.id, ref, Date.now() - 60_000);
    const queued = service.repo.transitionWork(work.id, work, { status: 'queued' })!;
    return service.repo.transitionWork(work.id, queued, {
      status: 'reported',
      report: 'Skeleton builds.',
    })!;
  }

  function invoke(input: unknown, caller = human) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.work.continue',
      input,
      caller
    );
  }

  test('sends the next step with the goal to the same session and reopens the card', async () => {
    const work = reportedWork();
    const result = await invoke({ id: work.id, message: 'Now build the chat screen.' });
    expect(result).toMatchObject({
      value: { ok: true, work: { status: 'queued', report: expect.stringContaining('1/5') } },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].ref).toEqual(ref);
    expect(sent[0].message).toContain('Now build the chat screen.');
    expect(sent[0].message).toContain('What the human asked: A full-featured Neo iOS app');
    expect(service.workContinues.get(work.id)).toMatchObject({
      count: 1,
      lastMessage: 'Now build the chat screen.',
    });
  });

  test('the idle reply from before a continue does not close the reopened card', async () => {
    const work = reportedWork();
    lastActivityAt = Date.now() - 1_000;
    await invoke({ id: work.id, message: 'Now build the chat screen.' });
    await service.refreshDriverWork();
    expect(service.repo.getWork(work.id)?.status).toBe('queued');

    lastActivityAt = Date.now() + 1_000;
    await service.refreshDriverWork();
    expect(service.repo.getWork(work.id)?.status).toBe('reported');
  });

  test('counts the time budget of sent work from the card, not the target session', async () => {
    const { work } = service.driverTargets.propose(
      service.repo,
      {
        id: 'w-sent',
        requestKey: 'root:sent',
        concernId: null,
        originSessionId: 'root',
        title: 'Neo iOS app',
        instruction: 'Make voice durable.',
      },
      { verb: 'send', ref }
    );
    service.driverTargets.recordRef(work.id, ref, Date.now() - 5 * HOUR);
    const queued = service.repo.transitionWork(work.id, work, { status: 'queued' })!;
    service.repo.transitionWork(work.id, queued, { status: 'reported', report: 'Done.' });
    expect(await invoke({ id: work.id, message: 'Next step.' })).toMatchObject({
      value: { ok: true },
    });
  });

  test('a continue queued behind a running turn never settles on that turn', async () => {
    const work = reportedWork();
    delivered = false;
    await invoke({ id: work.id, message: 'Now build the chat screen.' });
    expect(service.driverTargets.readStartedAt(work.id)).toBeNull();
    lastActivityAt = Date.now() + 1_000;
    await service.refreshDriverWork();
    expect(service.repo.getWork(work.id)?.status).toBe('queued');
  });

  test('stops after five continues and tells Neo to ask the human', async () => {
    const work = reportedWork();
    for (let n = 0; n < 5; n++)
      expect(await invoke({ id: work.id, message: `Step ${n}` })).toMatchObject({
        value: { ok: true },
      });
    expect(await invoke({ id: work.id, message: 'Step 6' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('continue_budget_spent') },
    });
    expect(sent).toHaveLength(5);
  });

  test('lets only one of two overlapping continues through, so five stays the cap', async () => {
    const work = reportedWork();
    for (let n = 0; n < 4; n++) service.workContinues.record(work.id, `Step ${n}`, Date.now());
    const [first, second] = await Promise.all([
      invoke({ id: work.id, message: 'Step 5' }),
      invoke({ id: work.id, message: 'Step 6' }),
    ]);
    expect([first, second]).toMatchObject([
      { value: { ok: true } },
      { value: { ok: false, reason: expect.stringContaining('already being continued') } },
    ]);
    expect(service.workContinues.get(work.id)?.count).toBe(5);
    expect(sent).toHaveLength(1);
  });

  test('leaves work cancelled while the message was on its way cancelled', async () => {
    const work = reportedWork();
    const queued = service.repo.transitionWork(work.id, work, { status: 'queued' })!;
    duringSend = async () => {
      await service.cancel(queued.id);
    };
    expect(await invoke({ id: work.id, message: 'Go on.' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('cancelled meanwhile') },
    });
    expect(service.repo.getWork(work.id)?.status).toBe('cancelled');
  });

  test('refuses another Neo session and work that never started', async () => {
    const work = reportedWork();
    const stranger: OperationCaller = { source: 'mcp', sessionId: 'other', role: 'neo' };
    db.createSession({ ...createTestSession('other'), status: 'active' });
    service.repo.reserveBinding({ sessionId: 'other', kind: 'worker', concernId: null });
    expect(await invoke({ id: work.id, message: 'Go on.' }, stranger)).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke({ id: 'missing', message: 'Go on.' })).toMatchObject({
      value: { ok: false, reason: 'work_not_found' },
    });
    expect(sent).toEqual([]);
  });
});
