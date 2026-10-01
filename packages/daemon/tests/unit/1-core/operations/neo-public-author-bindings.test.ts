import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { Database } from '../../../../src/storage/database.ts';
import { Database as SqliteDatabase } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;

describe('durable public author snapshot bindings', () => {
  test('covers 500 retained publications beyond the bounded consultation display and transports scoped bindings', async () => {
    const db = new Database(':memory:', { messageSearchIndexFlushIntervalMs: 0 });
    await db.initialize(createReactiveDatabase(db));
    const createSession = mock(async () => {
      throw new Error('No SDK execution');
    });
    const service = new NeoService(
      db,
      { createSession } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      service.repo.reserveBinding({ sessionId: root, concernId: null, kind: 'neo' });
      for (let index = 0; index < 21; index++) {
        const id = `context-${index}`;
        service.repo.saveConcern({ id, title: `Context ${index}`, summary: id, context: id }, 0);
        service.repo.reserveBinding({
          sessionId: `holder-${index}`,
          concernId: id,
          kind: 'concern',
        });
        const consultation = service.consultations.reserve({
          id: `consult-${index}`,
          requestKey: `request-${index}`,
          concernId: id,
          originSessionId: root,
          originMessageId: `ask-${index}`,
          sessionId: `holder-${index}`,
          question: 'Fictional comparison',
        });
        expect(consultation).not.toBeNull();
        if (index === 0)
          service.consultations.finish(consultation!.id, 'reported', 'Authored answer');
      }
      service.repo.reserveBinding({ sessionId: 'worker', concernId: 'context-0', kind: 'worker' });
      for (let index = 0; index < 500; index++) {
        expect(
          service.publications.append({
            conversationId,
            publicationId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            askOrigin: { sessionId: root, messageId: `ask-${index}` },
            producerInput: { sessionId: `holder-${index % 21}`, messageId: `input-${index}` },
            shortText: 'Authored answer',
            fullText: 'Authored complete answer',
            links: [],
          }).accepted
        ).toBe(true);
      }
      const operation = createNeoOperations(service).find((entry) => entry.name === 'neo.snapshot');
      if (!operation) throw new Error('Snapshot operation missing');
      const result = operation.resultSchema.parse(
        await operation.execute({}, { source: 'rpc', principal: 'local' })
      ) as NeoSnapshot;
      expect(result.consultations).toHaveLength(20);
      expect(result.consultations?.some((row) => row.sessionId === 'holder-0')).toBe(false);
      expect(result.publicAuthorBindings).toHaveLength(21);
      expect(result.publicAuthorBindings).toContainEqual({
        sessionId: 'holder-0',
        concernId: 'context-0',
        kind: 'concern',
      });
      expect(
        result.publicAuthorBindings?.some(
          (row) => row.sessionId === 'worker' || row.sessionId === root
        )
      ).toBe(false);
      const bindings = new Map(
        result.publicAuthorBindings?.map((row) => [row.sessionId, row.concernId])
      );
      const retained = Array.from(
        { length: 5 },
        (_, page) => service.publications.list(conversationId, page * 100, 100)!
      ).flat();
      expect(retained).toHaveLength(500);
      for (const row of retained) expect(bindings.has(row.producerInput.sessionId)).toBe(true);
      const scoped = operation.resultSchema.parse(
        await operation.execute({ concernId: 'context-0' }, { source: 'rpc', principal: 'local' })
      ) as NeoSnapshot;
      expect(scoped.publicAuthorBindings).toEqual([
        { sessionId: 'holder-0', concernId: 'context-0', kind: 'concern' },
      ]);
      const agent = operation.resultSchema.parse(
        await operation.execute({}, { source: 'mcp', principal: 'local', sessionId: 'holder-0' })
      ) as NeoSnapshot;
      expect(agent.publicAuthorBindings).toEqual([]);
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('reads stable holder bindings after SQLite reopen without notifications or session lifetime coupling', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-author-bindings-'));
    const path = join(directory, 'fixture.db');
    const notify = mock(() => {});
    let db = new SqliteDatabase(path);
    try {
      createNeoTables(db);
      const repo = new NeoRepository(db, notify);
      for (const id of ['A', 'B']) {
        repo.saveConcern({ id, title: id, summary: id, context: id }, 0);
        repo.reserveBinding({ sessionId: `holder-${id}`, concernId: id, kind: 'concern' });
      }
      repo.reserveBinding({ sessionId: 'root', concernId: null, kind: 'neo' });
      repo.reserveBinding({ sessionId: 'worker', concernId: 'A', kind: 'worker' });
      const expected = repo.listConcernBindings();
      expect(expected).toHaveLength(2);
      db.close();
      db = new SqliteDatabase(path);
      const reopened = new NeoRepository(db, notify);
      notify.mockClear();
      expect(reopened.listConcernBindings()).toEqual(expected);
      expect(reopened.listConcernBindings('A')).toEqual([expected[0]]);
      expect(reopened.listConcernBindings('missing')).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
