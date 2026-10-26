import { expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoJudgement } from '../../../../src/lib/neo/pack-contract.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import {
  NeoAskTodoRepository,
  type NeoTodoPatch,
} from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function fixture(state: NeoTodo['state'] = 'doing', humanBlocked = false, askClosed = false) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const gateway = new DbGateway(':memory:', db);
  bindGateway(db, gateway);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Ordered state',
    request: 'Complete both steps',
    createdAt: 1,
  });
  for (const id of ['first', 'next'])
    store.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Observed', check: null, instruction: 'Continue work', named: null },
      1
    );
  db.prepare(
    'UPDATE neo_todos SET state=?, started_at=2, report=?, blocked_by=?, blocked_reason=?, next_action=? WHERE id=?'
  ).run(
    state,
    'Complete report 🦊\n'.repeat(20_000),
    humanBlocked ? 'needs-human' : null,
    humanBlocked ? 'A human decision is required' : null,
    humanBlocked ? 'Answer' : null,
    'first'
  );
  store.askQuestion(
    'stale-start',
    'ask',
    {
      text: 'Start first?',
      kind: 'start',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      startTodos: ['first'],
    },
    3
  );
  if (askClosed) db.prepare("UPDATE neo_asks SET status='done' WHERE id='ask'").run();
  return {
    db,
    gateway,
    store,
    async close() {
      await gateway.close();
      db.close();
    },
  };
}

const cases: {
  name: string;
  state?: NeoTodo['state'];
  humanBlocked?: boolean;
  askClosed?: boolean;
  change?: NeoTodoPatch;
  judgement: NeoTodoJudgement;
  expected: NeoTodo['state'];
  next: string | null;
}[] = [
  {
    name: 'completion returns the next candidate',
    judgement: { state: 'done', evidence: 'Complete' },
    expected: 'done',
    next: 'next',
  },
  {
    name: 'failure does not advance',
    judgement: { state: 'failed', reason: 'Refused' },
    expected: 'failed',
    next: null,
  },
  {
    name: 'a check blocker does not advance',
    judgement: { state: 'blocked', reason: 'Resolve it' },
    expected: 'blocked',
    next: null,
  },
  {
    name: 'an explicit close preserves its evidence',
    change: { state: 'done', evidence: 'Human proof' },
    judgement: { state: 'no_opinion' },
    expected: 'done',
    next: 'next',
  },
  {
    name: 'removed work stays removed',
    state: 'removed',
    change: { state: 'doing' },
    judgement: { state: 'done', evidence: 'Late fact' },
    expected: 'removed',
    next: null,
  },
  {
    name: 'a passed check supersedes an old human block',
    state: 'blocked',
    humanBlocked: true,
    judgement: { state: 'done', evidence: 'Late fact' },
    expected: 'done',
    next: 'next',
  },
  {
    name: 'a closed ask removes active work',
    askClosed: true,
    judgement: { state: 'no_opinion' },
    expected: 'removed',
    next: null,
  },
  {
    name: 'unchanged live work does not advance',
    judgement: { state: 'no_opinion' },
    expected: 'doing',
    next: null,
  },
];

test.each(cases)(
  '$name matches legacy state and pruning with a serializable result',
  async (input) => {
    const legacy = fixture(input.state, input.humanBlocked, input.askClosed);
    const writer = fixture(input.state, input.humanBlocked, input.askClosed);
    try {
      let startNext: string | null = null;
      const before = legacy.store.getTodo('first')!;
      const todo = await legacy.store.recompute(
        before,
        input.change ?? {},
        10,
        input.judgement,
        async (id) => {
          startNext = id;
        }
      );
      const result = await writer.store.write(
        'commitState',
        'first',
        input.change ?? {},
        10,
        input.judgement
      );
      expect(result).toEqual({ todo, startNext });
      expect(structuredClone(result)).toEqual(result);
      expect(result.todo?.state).toBe(input.expected);
      expect(result.startNext).toBe(input.next);
      expect(result.todo?.report).toBe(before.report);
      expect(writer.store.getQuestion('stale-start')).toEqual(
        legacy.store.getQuestion('stale-start')
      );
      expect(writer.store.getAsk('ask')).toEqual(legacy.store.getAsk('ask'));
      expect(writer.store.getTodo('next')?.state).toBe('todo');
    } finally {
      await legacy.close();
      await writer.close();
    }
  }
);

test('a refused ask stamp rolls back pruning and todo changes before returning', async () => {
  const f = fixture();
  try {
    const before = {
      todo: f.store.getTodo('first'),
      question: f.store.getQuestion('stale-start'),
      ask: f.store.getAsk('ask'),
    };
    f.db.exec(
      "CREATE TRIGGER refuse_ask_stamp BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, 'synthetic ask stamp refusal'); END"
    );
    await expect(
      f.store.write('commitState', 'first', {}, 10, { state: 'done', evidence: 'Complete' })
    ).rejects.toThrow('synthetic ask stamp refusal');
    expect({
      todo: f.store.getTodo('first'),
      question: f.store.getQuestion('stale-start'),
      ask: f.store.getAsk('ask'),
    }).toEqual(before);
  } finally {
    await f.close();
  }
});

test.each(['unknown', 'deleted'] as const)(
  '%s todo returns no committed work or next candidate and preserves other state',
  async (kind) => {
    const f = fixture();
    try {
      const id = kind === 'unknown' ? 'missing' : 'first';
      if (kind === 'deleted') f.db.prepare('DELETE FROM neo_todos WHERE id=?').run(id);
      const before = {
        todos: f.store.listTodos('ask'),
        questions: f.store.listQuestions('ask'),
        ask: f.store.getAsk('ask'),
      };
      const result = await f.store.write('commitState', id, {}, 20, {
        state: 'done',
        evidence: 'Late completion',
      });
      expect(result).toEqual({ todo: null, startNext: null });
      expect({
        todos: f.store.listTodos('ask'),
        questions: f.store.listQuestions('ask'),
        ask: f.store.getAsk('ask'),
      }).toEqual(before);
    } finally {
      await f.close();
    }
  }
);
