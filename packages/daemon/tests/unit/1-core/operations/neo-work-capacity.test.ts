import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import type { WorkRef, WorkSummary } from '../../../../src/lib/drivers/types.ts';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { NEO_WORK_AWAITING_WORKER, neoWorkerRefKey } from '../../../../src/lib/neo/work-reroute.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

const place = { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen' };
const ref = (id: string): WorkRef => ({ adapter: 'claude-desktop', id });
const summary = (id: string, busy: boolean): WorkSummary => ({
  ref: ref(id),
  title: id,
  place,
  status: 'done',
  lastActivityAt: id === 'x' ? 200 : 100,
  ...(busy ? { busy: true } : {}),
});

async function setup(workers = ['x', 'y']) {
  const db = await createTestDb();
  const busy = new Set<string>();
  const operation = (name: string) =>
    defineOperation({
      name,
      description: name,
      inputSchema: z.record(z.string(), z.unknown()),
      resultSchema: z.unknown(),
      execute: async (input) => {
        if (name === 'work.status') return { ok: true, value: { status: 'done' } };
        if (name === 'work.find') {
          const ids = input.id ? [String(input.id)] : workers;
          return {
            places: [
              {
                place,
                lastActivityAt: 200,
                openCount: ids.length,
                archivedCount: 0,
                adapters: ['claude-desktop'],
                work: ids.map((id) => summary(id, busy.has(id))),
              },
            ],
            unreachable: [],
          };
        }
        if (name !== 'work.send') return { ok: true, value: { stopped: true } };
        const worker = (input.ref as WorkRef).id;
        if (worker === 'gone') return { ok: false, reason: 'not_open', detail: 'archived' };
        busy.add(worker);
        return { ok: true, value: { delivered: true } };
      },
    });
  const registry = createOperationRegistry(
    ['work.send', 'work.status', 'work.find', 'work.stop'].map(operation)
  );
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  Object.assign(service, { returnReport: async () => {}, deliver: async () => {} });
  const targets: Record<string, NeoDriverTarget> = {
    a: { verb: 'send', ref: ref('a-worker') },
    b: { verb: 'send', ref: ref('x') },
    c: { verb: 'send', ref: ref('gone') },
  };
  for (const id of ['a', 'b', 'c']) {
    service.driverTargets.propose(
      service.repo,
      {
        id,
        requestKey: `neo:root:${id}`,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: `m-${id}`,
        title: `Card ${id}`,
        instruction: `Do ${id}.`,
      },
      targets[id]
    );
    service.askRecords.open(
      {
        id: `ask-${id}`,
        requestKey: `ask-${id}`,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: `m-${id}`,
        title: id,
        ask: id,
        doneWhen: id,
        doneSource: 'human',
      },
      [{ text: `Outcome ${id}`, check: null, deliveredBy: id }]
    );
  }
  expect(service.editDependencies('b', ['a'])).toMatchObject({ ok: true });
  const answer = () => {
    const item = service.askRecords.get('ask-a')!.doneItems![0];
    service.askRecords.tickItem(
      'ask-a',
      { ...item, state: 'met', evidence: 'The human answered: merged', metBy: 'human' },
      Date.now(),
      item,
      true
    );
  };
  const approveReserved = async (id: string) => {
    const ask = service.askRecords.forWork(id)!;
    const item = ask.doneItems!.find((entry) => !entry.removed && entry.state === 'needs_you')!;
    expect(item.options).toEqual(['先不做', '开始']);
    expect(service.proposalApproval(id)).toBe(false);
    service.askRecords.tickItem(
      ask.id,
      {
        ...item,
        state: 'met',
        evidence: 'The human answered: 开始',
        metBy: 'human',
      },
      Date.now(),
      item,
      true
    );
    await service.answerStartQuestion(ask, item, '开始');
    expect(service.proposalApproval(id)).toBe(true);
  };
  const workerOf = (id: string) => service.driverTargets.readRef(id)?.id ?? null;
  const settle = (id: string) => {
    service.repo.transitionWork(id, service.repo.getWork(id)!, { status: 'reported' });
    busy.delete(workerOf(id) ?? '');
  };
  return { db, service, answer, workerOf, settle, approveReserved };
}

describe('NeoWorkDriverTargetRepository.occupiedWorkers', () => {
  test('a card blocked on prerequisites does not hold its worker against other cards', async () => {
    const { db, service, workerOf, approveReserved } = await setup();
    try {
      service.repo.transitionWork('c', service.repo.getWork('c')!, {
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
      expect(
        service.driverTargets.occupiedWorkers(service.repo, 'c').has(neoWorkerRefKey(ref('x')))
      ).toBe(true);
      expect(
        service.driverTargets
          .occupiedWorkers(service.repo, 'c', new Set(['b']))
          .has(neoWorkerRefKey(ref('x')))
      ).toBe(false);
      expect(await service.admitWork('c', true)).toEqual({ ok: true, handoff: 'not_started' });
      expect(workerOf('c')).toBeNull();
      await approveReserved('c');
      expect(workerOf('c')).toBe('x');
    } finally {
      db.close();
    }
  });
});

describe('NeoWorkDriverTargetRepository.occupiedWorkers for other targets', () => {
  test('a blocked card keeps a chat, agent or adopted target occupied, since only driver sends re-check', async () => {
    const { db, service } = await setup();
    try {
      service.repo.proposeWork({
        id: 'd',
        requestKey: 'neo:root:d',
        projectId: null,
        originSessionId: 'neo:root',
        title: 'Card d',
        instruction: 'Do d.',
        targetSessionId: 'chat-1',
      });
      const chat = neoWorkerRefKey({ adapter: 'hyperneo-sessions', id: 'chat-1' });
      expect(
        service.driverTargets.occupiedWorkers(service.repo, 'c', new Set(['d'])).has(chat)
      ).toBe(true);
      service.driverTargets.propose(
        service.repo,
        {
          id: 'e',
          requestKey: 'neo:root:e',
          projectId: null,
          originSessionId: 'neo:root',
          title: 'Card e',
          instruction: 'Track e.',
        },
        { verb: 'adopt', ref: ref('adopted') }
      );
      expect(
        service.driverTargets
          .occupiedWorkers(service.repo, 'c', new Set(['d', 'e']))
          .has(neoWorkerRefKey(ref('adopted')))
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('NeoService.admitWork after a prerequisite is met', () => {
  test('a card whose reserved worker was taken while it waited moves to an idle one', async () => {
    const { db, service, answer, workerOf, approveReserved } = await setup();
    try {
      service.repo.transitionWork('c', service.repo.getWork('c')!, {
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
      await service.admitWork('c', true);
      await approveReserved('c');
      answer();
      expect(await service.admitWork('b', true)).toEqual({ ok: true, handoff: 'not_started' });
      expect(workerOf('b')).toBeNull();
      await approveReserved('b');
      expect(workerOf('c')).toBe('x');
      expect(workerOf('b')).toBe('y');
    } finally {
      db.close();
    }
  });

  test('a card whose only worker was taken gets it back once that worker is free again', async () => {
    const { db, service, answer, workerOf, settle, approveReserved } = await setup(['x']);
    try {
      service.repo.transitionWork('c', service.repo.getWork('c')!, {
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
      await service.admitWork('c', true);
      await approveReserved('c');
      answer();
      await service.admitWork('b', true);
      expect(service.repo.getWork('b')).toMatchObject({
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
      settle('c');
      expect(await service.admitWork('b', true)).toEqual({ ok: true, handoff: 'not_started' });
      expect(workerOf('b')).toBeNull();
      await approveReserved('b');
      expect(workerOf('b')).toBe('x');
    } finally {
      db.close();
    }
  });

  test('a card whose worker stayed free still goes to it', async () => {
    const { db, service, answer, workerOf } = await setup();
    try {
      answer();
      expect(await service.admitWork('b', true)).toEqual({ ok: true, handoff: 'started' });
      expect(workerOf('b')).toBe('x');
    } finally {
      db.close();
    }
  });
});
