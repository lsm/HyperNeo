import { expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations.ts';
import type { WorkAdapter } from '../../../../src/lib/drivers/types.ts';
import { createNeoQuestionAnswerDelivery } from '../../../../src/lib/neo/question-answer-delivery.ts';
import { createNeoWorkerQuestionWriter } from '../../../../src/lib/neo/question-operations.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const ref = { adapter: 'hyperneo', id: 'worker' };

test('a HyperNeo worker holding two todos reports an answered turn only to that answer', async () => {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  new JobQueueRepository(db).commitSubmissionReceipt('neo-turn-report:v2:cutoff', 'v2', () => 0);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const at = Date.now() - 10_000;
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Shared worker',
    request: 'Two todos on one worker',
    createdAt: at,
  });
  for (const id of ['answered', 'other']) {
    const todo = store.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Done', instruction: `Do ${id}`, check: null, named: null },
      at
    );
    sessions.create(id, { verb: 'send', ref });
    sessions.recordRef(id, ref, at);
    store.updateTodo(todo, { state: 'doing', startedAt: at }, at);
  }
  const source = { ...ref, name: 'Worker', label: 'Worker', provider: 'Synthetic', link: null };
  const asked = await createNeoWorkerQuestionWriter(
    store,
    sessions,
    () => 'en',
    async () => source
  )(source, {
    todoId: 'answered',
    kind: 'blocked',
    title: 'Which destination?',
    options: ['Staging', 'Production'],
    language: 'en',
    report: 'Need a destination',
  });
  if (!asked.ok) throw new Error(asked.reason);
  store.answerQuestion(asked.question, ['Staging'], 'button', at + 1);
  const last = await sessions.inputs.accept('other', 'neo', { verb: 'send', ref }, 'Other', at + 2);
  await sessions.inputs.recordOutcome(last, { ref }, at + 2);

  const adapter = {
    id: 'hyperneo',
    capabilities: ['send'],
    send: async () => ({
      ok: true,
      value: { delivered: true, receipt: { executionId: ref.id, inputId: 'answer-input' } },
    }),
  } as unknown as WorkAdapter;
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'fixture',
      workInputs: {
        accept: (todoId: string | null, from: string, target: never, message: string) =>
          sessions.inputs.accept(todoId, from, target, message, Date.now()),
        recordOutcome: (id: string) => sessions.inputs.recordOutcome(id, { ref }, Date.now()),
        recordFailure: async () => {},
      },
    } as never)
  );
  const turnAt = Date.now() + 1_000;
  const invoke: Parameters<typeof createNeoTodoRunner>[0]['invoke'] = async (
    caller,
    name,
    input
  ) =>
    name === 'work.status'
      ? {
          kind: 'completed',
          value: {
            ok: true,
            value: {
              ref,
              status: 'done',
              lastActivityAt: turnAt,
              turnEnds: [
                {
                  id: 'answer-turn',
                  startedAt: turnAt - 100,
                  at: turnAt,
                  message: 'Used staging.',
                },
              ],
            },
          },
        }
      : invokeOperation(registry, name, input, caller);
  const reported: string[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 9, perGroup: 9 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke,
    packs: () => [],
    tell: async (_ask, todo, note) => {
      if (note.startsWith('Worker turn report')) reported.push(todo.id);
    },
    changed: () => {},
  });
  const deliver = createNeoQuestionAnswerDelivery(
    store,
    sessions,
    invoke,
    async () => {},
    runner.recompute,
    (error) => {
      throw error;
    }
  );
  try {
    await deliver(asked.question.id);
    await runner.refresh((_message, error) => {
      throw error;
    });
    expect(sessions.inputs.list('answered').at(-1)?.message).toContain('Staging');
    expect(reported).toEqual(['answered']);
  } finally {
    db.close();
  }
});
