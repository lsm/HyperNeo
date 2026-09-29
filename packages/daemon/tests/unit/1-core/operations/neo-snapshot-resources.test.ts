import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { Database } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';

describe('Neo snapshot resource consumer', () => {
  test('serializes only visible concern receipts through the merged storage API', async () => {
    const db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    const createSession = mock(async () => {
      throw new Error('No execution');
    });
    const service = new NeoService(
      db,
      { createSession } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      for (const id of ['A', 'B']) {
        service.repo.saveConcern({ id, title: id, summary: id, context: id }, 0);
        const proposed = service.repo.proposeWork({
          id,
          requestKey: id,
          concernId: id,
          originSessionId: 'root',
          originMessageId: `ask-${id}`,
          title: id,
          instruction: 'Draft only',
          targetSessionId: 'manager',
        });
        const pending = service.repo.transitionWork(id, proposed, {
          status: 'queued',
          sessionId: 'manager',
        });
        if (!pending) throw new Error('Missing queued fixture');
        expect(
          db.neoWorkResources.settle(pending, { id, status: 'reported', report: 'Claim only' }, [
            { kind: 'task', id: `draft-${id}` },
          ])
        ).not.toBeNull();
      }
      const operation = createNeoOperations(service).find((entry) => entry.name === 'neo.snapshot');
      if (!operation) throw new Error('Snapshot operation missing');
      const result = (await operation.execute(
        { concernId: 'A' },
        { source: 'rpc', principal: 'local' }
      )) as NeoSnapshot;
      expect(result.work.map((row) => row.id)).toEqual(['A']);
      expect(result.workResources).toEqual([
        { workId: 'A', refs: [{ kind: 'task', id: 'draft-A' }] },
      ]);
      expect(operation.resultSchema.parse(result)).toMatchObject({
        workResources: result.workResources,
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(db.neoWorkResources.get('B')).toEqual([{ kind: 'task', id: 'draft-B' }]);
    } finally {
      service.dispose();
      db.close();
    }
  });
  test('legacy unknown and explicitly empty stored reports remain distinct', async () => {
    const db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    const service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      for (const id of ['unknown', 'empty']) {
        const proposed = service.repo.proposeWork({
          id,
          requestKey: id,
          concernId: null,
          originSessionId: 'root',
          originMessageId: null,
          title: id,
          instruction: 'Draft only',
        });
        const pending = service.repo.transitionWork(id, proposed, {
          status: 'queued',
          sessionId: 'manager',
        });
        if (!pending) throw new Error('Missing queued fixture');
        if (id === 'empty')
          db.neoWorkResources.settle(pending, { id, status: 'reported', report: id }, []);
        else service.repo.transitionWork(id, pending, { status: 'reported', report: id });
      }
      const operation = createNeoOperations(service).find((entry) => entry.name === 'neo.snapshot');
      if (!operation) throw new Error('Snapshot operation missing');
      const result = (await operation.execute(
        {},
        { source: 'rpc', principal: 'local' }
      )) as NeoSnapshot;
      expect(result.workResources?.find((row) => row.workId === 'unknown')?.refs).toBeNull();
      expect(result.workResources?.find((row) => row.workId === 'empty')?.refs).toEqual([]);
    } finally {
      service.dispose();
      db.close();
    }
  });
});
