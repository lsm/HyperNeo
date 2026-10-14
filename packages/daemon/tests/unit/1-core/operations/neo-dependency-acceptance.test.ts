import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  NEO_WORK_ADMISSION_WAKE,
  runNeoAdmissionWake,
} from '../../../../src/lib/neo/admission-wake.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import type { Database } from '../../../../src/storage/database.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const target: NeoDriverTarget = {
  verb: 'start',
  adapter: 'codex-desktop',
  place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' },
};
const human = { source: 'rpc', principal: 'local' } as const;

function boot(db: Database, registry: OperationRegistry) {
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  Object.assign(service, { returnReport: async () => {}, deliver: mock(async () => {}) });
  return service;
}

async function chain() {
  const db = await createTestDb();
  db.createSession(createTestSession('neo:root'));
  const starts: string[] = [];
  const registry = createOperationRegistry(
    ['work.start', 'work.stop'].map((name) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.record(z.string(), z.unknown()),
        resultSchema: z.unknown(),
        execute: async (input) => {
          if (name === 'work.stop') return { ok: true, value: { stopped: true } };
          starts.push(String(input.message ?? ''));
          return {
            ok: true,
            value: { ref: { adapter: 'codex-desktop', id: `t${starts.length}` } },
          };
        },
      })
    )
  );
  let service = boot(db, registry);
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
  const start = (id: string, dependsOn?: string[]) =>
    invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.work.start',
      { id, ...(dependsOn ? { dependsOn } : {}) },
      human
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
  const status = () => ['a', 'b', 'c'].map((id) => service.repo.getWork(id)?.status);
  const plan = async () => {
    await start('b', ['a']);
    await start('c', ['b']);
    await start('a');
  };
  const restart = () => {
    service = boot(db, registry);
    return service;
  };
  return { db, starts, start, answer, drain, status, plan, restart, service: () => service };
}

describe('dependency plans end to end', () => {
  test('a card waiting on two prerequisites starts only when both are met; one prerequisite releases both dependents', async () => {
    const { db, starts, start, answer, drain, status } = await chain();
    try {
      db.updateGlobalSettings({ neo: { autoDispatch: true } });
      expect(await start('c', ['a', 'b'])).toMatchObject({
        value: { ok: false, reason: 'prerequisites_unmet' },
      });
      await start('a');
      await start('b');
      answer('a');
      await drain();
      expect(status()).toEqual(['queued', 'queued', 'proposed']);
      answer('b');
      await drain();
      expect(status()).toEqual(['queued', 'queued', 'queued']);
      expect(starts).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test('two dependents of one prerequisite both start when it is met', async () => {
    const { db, starts, start, answer, drain, status } = await chain();
    try {
      db.updateGlobalSettings({ neo: { autoDispatch: true } });
      await start('b', ['a']);
      await start('c', ['a']);
      await start('a');
      answer('a');
      await drain();
      expect(status()).toEqual(['queued', 'queued', 'queued']);
      expect(starts).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  test('with automatic dispatch off, a met prerequisite waits for an explicit Start', async () => {
    const { db, starts, start, answer, drain, status, plan } = await chain();
    try {
      await plan();
      answer('a');
      await drain();
      expect(status()).toEqual(['queued', 'proposed', 'proposed']);
      expect(starts).toHaveLength(1);
      expect(await start('b')).toMatchObject({ value: { ok: true } });
      expect(await start('c')).toMatchObject({
        value: { ok: false, reason: 'prerequisites_unmet' },
      });
      expect(starts).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('a cancelled prerequisite blocks the rest of the chain, even after its outcome is met', async () => {
    const { db, starts, start, answer, drain, status, plan, service } = await chain();
    try {
      db.updateGlobalSettings({ neo: { autoDispatch: true } });
      await plan();
      await service().cancel('a');
      answer('a');
      await drain();
      expect(status()).toEqual(['cancelled', 'proposed', 'proposed']);
      expect(await start('b')).toMatchObject({
        value: {
          ok: false,
          reason: 'prerequisites_unmet',
          blockers: [{ workId: 'a', reason: 'prerequisite_cancelled' }],
        },
      });
      expect(starts).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('a restart mid-chain reuses the running card and dispatches each next card once', async () => {
    const { db, starts, answer, drain, status, plan, restart } = await chain();
    try {
      db.updateGlobalSettings({ neo: { autoDispatch: true } });
      await plan();
      expect(starts).toHaveLength(1);
      const restarted = restart();
      await Promise.all([restarted.recover(), restarted.recover()]);
      expect(starts).toHaveLength(1);
      expect(status()).toEqual(['queued', 'proposed', 'proposed']);
      answer('a');
      await drain();
      await drain();
      expect(status()).toEqual(['queued', 'queued', 'proposed']);
      expect(starts).toHaveLength(2);
      await restart().recover();
      answer('b');
      await drain();
      expect(status()).toEqual(['queued', 'queued', 'queued']);
      expect(starts).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
