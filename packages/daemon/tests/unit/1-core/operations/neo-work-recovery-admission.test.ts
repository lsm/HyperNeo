import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { NEO_WORK_AWAITING_WORKER } from '../../../../src/lib/neo/work-reroute.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const target: NeoDriverTarget = {
  verb: 'start',
  adapter: 'codex-desktop',
  place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' },
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
        starts.push(name);
        return { ok: true, value: { ref: { adapter: 'codex-desktop', id: `t${starts.length}` } } };
      },
    });
  const registry = createOperationRegistry(
    ['work.start', 'work.send', 'work.stop', 'work.find'].map(operation)
  );
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  Object.assign(service, { returnReport: async () => {}, deliver: async () => {} });
  service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
  for (const id of ['a', 'b', 'c'])
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
  const open = (id: string, cards: string[]) =>
    service.askRecords.open(
      {
        id,
        requestKey: id,
        projectId: null,
        originSessionId: 'neo:root',
        originMessageId: `m-${id}`,
        title: id,
        ask: id,
        doneWhen: id,
        doneSource: 'human',
      },
      cards.map((card) => ({ text: `Outcome ${card}`, check: null, deliveredBy: card }))
    );
  open('ask-a', ['a']);
  open('ask-bc', ['b', 'c']);
  const edit = service.dependencies.replace(
    {
      workId: 'b',
      dependsOn: ['a'],
      expectedRevision: service.askRecords.get('ask-bc')!.revision!,
    },
    new Set(['a', 'b', 'c']),
    Date.now()
  );
  if (!edit.ok) throw new Error(edit.reason);
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
  const approve = () =>
    invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.ask.approve',
      { askId: 'ask-bc', expectedRevision: edit.revision },
      { source: 'rpc', principal: 'local' }
    );
  return { db, service, starts, answer, approve };
}

describe('NeoService.admitWork on the remaining start paths', () => {
  test('approval starts the independent card and leaves the blocked dependent proposed', async () => {
    const { db, service, starts, approve } = await setup();
    try {
      expect(await approve()).toMatchObject({ value: { ok: true } });
      expect(starts).toHaveLength(1);
      expect(service.repo.getWork('c')?.status).toBe('queued');
      expect(service.repo.getWork('b')?.status).toBe('proposed');
      expect(service.driverTargets.readCard('b')?.claimedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  test('a retry is refused while a prerequisite is unverified and starts once it is answered', async () => {
    const { db, service, starts, answer } = await setup();
    try {
      const failed = service.repo.transitionWork('b', service.repo.getWork('b')!, {
        status: 'failed',
        report: 'Could not start the execution: logged out',
      })!;
      expect(await service.retryWork(failed)).toEqual({
        ok: false,
        reason: 'prerequisites_unmet',
      });
      expect(starts).toHaveLength(0);
      expect(service.repo.getWork('b')?.status).toBe('proposed');
      answer();
      expect(await service.retryWork(service.repo.getWork('b')!)).toMatchObject({
        ok: true,
        work: { id: 'b', status: 'queued' },
      });
      expect(starts).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('recovery does not hand a blocked or cancelled card waiting for a worker to a driver', async () => {
    const { db, service, starts } = await setup();
    try {
      for (const id of ['b', 'c'])
        service.repo.transitionWork(id, service.repo.getWork(id)!, {
          status: 'proposed',
          report: NEO_WORK_AWAITING_WORKER,
        });
      await service.cancel('c');
      await service.recover();
      expect(starts).toHaveLength(0);
      expect(service.repo.getWork('b')).toMatchObject({
        status: 'proposed',
        report: NEO_WORK_AWAITING_WORKER,
      });
      expect(service.repo.getWork('c')?.status).toBe('cancelled');
    } finally {
      db.close();
    }
  });
});
