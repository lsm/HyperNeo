import { expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { z } from 'zod';
import { createTestDb } from '../../../helpers/database.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { WorkRefSchema, WorkSummarySchema } from '../../../../src/lib/drivers/types.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';

async function setup() {
  const db = await createTestDb();
  const ref = { adapter: 'hyperneo', id: 'worker' };
  const registry = createOperationRegistry([
    defineOperation({
      name: 'work.status',
      description: 'Synthetic worker',
      inputSchema: z.object({ ref: WorkRefSchema }),
      resultSchema: z.object({ ok: z.literal(true), value: WorkSummarySchema }),
      policy: { safetyClass: 'read' },
      execute: async () => ({
        ok: true as const,
        value: {
          ref,
          title: 'Quiet worker',
          place: { machine: 'test', name: 'Test' },
          status: 'stopped',
          lastActivityAt: 1,
        },
      }),
    }),
  ]);
  const service = createNeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.repo.reserveBinding({ sessionId: 'neo', projectId: null, kind: 'neo' });
  service.todos.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Plan',
    request: 'Plan',
    createdAt: 1,
  });
  const todo = service.todos.addTodo(
    'todo',
    'ask',
    { title: 'Build', doneWhen: 'Done', instruction: 'Stay quiet', check: null, named: null },
    1
  );
  service.todoSessions.bind(todo.id, ref, 2);
  service.todos.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  const operation = () =>
    createSendMessageOperation(
      db.getJobQueueRepo(),
      () => 'active',
      undefined,
      undefined,
      undefined,
      undefined,
      (id) => id === 'neo',
      (...args) => service.handleWorkerQuestion(...args)
    );
  const send = (input: unknown, sender = 'worker') =>
    invokeOperation(createOperationRegistry([operation()]), 'message.send', input, {
      source: 'mcp',
      sessionId: sender,
    });
  return { db, service, send };
}

const input = {
  to: 'neo',
  kind: 'blocked',
  text: 'Original blocker report',
  question: {
    todoId: 'todo',
    title: 'Choose a destination',
    options: ['Staging', 'Production'],
    language: 'en',
  },
};

test('quiet worker blockers immediately create a held card with one durable wake across repeats and operation reconstruction', async () => {
  const { db, service, send } = await setup();
  try {
    const first = await send(input);
    expect(first).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(service.todos.listQuestions('ask')).toHaveLength(1);
    expect(service.todos.getTodo('todo')).toMatchObject({
      state: 'blocked',
      blockedBy: 'needs-human',
    });
    const repeats = await Promise.all(
      Array.from({ length: 8 }, () => send({ ...input, text: 'Repeated blocker' }))
    );
    expect(
      repeats.every(
        (r) =>
          r.kind === 'completed' &&
          JSON.stringify(r.value) ===
            JSON.stringify(first.kind === 'completed' ? first.value : null)
      )
    ).toBe(true);
    expect(service.todos.listQuestions('ask')).toHaveLength(1);
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
  }
});

test('a worker cannot place a hold or create a card for another assigned worker', async () => {
  const { db, service, send } = await setup();
  try {
    expect(await send(input, 'stranger')).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected' },
    });
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    expect(service.todos.getTodo('todo')?.state).toBe('doing');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(0);
  } finally {
    service.dispose();
    db.close();
  }
});
