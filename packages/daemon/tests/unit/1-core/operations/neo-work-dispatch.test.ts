import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  NEO_WORK_ADMISSION_WAKE,
  planNeoAvailabilityWakes,
  runNeoAdmissionWake,
} from '../../../../src/lib/neo/admission-wake.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NEO_WORK_AWAITING_WORKER } from '../../../../src/lib/neo/work-reroute.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const target: NeoDriverTarget = {
  verb: 'start',
  adapter: 'codex-desktop',
  place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' },
};
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const neo: OperationCaller = {
  source: 'mcp',
  sessionId: 'neo:root',
  neoTurn: { messageId: 'm-b', human: false, isLive: () => true },
};

async function setup() {
  const db = await createTestDb();
  db.createSession(createTestSession('neo:root'));
  const starts: string[] = [];
  const operation = (name: string) =>
    defineOperation({
      name,
      description: name,
      inputSchema: z.record(z.string(), z.unknown()),
      resultSchema: z.unknown(),
      execute: async (input) => {
        if (name === 'work.stop') return { ok: true, value: { stopped: true } };
        starts.push(String(input.message ?? input.instruction ?? name));
        return { ok: true, value: { ref: { adapter: 'codex-desktop', id: `t${starts.length}` } } };
      },
    });
  const registry = createOperationRegistry(['work.start', 'work.stop'].map(operation));
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  const deliver = mock(async () => {});
  Object.assign(service, { returnReport: async () => {}, deliver });
  service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
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
      target
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
  const start = (id: string, dependsOn?: string[], caller = human) =>
    invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.work.start',
      { id, ...(dependsOn ? { dependsOn } : {}) },
      caller
    );
  const answer = (id: string) => {
    const item = service.askRecords.get(`ask-${id}`)!.doneItems![0];
    service.askRecords.tickItem(
      `ask-${id}`,
      { ...item, state: 'met', evidence: 'The human answered: merged', metBy: 'human' },
      Date.now(),
      item,
      true
    );
  };
  const drain = async () => {
    for (const job of db.getJobQueueRepo().dequeue(NEO_WORK_ADMISSION_WAKE, 10))
      await runNeoAdmissionWake(job, service);
  };
  return { db, service, starts, start, answer, drain, deliver };
}

describe('neo.work.start with dependsOn', () => {
  test('an approved chain progresses from verified outcomes with Neo idle', async () => {
    const { db, service, starts, start, answer, drain, deliver } = await setup();
    try {
      db.updateGlobalSettings({ neo: { autoDispatch: true } });
      expect(await start('b', ['a'])).toMatchObject({
        value: {
          ok: false,
          reason: 'prerequisites_unmet',
          blockers: [{ workId: 'a', reason: 'outcomes_unverified', itemIds: ['i1'] }],
        },
      });
      expect(await start('c', ['b'])).toMatchObject({
        value: { ok: false, reason: 'prerequisites_unmet' },
      });
      expect(await start('a')).toMatchObject({ value: { ok: true, work: { status: 'queued' } } });
      expect(starts).toHaveLength(1);
      answer('a');
      await drain();
      expect(service.repo.getWork('b')?.status).toBe('queued');
      expect(service.repo.getWork('c')?.status).toBe('proposed');
      answer('b');
      await drain();
      expect(service.repo.getWork('c')?.status).toBe('queued');
      expect(starts).toHaveLength(3);
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  test('an invalid graph is refused with a typed reason and changes nothing', async () => {
    const { db, service, starts, start } = await setup();
    try {
      expect(await start('b', ['a'])).toMatchObject({ value: { reason: 'prerequisites_unmet' } });
      expect(await start('a', ['b'])).toMatchObject({
        value: { ok: false, reason: 'dependency_cycle' },
      });
      expect(await start('a', ['a'])).toMatchObject({
        value: { ok: false, reason: 'self_dependency' },
      });
      expect(await start('a', ['missing'])).toMatchObject({
        value: { ok: false, reason: 'dependency_not_visible' },
      });
      expect(service.dependencies.edges()).toEqual([{ workId: 'b', prerequisiteId: 'a' }]);
      expect(starts).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("Neo's own dependency edit voids the approval it would start under", async () => {
    const { db, service, starts, start } = await setup();
    try {
      service.askRecords.approve('ask-b', Date.now(), service.askRecords.get('ask-b')!.revision!);
      expect(await start('b', ['a'], neo)).toMatchObject({
        value: { ok: false, reason: 'not_approved' },
      });
      expect(service.askRecords.get('ask-b')?.approvedAt ?? null).toBeNull();
      expect(service.dependencies.hasStartIntent('b')).toBe(false);
      expect(starts).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('a blocked start keeps its intent for a card with no driver target row', async () => {
    const { db, service } = await setup();
    try {
      service.repo.proposeWork({
        id: 'd',
        requestKey: 'neo:root:d',
        projectId: null,
        originSessionId: 'neo:root',
        title: 'Card d',
        instruction: 'Do d.',
      });
      service.askRecords.open(
        {
          id: 'ask-d',
          requestKey: 'ask-d',
          projectId: null,
          originSessionId: 'neo:root',
          originMessageId: 'm-d',
          title: 'd',
          ask: 'd',
          doneWhen: 'd',
          doneSource: 'human',
        },
        [{ text: 'Outcome d', check: null, deliveredBy: 'd' }]
      );
      expect(service.editDependencies('d', ['a'])).toMatchObject({ ok: true });
      expect(await service.admitWork('d', true)).toMatchObject({ reason: 'prerequisites_unmet' });
      expect(service.dependencies.hasStartIntent('d')).toBe(true);
      expect(service.editDependencies('d', [])).toMatchObject({ ok: true });
      expect(service.dependencies.hasStartIntent('d')).toBe(false);
    } finally {
      db.close();
    }
  });

  test('a card already handed off and waiting for a worker cannot gain dependencies', async () => {
    const { db, service } = await setup();
    try {
      service.repo.transitionWork('b', service.repo.getWork('b')!, {
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
      expect(service.editDependencies('b', ['a'])).toEqual({
        ok: false,
        reason: 'dependency_already_dispatched',
      });
      expect(service.dependencies.edges()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('recovery queues a wake for every card that has prerequisites', async () => {
    const { db, service, start } = await setup();
    try {
      await start('b', ['a']);
      await service.recover();
      expect(
        db
          .getJobQueueRepo()
          .listActiveByPayload(NEO_WORK_ADMISSION_WAKE, { workId: 'b' }, ['pending'])
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('planNeoAvailabilityWakes', () => {
  const card = (
    id: string,
    projectId: string | null,
    report: string | null = NEO_WORK_AWAITING_WORKER
  ) => ({ id, projectId, status: 'proposed', report }) as never;

  test('wakes only unblocked cards waiting for a worker in the settled card’s project', () => {
    const work = [
      card('waiting', 'p1'),
      card('blocked', 'p1'),
      card('elsewhere', 'p2'),
      card('proposed', 'p1', null),
      card('settled', 'p1'),
    ];
    expect(
      planNeoAvailabilityWakes({ id: 'settled', projectId: 'p1' }, work, (id) => id === 'blocked')
    ).toEqual(['waiting']);
  });
});

describe('availability trigger', () => {
  const settle = async (autoDispatch: boolean) => {
    const context = await setup();
    const { db, service, start } = context;
    db.updateGlobalSettings({ neo: { autoDispatch } });
    await start('a');
    service.repo.transitionWork('b', service.repo.getWork('b')!, {
      status: 'proposed',
      report: NEO_WORK_AWAITING_WORKER,
    });
    const queued = service.repo.getWork('a')!;
    expect(queued.status).toBe('queued');
    service.repo.transitionWork('a', queued, { status: 'reported', report: 'Done.' });
    return context;
  };

  test('a card that settles wakes a card waiting for a worker, which starts with auto-dispatch on', async () => {
    const { db, service, starts, drain } = await settle(true);
    try {
      expect(
        db
          .getJobQueueRepo()
          .listActiveByPayload(NEO_WORK_ADMISSION_WAKE, { workId: 'b' }, ['pending'])
      ).toHaveLength(1);
      await drain();
      expect(starts.map((message) => message.split('\n')[0])).toEqual(['Do a.', 'Do b.']);
      expect(service.repo.getWork('b')?.status).toBe('queued');
    } finally {
      db.close();
    }
  });

  test('with auto-dispatch off the wake changes nothing', async () => {
    const { db, service, starts, drain } = await settle(false);
    try {
      await drain();
      expect(starts.map((message) => message.split('\n')[0])).toEqual(['Do a.']);
      expect(service.repo.getWork('b')).toMatchObject({
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
    } finally {
      db.close();
    }
  });
});
