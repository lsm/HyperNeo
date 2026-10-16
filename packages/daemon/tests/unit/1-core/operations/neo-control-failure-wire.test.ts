import { describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import { NeoService } from '../../../../src/lib/neo/service';
import { createNeoOperations } from '../../../../src/lib/neo/operations';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus';
import { createOperationRegistry, defineOperation } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import { createTestDb } from '../../../helpers/database';

const ref = { adapter: 'claude-desktop', id: 'local_one' };
const link = 'claude://claude.ai/epitaxy/local_one';

async function setup(stop: () => unknown) {
  const db = await createTestDb();
  const registry = createOperationRegistry([
    defineOperation({
      name: 'work.stop',
      description: 'stop',
      inputSchema: z.unknown(),
      resultSchema: z.unknown(),
      execute: async () => stop(),
    }),
  ]);
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: () => {} } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  const proposed = service.driverTargets.propose(
    service.repo,
    {
      id: 'w1',
      requestKey: 'w1',
      projectId: null,
      originSessionId: 'neo',
      title: 'Work',
      instruction: 'Work',
    },
    { verb: 'send', ref }
  );
  service.repo.transitionWork('w1', proposed.work, { status: 'queued' });
  service.driverTargets.recordRef('w1', ref, 1);
  return { db, service };
}

describe('Neo execution control failure wiring', () => {
  test.each([
    [{ ok: false, reason: 'unsupported', detail: 'Open Desktop.' }, 'unsupported'],
    [{ ok: false, reason: 'unreachable', detail: 'Channel unavailable.' }, 'unavailable'],
    [{ ok: true, value: { stopped: false } }, 'unavailable'],
    [new Error('transport failed'), 'unavailable'],
  ] as const)('keeps cancellation and records a failed stop (%s)', async (reply, reason) => {
    const { db, service } = await setup(() => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    try {
      expect(await service.close('w1', 'cancelled')).toMatchObject({
        ok: true,
        work: { status: 'cancelled' },
      });
      expect(service.controlFailures.list()).toMatchObject([
        { workId: 'w1', ref, operation: 'stop', reason },
      ]);
      const snapshot = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        {},
        { source: 'rpc', principal: 'local' }
      );
      expect(snapshot).toMatchObject({
        kind: 'completed',
        value: {
          cards: [
            {
              workId: 'w1',
              hidden: false,
              controlFailure: { operation: 'stop', reason },
              open: { link },
            },
          ],
        },
      });
      expect(service.repo.getWork('w1')?.status).toBe('cancelled');
    } finally {
      await service.dispose();
      db.close();
    }
  });

  test('clears an old same-target failure after a confirmed stop', async () => {
    const { db, service } = await setup(() => ({ ok: true, value: { stopped: true } }));
    try {
      service.controlFailures.record({
        workId: 'w1',
        ref,
        operation: 'stop',
        reason: 'unavailable',
        detail: 'old',
        at: 1,
      });
      await service.close('w1', 'cancelled');
      expect(service.controlFailures.list()).toEqual([]);
      expect(service.repo.getWork('w1')?.status).toBe('cancelled');
    } finally {
      await service.dispose();
      db.close();
    }
  });

  test('does not project an old-target control failure after rerouting', async () => {
    const { db, service } = await setup(() => ({
      ok: false,
      reason: 'unsupported',
      detail: 'Open Desktop.',
    }));
    try {
      await service.close('w1', 'cancelled');
      expect(service.cardControlFailures(['w1'])).toHaveLength(1);
      service.driverTargets.recordRef('w1', { ...ref, id: 'replacement' });
      expect(service.cardControlFailures(['w1'])).toEqual([]);
      expect(service.controlFailures.list()).toHaveLength(1);
    } finally {
      await service.dispose();
      db.close();
    }
  });
});
