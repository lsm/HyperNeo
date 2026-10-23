import { expect, test } from 'bun:test';
import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service.ts';
import {
  SESSION_EVENT_SCOPE,
  SessionExternalEventStore,
} from '../../../../src/lib/external-events/session-external-event-store.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

test('NeoService rechecks raw CI facts without sending a second PR message', async () => {
  const db = await createTestDb();
  const delivered: { ref: unknown; message: string }[] = [];
  const registry = createOperationRegistry([
    defineOperation({
      name: 'work.send',
      description: 'Deliver to the test worker',
      inputSchema: z.object({ ref: z.unknown(), message: z.string() }),
      resultSchema: z.unknown(),
      policy: { safetyClass: 'mutate' },
      execute: async (input) => {
        delivered.push(input);
        return { ok: true, value: { delivered: true } };
      },
    }),
  ]);
  const bus = new InternalEventBus<DaemonInternalEventMap>();
  const service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: () => {} } as unknown as MessageHub,
    bus
  );
  try {
    db.createSession(createTestSession('owner'));
    const url = 'https://github.com/lsm/HyperNeo/pull/7374';
    service.todos.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'owner',
      originMessageId: null,
      title: 'Fix CI',
      request: 'Fix CI and merge',
      createdAt: 1,
    });
    const todo = service.todos.addTodo(
      'todo',
      'ask',
      {
        title: 'Fix CI',
        instruction: 'Fix CI',
        doneWhen: 'PR merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } },
        named: null,
      },
      1
    );
    service.todos.updateTodo(todo, { state: 'doing', report: `Opened ${url}` }, 2);
    const ref = { adapter: 'codex', id: 'worker-thread' };
    service.todoSessions.create(todo.id, { verb: 'send', ref });
    service.todoSessions.recordRef(todo.id, ref, 2);
    const evidence = new CodingTodoPrRepository(db.getDatabase());
    evidence.claim(todo.id, [{ url, claim: 'named' }], 2);
    evidence.record(todo.id, [{ url, state: 'OPEN', checks: 'failing', review: 'none' }], 2);
    let reads = 0;
    service.readPrs = async () => {
      reads++;
      return evidence.prs(todo.id);
    };
    service.followCardTopics(todo.id);
    const events = new ExternalEventService(new SessionExternalEventStore(db.getDatabase()), bus);
    await events.publish({
      id: 'failed-ci',
      spaceId: SESSION_EVENT_SCOPE,
      source: 'github',
      topic: 'github/lsm/HyperNeo/pull_request/7374.check_failed',
      dedupeKey: 'failed-ci',
      occurredAt: Date.now(),
      ingestedAt: Date.now(),
      summary: 'Web Tests failed',
      payload: { prUrl: url, prNumber: 7374, checkName: 'Web Tests', conclusion: 'failure' },
    });
    expect(reads).toBeGreaterThan(0);
    expect(delivered).toEqual([]);
  } finally {
    service.dispose();
    db.close();
  }
});
