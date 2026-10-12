import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  neoContinuesLeft,
  neoStalledContinues,
  neoWorkProgress,
  readContinueBudget,
  readNeoWorkContinueBudget,
} from '../../../../src/lib/neo/driver-work.ts';
import {
  neoContinuedReport,
  requireNeoAskContinueReserved,
  requireNeoContinueDelivered,
  requireNeoWorkContinuable,
  requireNeoWorkStillContinuable,
} from '../../../../src/lib/neo/continue-work.ts';
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
  test('stops only after three continues in a row with no progress, within twelve hours', () => {
    expect(readContinueBudget(null, '0|a', 0, HOUR)).toBeNull();
    expect(readContinueBudget({ progress: '0|a', stalled: 1 }, '0|a', 0, 11 * HOUR)).toBeNull();
    expect(readContinueBudget({ progress: '0|a', stalled: 2 }, '0|a', 0, HOUR)).toContain(
      'brought no new commit, PR state, review or report'
    );
    expect(readContinueBudget({ progress: '0|a', stalled: 9 }, '1|a', 0, HOUR)).toBeNull();
    expect(readContinueBudget(null, '0|a', 0, 12 * HOUR)).toContain('continue_budget_spent');
  });
});

describe('neoStalledContinues', () => {
  test('counts on while nothing moved and starts over on any progress', () => {
    expect(neoStalledContinues(null, '0|a')).toBe(0);
    expect(neoStalledContinues({ progress: '0|a', stalled: 1 }, '0|a')).toBe(2);
    expect(neoStalledContinues({ progress: '0|a', stalled: 1 }, '0|b')).toBe(0);
    expect(neoStalledContinues({ progress: null, stalled: 4 }, '0|a')).toBe(0);
  });
});

describe('neoWorkProgress', () => {
  test('moves with a new PR revision or a new worker report, not with Neo reopening the card', () => {
    const reported = { status: 'reported' as const, report: 'Built the skeleton.' };
    const first = neoWorkProgress(reported, 2, null);
    expect(neoWorkProgress({ status: 'queued', report: 'Continued 1: go' }, 2, first)).toBe(first);
    expect(neoWorkProgress(reported, 3, first)).not.toBe(first);
    expect(neoWorkProgress({ ...reported, report: 'Built chat.' }, 2, first)).not.toBe(first);
    expect(neoWorkProgress({ status: 'queued', report: null }, null, null)).toBe('0|-');
  });
});

describe('neoContinuesLeft', () => {
  test("counts what is left of the card's run without progress", () => {
    expect(neoContinuesLeft(1)).toBe(2);
    expect(neoContinuesLeft(9)).toBe(0);
  });
});

describe('readNeoWorkContinueBudget', () => {
  const approved = { status: 'open' as const, approvedAt: 0, approvedContinues: 0 };
  test('work under an approved ask keeps going while it moves, for 48 hours, with no flat count', () => {
    expect(
      readNeoWorkContinueBudget(
        { progress: 'old', stalled: 2 },
        'p',
        0,
        { ...approved, approvedContinues: 500 },
        13 * HOUR
      )
    ).toBeNull();
    expect(
      readNeoWorkContinueBudget({ progress: 'p', stalled: 2 }, 'p', 0, approved, 13 * HOUR)
    ).toContain('brought no new commit');
    expect(readNeoWorkContinueBudget(null, 'p', 0, approved, 48 * HOUR)).toContain(
      'approve it again'
    );
  });

  test('work under an ask not approved, or settled, keeps its own budget', () => {
    expect(
      readNeoWorkContinueBudget(
        { progress: 'p', stalled: 2 },
        'p',
        0,
        { ...approved, approvedAt: null },
        HOUR
      )
    ).toContain('brought no new commit');
    expect(
      readNeoWorkContinueBudget(
        { progress: 'p', stalled: 2 },
        'p',
        0,
        { ...approved, status: 'achieved' },
        HOUR
      )
    ).toContain('brought no new commit');
    expect(readNeoWorkContinueBudget({ progress: 'p', stalled: 2 }, 'p', 0, null, HOUR)).toContain(
      'brought no new commit'
    );
  });
});

describe('requireNeoAskContinueReserved', () => {
  test('refuses a continue the shared budget could not reserve', () => {
    expect(requireNeoAskContinueReserved({ ask: null, ok: true })).toEqual({
      value: { ask: null, ok: true },
    });
    expect(requireNeoAskContinueReserved({ ask: null, ok: false })).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('no longer approved') },
    });
  });
});

const continued: NeoWork = Object.freeze({
  id: 'work-1',
  requestKey: 'root:k',
  originSessionId: 'root',
  originMessageId: 'm1',
  concernId: null,
  title: 'Font',
  instruction: 'Raise the font.',
  targetSessionId: null,
  sessionId: null,
  status: 'reported',
  report: 'Done.',
  createdAt: 0,
  updatedAt: 0,
});
const rejected = (reason: string) => ({ reason: { ok: false as const, reason } });

describe('requireNeoWorkContinuable', () => {
  const evidence = {
    work: continued,
    ref,
    continued: null,
    progress: '0|a',
    inFlight: false,
    ask: null,
  };

  test('admits started work that is queued or reported', () => {
    expect(requireNeoWorkContinuable(evidence, HOUR)).toEqual({ value: { work: continued, ref } });
  });

  test.each([
    ['unstarted work', { ...evidence, ref: null }, 'Only started driver work can be continued.'],
    ['missing work', { ...evidence, work: null }, 'Only started driver work can be continued.'],
    [
      'failed work',
      { ...evidence, work: { ...continued, status: 'failed' as const } },
      'This work already failed; it cannot be continued.',
    ],
    [
      'an in-flight continue',
      { ...evidence, inFlight: true },
      'This work is already being continued; wait for that first.',
    ],
  ])('rejects %s', (_name, input, reason) => {
    expect(requireNeoWorkContinuable(input, HOUR)).toEqual(rejected(reason));
  });

  test('a spent budget is reported before an in-flight continue', () => {
    expect(
      requireNeoWorkContinuable(
        { ...evidence, continued: { progress: '0|a', stalled: 2 }, inFlight: true },
        HOUR
      )
    ).toMatchObject({ reason: { reason: expect.stringContaining('continue_budget_spent') } });
  });
});

describe('requireNeoContinueDelivered', () => {
  const target = { work: continued, ref };

  test('a delivered or queued send passes and a failed one rejects with the driver reason', () => {
    expect(
      requireNeoContinueDelivered(target, {
        kind: 'completed',
        value: { ok: true, value: { delivered: true } },
      })
    ).toEqual({ value: { ref } });
    expect(
      requireNeoContinueDelivered(target, {
        kind: 'completed',
        value: { ok: true, value: { delivered: false } },
      })
    ).toEqual({ value: { ref, queued: true } });
    expect(
      requireNeoContinueDelivered(target, {
        kind: 'failed',
        code: 'execution_failed',
        message: 'offline',
      })
    ).toEqual(rejected('offline'));
  });
});

describe('requireNeoWorkStillContinuable', () => {
  test('work cancelled while the message was in flight stays cancelled', () => {
    expect(requireNeoWorkStillContinuable({ work: continued })).toEqual({ value: continued });
    expect(requireNeoWorkStillContinuable({ work: { ...continued, status: 'cancelled' } })).toEqual(
      rejected('The message was sent, but this work was cancelled meanwhile; it stays cancelled.')
    );
  });
});

describe('neoContinuedReport', () => {
  test('counts the continue and keeps the message short', () => {
    expect(neoContinuedReport(2, 'Also fix the footer.')).toBe('Continued 2: Also fix the footer.');
    expect(neoContinuedReport(1, 'x'.repeat(400))).toHaveLength('Continued 1: '.length + 300);
  });
});

describe('neo.work.continue', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let sent: Array<{ ref: unknown; message: string }>;
  let lastActivityAt: number;
  let recentInputs: Array<{ at: number; text: string }> | undefined;
  let duringSend: () => Promise<void>;
  let delivered: boolean;
  let unreachable: boolean;
  const human: OperationCaller = { source: 'rpc', principal: 'local' };

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession({ ...createTestSession('root'), status: 'active' });
    sent = [];
    lastActivityAt = 0;
    recentInputs = undefined;
    duringSend = async () => {};
    delivered = true;
    unreachable = false;
    const driverRegistry = createOperationRegistry([
      defineOperation({
        name: 'work.status',
        description: 'test status',
        inputSchema: z.object({ ref: z.unknown() }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'read' },
        execute: async () => ({
          ok: true,
          value: { status: 'done', lastActivityAt, lastReply: 'Skeleton builds.', recentInputs },
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
          return unreachable
            ? { ok: false, reason: 'unreachable', detail: 'down' }
            : { ok: true, value: { delivered } };
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
      value: {
        ok: true,
        work: { status: 'queued', report: expect.stringContaining('Continued 1:') },
      },
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

  test('work under an approved ask stops only when the card stalls, and approving again restarts it', async () => {
    const work = reportedWork();
    const opened = service.askRecords.open({
      id: 'ask-ios',
      requestKey: 'root:ask-ios',
      concernId: null,
      originSessionId: 'root',
      originMessageId: null,
      title: 'Neo iOS app',
      ask: 'Build the Neo iOS app',
      doneWhen: '- all screens work',
      doneSource: 'human',
    })!;
    service.askRecords.link(opened.id, work.id);
    service.askRecords.approve(opened.id, Date.now());
    db.getDatabase()
      .prepare('UPDATE neo_asks SET approved_continues = 500 WHERE id = ?')
      .run(opened.id);
    for (let index = 0; index < 3; index++)
      expect(await invoke({ id: work.id, message: `Step ${index}.` })).toMatchObject({
        value: { ok: true },
      });
    expect(service.askRecords.get(opened.id)).toMatchObject({
      approvedContinues: 503,
      approvedUntil: expect.any(Number),
    });
    expect(service.askRecords.get(opened.id)?.approvedContinueLimit).toBeUndefined();
    unreachable = true;
    expect(await invoke({ id: work.id, message: 'Not delivered.' })).toMatchObject({
      value: { ok: false },
    });
    expect(service.askRecords.get(opened.id)?.approvedContinues).toBe(503);
    unreachable = false;
    expect(await invoke({ id: work.id, message: 'One more.' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('brought no new commit') },
    });
    expect(service.isContinueStalled(work.id)).toBe(true);
    const stalled = service.repo.getWork(work.id)!;
    service.repo.transitionWork(work.id, stalled, { status: 'failed', report: 'Gave up.' });
    expect(service.isContinueStalled(work.id)).toBe(false);
    service.repo.transitionWork(work.id, service.repo.getWork(work.id)!, {
      status: stalled.status,
      report: stalled.report,
    });
    expect(service.isContinueStalled(work.id)).toBe(true);
    service.askRecords.approve(opened.id, Date.now() + 1);
    expect(service.isContinueStalled(work.id)).toBe(false);
    expect(service.askRecords.get(opened.id)?.approvedContinues).toBe(0);
    for (const message of ['Approved again.', 'Second.', 'Third.'])
      expect(await invoke({ id: work.id, message })).toMatchObject({ value: { ok: true } });
    expect(await invoke({ id: work.id, message: 'Fourth.' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('brought no new commit') },
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

  test('a continue queued behind a running turn settles on the reply after its message lands', async () => {
    const work = reportedWork();
    delivered = false;
    recentInputs = [{ at: 10, text: 'Build the skeleton.' }];
    await invoke({ id: work.id, message: 'Now build the chat screen.' });
    expect(service.driverTargets.readSent(work.id)).toEqual({
      inputBefore: 10,
      opening: 'Now build the chat screen.',
    });
    lastActivityAt = Date.now() + 1_000;
    await service.refreshDriverWork();
    expect(service.repo.getWork(work.id)?.status).toBe('queued');

    const landedAt = Date.now() + 2_000;
    recentInputs = [
      ...recentInputs,
      { at: landedAt, text: 'Now build the chat screen. Neo routed' },
    ];
    lastActivityAt = landedAt;
    await service.refreshDriverWork();
    expect(service.driverTargets.readStartedAt(work.id)).toBe(landedAt);
    expect(service.repo.getWork(work.id)?.status).toBe('queued');

    lastActivityAt = landedAt + 1_000;
    await service.refreshDriverWork();
    expect(service.repo.getWork(work.id)?.status).toBe('reported');
  });

  test('stops after three continues with no progress and tells Neo to ask the human', async () => {
    const work = reportedWork();
    for (let n = 0; n < 3; n++)
      expect(await invoke({ id: work.id, message: `Step ${n}` })).toMatchObject({
        value: { ok: true },
      });
    expect(await invoke({ id: work.id, message: 'Step 4' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('continue_budget_spent') },
    });
    expect(sent).toHaveLength(3);
  });

  test('keeps continuing past three while the worker keeps reporting new progress', async () => {
    const work = reportedWork();
    for (let n = 0; n < 6; n++) {
      expect(await invoke({ id: work.id, message: `Step ${n}` })).toMatchObject({
        value: { ok: true },
      });
      const current = service.repo.getWork(work.id)!;
      service.repo.transitionWork(work.id, current, {
        status: 'reported',
        report: `Finished step ${n}.`,
      });
    }
    expect(service.workContinues.get(work.id)).toMatchObject({ count: 6, stalled: 0 });
    expect(sent).toHaveLength(6);
  });

  test('lets only one of two overlapping continues through', async () => {
    const work = reportedWork();
    for (let n = 0; n < 4; n++)
      service.workContinues.record(work.id, `Step ${n}`, Date.now(), `${n}|x`);
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
