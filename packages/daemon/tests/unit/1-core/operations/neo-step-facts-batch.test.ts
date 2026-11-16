import { afterEach, expect, test } from 'bun:test';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';
import { observeNeoSnapshotQueries } from '../../../helpers/neo-snapshot-fixture.ts';

let close = () => {};
afterEach(() => close());

async function stepFactReads(askCount: number) {
  const db = await createTestDb();
  close = () => db.close();
  const raw = db.getDatabase();
  const store = new NeoAskTodoRepository(raw);
  const sessions = new NeoTodoSessionRepository(raw);
  for (let i = 0; i < askCount; i++) {
    const parent = i % 3 === 2 ? `ask-${i - 1}` : null;
    store.openAsk({
      id: `ask-${i}`,
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      title: `Ask ${i}`,
      request: 'Request',
      createdAt: i,
      ...(parent ? { parentId: parent } : {}),
    });
    for (const [n, instruction] of ['Build it', null].entries()) {
      const todo = store.addTodo(
        `todo-${i}-${n}`,
        `ask-${i}`,
        {
          approvedAt: 1,
          title: `Todo ${i}-${n}`,
          doneWhen: 'Done',
          instruction,
          check: null,
          named: null,
          dependsOn: n ? [`todo-${i}-0`] : [],
        },
        i
      );
      if (!n) {
        sessions.bind(todo.id, { adapter: 'hyperneo', id: `worker-${i}` }, i);
        store.updateTodo(todo, { state: 'doing', startedAt: i }, i);
      }
    }
  }
  const observer = observeNeoSnapshotQueries(raw);
  try {
    const facts = sessions.neoStepFacts();
    return { reads: observer.queries.length, steps: facts.steps.length };
  } finally {
    observer.restore();
  }
}

test('step facts read a fixed number of times however many asks and todos are open', async () => {
  const small = await stepFactReads(3);
  const large = await stepFactReads(30);
  expect([small.steps, large.steps]).toEqual([6, 60]);
  expect(large.reads).toBe(small.reads);
});
