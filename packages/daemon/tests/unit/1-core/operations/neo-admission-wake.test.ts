import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
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
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const target: NeoDriverTarget = {
  verb: 'start',
  adapter: 'codex-desktop',
  place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' },
};

async function setup() {
  const db = await createTestDb();
  const starts: string[] = [];
  const operation = (name: string) =>
    defineOperation({
      name,
      description: name,
      inputSchema: z.record(z.string(), z.unknown()),
      resultSchema: z.unknown(),
      execute: async () => {
        if (name === 'work.stop') return { ok: true, value: { stopped: true } };
        starts.push(name);
        return { ok: true, value: { ref: { adapter: 'codex-desktop', id: 't1' } } };
      },
    });
  const registry = createOperationRegistry(['work.start', 'work.stop'].map(operation));
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  for (const id of ['a', 'b']) {
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
  const edit = service.dependencies.replace(
    { workId: 'b', dependsOn: ['a'], expectedRevision: service.askRecords.get('ask-b')!.revision! },
    new Set(['a', 'b']),
    Date.now()
  );
  service.askRecords.approve('ask-b', Date.now(), edit.revision);
  const tick = (metBy: NeoAskItem['metBy'], verify: boolean) => {
    const item = service.askRecords.get('ask-a')!.doneItems![0];
    return service.askRecords.tickItem(
      'ask-a',
      { ...item, state: 'met', evidence: 'done', metBy },
      Date.now(),
      item,
      verify
    );
  };
  const wakes = () =>
    new JobQueueRepository(db.getDatabase()).listActiveByPayload(
      NEO_WORK_ADMISSION_WAKE,
      { workId: 'b' },
      ['pending']
    );
  const autoDispatch = (on: boolean) => db.updateGlobalSettings({ neo: { autoDispatch: on } });
  return { db, service, starts, tick, wakes, autoDispatch };
}

describe('NeoAskRepository.tickItem', () => {
  test('a verified outcome durably queues one wake for its dependent; a self-attested one none', async () => {
    const { db, tick, wakes } = await setup();
    try {
      expect(tick('neo', false)).toBe(true);
      expect(wakes()).toHaveLength(0);
      expect(tick('human', true)).toBe(true);
      expect(tick('human', true)).toBe(true);
      expect(wakes()).toEqual([
        expect.objectContaining({ queue: NEO_WORK_ADMISSION_WAKE, payload: { workId: 'b' } }),
      ]);
    } finally {
      db.close();
    }
  });
});

describe('runNeoAdmissionWake', () => {
  test('a wake starts the approved dependent once, and only with automatic dispatch on', async () => {
    const { db, service, starts, tick, wakes, autoDispatch } = await setup();
    try {
      tick('human', true);
      const [job] = wakes();
      expect(await runNeoAdmissionWake(job, service)).toEqual({
        admitted: false,
        reason: 'auto_dispatch_off',
      });
      expect(starts).toHaveLength(0);
      autoDispatch(true);
      expect(await runNeoAdmissionWake(job, service)).toEqual({ admitted: true });
      expect(await runNeoAdmissionWake(job, service)).toEqual({
        admitted: false,
        reason: 'card_not_waiting',
      });
      expect(starts).toHaveLength(1);
      expect(service.repo.getWork('b')?.status).toBe('queued');
    } finally {
      db.close();
    }
  });

  test('a wake never dispatches a cancelled, stale or still-blocked dependent', async () => {
    const { db, service, starts, tick, wakes, autoDispatch } = await setup();
    try {
      autoDispatch(true);
      tick('neo', false);
      expect(wakes()).toHaveLength(0);
      const job = { queue: NEO_WORK_ADMISSION_WAKE, payload: { workId: 'b' } } as never;
      expect(await runNeoAdmissionWake(job, service)).toEqual({
        admitted: false,
        reason: 'prerequisites_unmet',
      });
      tick('human', true);
      db.getDatabase()
        .prepare("UPDATE neo_asks SET revision = revision + 1 WHERE id = 'ask-b'")
        .run();
      expect(await runNeoAdmissionWake(job, service)).toEqual({
        admitted: false,
        reason: 'approval_stale',
      });
      await service.cancel('b');
      expect(await runNeoAdmissionWake(job, service)).toEqual({
        admitted: false,
        reason: 'card_not_waiting',
      });
      expect(starts).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
