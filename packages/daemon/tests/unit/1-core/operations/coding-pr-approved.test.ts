import { expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

const url = 'https://github.com/synthetic/project/pull/78';
const check = { pack: 'coding', kind: 'pr_approved', params: { url } };
function fixture() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Approval facts',
    request: 'Wait for approval',
    createdAt: 1,
  });
  const repository = new CodingTodoPrRepository(db);
  const pack = createCodingTodoPack(repository, async () => []);
  pack.schema(db);
  const packs = () => [{ id: 'coding', describe: 'Coding', instructions: () => null, todos: pack }];
  const operation = createNeoQuestionOperations(
    store,
    async () => {},
    async () => ({ ok: true }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    packs
  ).find((operation) => operation.name === 'neo.question.ask')!;
  return { db, store, repository, pack, operation };
}

test('a question can wait for a PR approval without a linked todo', async () => {
  const f = fixture();
  try {
    const receipt = (await f.operation.execute(
      f.operation.inputSchema.parse({
        askId: 'ask',
        kind: 'reply',
        text: 'There is no review app',
        retireWhen: check,
      }),
      { source: 'mcp', role: 'neo', sessionId: 'neo' }
    )) as { ok: boolean; question?: { id: string } };
    expect(receipt.ok).toBe(true);
    expect(f.store.getQuestion(receipt.question!.id)).toMatchObject({
      state: 'open',
      todoId: undefined,
      retireWhen: check,
    });
  } finally {
    f.db.close();
  }
});
