import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { recordWorkTurns } from '../../../../src/storage/repositories/work-turn-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import {
  CodingPrEventRepository,
  deliverCodingPrEvents,
} from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

const url = 'https://github.com/example/repo/pull/1';
const ref = { adapter: 'hyperneo', id: 'worker' };
let db: Database, todos: NeoAskTodoRepository, ledger: CodingPrLedgerRepository;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  todos = new NeoAskTodoRepository(db);
  todos.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Implement change',
    request: 'Open a PR',
    createdAt: 1,
  });
  ledger = new CodingPrLedgerRepository(db);
  db.prepare(
    `INSERT INTO pack_coding_pr_ledger (repo,number,title,branch,head,state,state_since,read_at,created_at) VALUES ('example/repo',1,'Change','work','head','waiting_review',1,1,105)`
  ).run();
  recordWorkTurns.run(
    db,
    {
      ref,
      turns: [
        {
          id: 'turn',
          startedAt: 100,
          endedAt: 110,
          ended: 'success',
          inputs: [],
          urls: [url],
          finalUrls: [url],
          complete: true,
          cursor: '{"seq":1}',
        },
      ],
    },
    undefined as never
  );
});
afterEach(() => db.close());
const add = (id: string, repo = 'github.com/example/repo', state: NeoTodo['state'] = 'doing') => {
  const todo = todos.addTodo(
    id,
    'ask',
    {
      title: id,
      check: { pack: 'coding', kind: 'pr_merged', params: { keep: true } },
      doneWhen: 'Merged',
      instruction: 'Implement',
      named: null,
      approvedAt: 1,
    },
    1,
    repo
  );
  const updated = todos.updateTodo(todo, { state, startedAt: 90 }, 2);
  new NeoTodoSessionRepository(db).bind(id, ref, 2);
  return updated;
};

test('the sole doing coding todo records its produced PR through addUrls', () => {
  add('owner');
  ledger.assignOwners();
  expect(todos.getTodo('owner')!.check?.params).toEqual({ keep: true, urls: [url] });
  expect(todos.getTodo('owner')!.doneWhen).toBe('example/repo#1 merged');
  expect(new CodingPrEventRepository(db).route({ repo: 'example/repo', number: 1 }).owner).toEqual(
    ref
  );
  ledger.assignOwners();
  expect(todos.getTodo('owner')!.check?.params.urls).toEqual([url]);
});

test('a completed prior binding does not hide the sole active todo', () => {
  add('owner');
  const prior = add('prior');
  todos.updateTodo(prior, { state: 'done', finishedAt: 104 }, 104);
  ledger.assignOwners();
  expect(todos.getTodo('owner')!.check?.params.urls).toEqual([url]);
  expect(new CodingPrEventRepository(db).route({ repo: 'example/repo', number: 1 }).owner).toEqual(
    ref
  );
});

test.each([
  'two doing todos',
  'another repository',
  'already named',
  'non-coding',
  'finished',
  'historical PR',
])('does not attach with %s', (scenario) => {
  const owner = add(
    'owner',
    scenario === 'another repository' ? 'github.com/example/other' : undefined
  );
  if (scenario === 'two doing todos') add('second');
  if (scenario === 'already named') {
    const other = add('named');
    todos.updateTodo(
      other,
      { state: 'blocked', check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } } },
      3
    );
  }
  if (scenario === 'non-coding')
    todos.updateTodo(owner, { check: { pack: 'core', kind: 'evidence', params: {} } }, 3);
  if (scenario === 'historical PR') todos.updateTodo(owner, { startedAt: 120 }, 3);
  if (scenario === 'finished') todos.updateTodo(owner, { state: 'done', finishedAt: 100 }, 3);
  ledger.assignOwners();
  expect(todos.getTodo('owner')!.check?.params.urls).toBeUndefined();
});

test('merge confirmation for the attached PR is delivered to the worker', async () => {
  add('owner');
  ledger.assignOwners();
  expect(todos.getTodo('owner')!.check?.params.urls).toEqual([url]);
  const event = {
    repo: 'example/repo',
    number: 1,
    title: 'Change',
    branch: 'work',
    head: 'head',
    state: 'merged',
    from: 'waiting_review',
    closedAt: 200,
  };
  db.prepare(
    'UPDATE pack_coding_pr_ledger SET state = ?, closed_at = ?, terminal_event_json = ?'
  ).run('merged', 200, JSON.stringify(event));
  const deliveries: { ref: unknown; text: string }[] = [];
  let wakes = 0;
  await deliverCodingPrEvents(new CodingPrEventRepository(db), [], {
    host: 'github.com',
    tell: async (target, _key, text) => {
      deliveries.push({ ref: target, text });
      return true;
    },
    wake: async () => {
      wakes++;
      return true;
    },
  });
  expect(deliveries).toEqual([{ ref, text: expect.stringContaining('was merged') }]);
  expect(wakes).toBe(0);
});
