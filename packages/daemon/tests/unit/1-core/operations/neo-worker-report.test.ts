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
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';

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

test('an old open card is reused and a failed wake rolls the new card and hold back', async () => {
  const { db, service, send } = await setup();
  try {
    db.getDatabase().exec(
      "CREATE TRIGGER fail_wake BEFORE INSERT ON message_send_receipts BEGIN SELECT RAISE(ABORT, 'wake failed'); END"
    );
    const failed = await send(input);
    expect(failed.kind).not.toBe('completed');
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    expect(service.todos.getTodo('todo')?.state).toBe('doing');
    db.getDatabase().exec('DROP TRIGGER fail_wake');
    const old = service.todos.askQuestion(
      'old-card',
      'ask',
      {
        todoId: 'todo',
        text: 'Old question',
        kind: 'choice',
        options: ['One', 'Two'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      1
    );
    expect(await send(input)).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(service.todos.listQuestions('ask').map((q) => q.id)).toEqual([old.id]);
    expect(service.todos.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
  }
});

test('a hold arriving during the runner status lookup prevents a stale reminder', async () => {
  const { db, service } = await setup();
  const sends: string[] = [];
  try {
    const ref = { adapter: 'hyperneo', id: 'worker' };
    db.getDatabase()
      .prepare('UPDATE neo_todo_sessions SET target = ? WHERE todo_id = ?')
      .run(
        JSON.stringify({
          verb: 'start',
          adapter: 'hyperneo',
          place: { machine: 'test', name: 'Test' },
        }),
        'todo'
      );
    const runner = createNeoTodoRunner({
      store: service.todos,
      sessions: service.todoSessions,
      packs: () => [],
      changed: () => {},
      invoke: async (_caller, name, args) => {
        if (name === 'work.send') sends.push(name);
        if (name === 'work.status' && !('since' in args))
          service.todos.updateTodo(
            service.todos.getTodo('todo')!,
            {
              state: 'blocked',
              blockedBy: 'needs-human',
              blockedReason: 'Choose',
              nextAction: 'Answer',
            },
            Date.now()
          );
        return {
          kind: 'completed',
          value: {
            ok: true,
            value: {
              ref,
              title: 'Worker',
              place: { machine: 'test', name: 'Test' },
              status: 'since' in args ? 'running' : 'stopped',
              lastActivityAt: Date.now() - 25 * 60_000,
            },
          },
        };
      },
      tell: async () => {
        sends.push('tell');
      },
    });
    await runner.refresh((message, error) => {
      throw new Error(`${message}: ${error}`);
    });
    expect(service.todos.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(sends).toEqual([]);
  } finally {
    service.dispose();
    db.close();
  }
});

test('legacy ambiguous blockers wake triage once and malformed card reports have no effects', async () => {
  const { db, service, send } = await setup();
  try {
    expect(
      await send({ ...input, question: { ...input.question, options: ['Only'] } })
    ).toMatchObject({ kind: 'completed', value: { kind: 'rejected' } });
    expect(service.todos.listQuestions('ask')).toHaveLength(0);
    const { question: _question, ...legacy } = input;
    expect(await send(legacy)).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(await send(legacy)).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    ).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
  }
});
