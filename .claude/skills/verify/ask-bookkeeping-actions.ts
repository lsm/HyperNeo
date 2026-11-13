import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordOperationRefusal } from '../../../packages/daemon/src/storage/repositories/operation-refusal-repository.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { createNeoAskRecordOperations } from '../../../packages/daemon/src/lib/neo/ask-record-operations.ts';
import { createNeoWorkerQuestionWriter, createNeoQuestionOperations } from '../../../packages/daemon/src/lib/neo/question-operations.ts';
import { createNeoAskReadOperation, createNeoDoneTodosOperation } from '../../../packages/daemon/src/lib/neo/ask-entries.ts';
import { createOperationRegistry, type OperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createDiscoveryOperations } from '../../../packages/daemon/src/lib/operations/discovery.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createNeoTodoOperations, type NeoTodoControls } from '../../../packages/daemon/src/lib/neo/todo-operations.ts';
import { createTodoCheckPacks, existingTodoTarget, pendingTodoCheck } from '../../../packages/daemon/tests/unit/helpers/todo-check-packs.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'data'), { recursive: true }); mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
let mixedAskId = '';
for (const phase of ['initial', 'reopen']) {
  const db = new Database(join(run, 'data/daemon.db'));
  try {
    runMigrations(db, () => {}); createTables(db);
    const store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
    const packRepo = (id: string) => (db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id = ?').get(id) as { repo: string | null } | null)?.repo ?? null;
    const askRepo = (id: string) => (db.prepare('SELECT repo FROM neo_asks WHERE id = ?').get(id) as { repo: string | null }).repo;
    const unexpected = async (): Promise<never> => { throw new Error('No worker dispatch or answer is permitted'); };
    const packs = createTodoCheckPacks(db);
    const controls: NeoTodoControls = {
      resolveTarget: existingTodoTarget,
      start: unexpected,
      proceed: unexpected,
      retry: unexpected,
      stop: async () => null,
      recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()),
    };
    const admit = (caller: Parameters<typeof createNeoAskReadOperation>[2] extends (arg: infer T) => unknown ? T : never) => ({ value: caller });
    const project = async <T,>(items: readonly T[]) => [...items];
    const registry: OperationRegistry = createOperationRegistry([
      ...createDiscoveryOperations(() => registry),
      ...createNeoAskRecordOperations(store, sessions, controls, () => null, () => true, () => [],
      () => packs,
      undefined,
      undefined,
      { gateway: gatewayFor(db), changed: () => {} }
),
      ...createNeoQuestionOperations(store, unexpected, unexpected),
      ...createNeoTodoOperations(store, sessions, controls, () => packs, () => null),
      createNeoAskReadOperation(store, () => [], admit, project),
      createNeoDoneTodosOperation(store, sessions, () => [], admit, project),
    ]);
    const handler = createOperationMcpHandler(registry, () => ({ sessionId: 'neo', role: 'neo' }), (refusal) => gatewayFor(db).run(recordOperationRefusal, { refusal, sessionId: 'neo', at: Date.now() }));
    const call = async (name: string, input: unknown, expected = true) => {
      const reply = await handler({ name, input }), result = JSON.parse(reply.content[0].text);
      evidence.push({ phase, name, reply }); assert.equal(reply.isError ?? false, false); assert(result.ok === expected || result.found === true, JSON.stringify(result)); return result;
    };
    const described = await call('operations.describe', { name: 'neo.question.ask' });
    assert.equal(described.found, true);
    assert(described.description.includes('If a supplied todoId is unknown, belongs to another ask, or is done, closed unverified or removed'));
    assert(described.description.includes('supply explicit retireWhen to open the question on the ask without linking that todo'));
    assert(described.description.includes('A successful unlinked card includes a todo_closed record'));
    if (phase === 'initial') {
      const mixed = await call('neo.ask.open', {
        title: 'One cross-repo request', request: 'Keep both repositories together',
        todos: ['first', 'second'].map((repo) => ({ after: [],
          title: `Work in ${repo}`, check: { pack: 'coding', kind: 'pr_merged', params: { urls: [`https://github.com/synthetic/${repo}/pull/1`] } },
        })),
      });
      mixedAskId = mixed.ask.id;
      assert.equal(mixed.ask.status, 'open');
      assert.equal(mixed.todos.length, 2);
      assert(mixed.todos.every((todo: { askId: string }) => todo.askId === mixed.ask.id));
      assert.deepEqual(store.listChildAsks(mixed.ask.id), []);
      const ask = store.openAsk({ id: 'ask', projectId: null, sessionId: 'neo', originMessageId: null, title: 'Synthetic ask', request: 'Close unverified work visibly', createdAt: 1 });
      const repoAsk = store.openAsk({ ...ask, id: 'repository', title: 'Repository work' });
      db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('github.com/synthetic/root', repoAsk.id);
      const context = store.addTodo('repository-context', repoAsk.id, { title: 'Known repository', doneWhen: 'Observed', check: null, instruction: null, named: null }, 1, 'github.com/synthetic/root');
      const draft = { after: [],
        title: 'Local work',
        check: pendingTodoCheck,
        instruction: 'Work',
        start: false,
        target: { verb: 'start', adapter: 'hyperneo' },
      };
      const refused = await call('neo.todo.add', { after: [], askId: repoAsk.id, ...draft }, false);
      assert(refused.reason.startsWith('place_required:'));
      assert.deepEqual(store.listTodos(repoAsk.id), [context]);
      const placed = await call('neo.todo.add', { after: [],
        askId: repoAsk.id, ...draft,
        target: {
          ...draft.target,
          place: {
            machine: 'synthetic', name: 'local',
            folder: join(run, 'workspace'), remotes: [],
          },
        },
      });
      assert.equal(packRepo(placed.todo.id), null);
      assert.equal(placed.todo.askId, repoAsk.id);
      assert.equal(askRepo(repoAsk.id), 'github.com/synthetic/root');
      const unfinished = store.addTodo('unfinished', ask.id, { title: 'Unverified delivery', doneWhen: 'Build served and observed', instruction: null, check: null, named: null }, 1);
      const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
      sessions.create(unfinished.id, { verb: 'send', ref }); sessions.recordRef(unfinished.id, ref, 2);
      store.updateTodo(unfinished, { state: 'doing', startedAt: 2 }, 2);
      const writer = createNeoWorkerQuestionWriter(store, sessions, () => 'en', async () => ({ ...ref, name: 'Worker', label: 'HyperNeo · Worker', provider: 'HyperNeo', link: null }));
      const workerQuestion = await writer(ref, { todoId: unfinished.id, kind: 'question', title: 'Which target?', options: ['First', 'Second'], language: 'en', report: 'Synthetic human decision required.' });
      assert(workerQuestion.ok); assert.equal(store.getTodo(unfinished.id)?.blockedBy, 'needs-human');
      evidence.push({ beforeSettlement: store.getTodo(unfinished.id), workerQuestion });
      const closed = store.addTodo('closed', ask.id, { title: 'Closed work', doneWhen: 'Checked', instruction: null, check: null, named: null }, 1);
      const failed = store.addTodo('failed', ask.id, { title: 'Failed work', doneWhen: 'Build observed', instruction: null, check: null, named: null }, 1);
      store.updateTodo(failed, { state: 'failed', reason: 'check_failed: build exited 7' }, 2);
      store.updateTodo(closed, { state: 'closed_unverified', reason: 'Not observed' }, 2);
      const question = await call('neo.question.ask', { askId: ask.id, todoId: closed.id, text: 'What next?', kind: 'reply', replaces: workerQuestion.question.id, retireWhen: { pack: 'core', kind: 'evidence', params: { path: join(run, 'not-created') } } });
      assert(question.records[0].startsWith('todo_closed:')); assert.equal(question.question.todoId ?? null, null);
      const beforeTodos = store.listTodos(ask.id), beforeQuestions = store.listQuestions(ask.id);
      const refusedDone = await call('neo.ask.settle', { askId: ask.id, status: 'done', outcome: 'Too soon' }, false);
      assert(refusedDone.reason.startsWith('todos_unfinished:'));
      assert.deepEqual(store.listTodos(ask.id), beforeTodos); assert.deepEqual(store.listQuestions(ask.id), beforeQuestions);
      assert.equal(store.getAsk(ask.id)?.status, 'open');
      await call('neo.todo.remove', { todoId: unfinished.id, reason: 'The human abandoned this step' });
      await call('neo.todo.remove', { todoId: failed.id, reason: 'The human abandoned this failed step. check_failed: build exited 7' });
      const settled = await call('neo.ask.settle', { askId: ask.id, status: 'done', outcome: 'Ended after explicit per-todo decisions' });
      assert.equal(settled.ask.status, 'done');
      store.openAsk({ id: 'child', parentId: ask.id, projectId: null, sessionId: ask.sessionId, originMessageId: null, title: 'Child card', request: 'Filed work', createdAt: 1 });
      db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run('github.com/synthetic/child', 'child');
      store.addTodo('legacy-child-todo', 'child', { title: 'Existing child work', doneWhen: 'Observed', check: null, instruction: null, named: null }, 1, 'github.com/synthetic/child');
      const retry = await call('neo.ask.open', { title: ask.title, request: 'Follow-up', todos: [{ after: [], title: 'New follow-up', check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'not-created') } } }] });
      assert.equal(retry.ask.id, ask.id); assert.equal(retry.todos.length, 4);
      assert(retry.records[0].includes('Open a new ask for it with a different title'));

    }
    const mixed = await call('neo.ask.read', { askId: mixedAskId });
    assert.equal(mixed.entry.ask.status, 'open');
    assert.equal(mixed.entry.todos.length, 2);
    assert(mixed.entry.todos.every((todo: { askId: string }) => todo.askId === mixedAskId));
    const read = await call('neo.ask.read', { askId: 'ask' });
    const child = await call('neo.ask.read', { askId: 'child' });
    assert.equal(child.entry.ask.parentId, 'ask');
    assert.equal(child.entry.ask.status, 'open');
    assert(!('repo' in child.entry.ask));
    assert.equal(askRepo('child'), 'github.com/synthetic/child');
    assert.equal(child.entry.todos[0].id, 'legacy-child-todo');
    assert.equal(packRepo('legacy-child-todo'), 'github.com/synthetic/child');
    const byTodo = await call('neo.ask.read', { todoId: 'legacy-child-todo' });
    assert.equal(byTodo.entry.ask.id, 'child');
    const local = await call('neo.ask.read', { askId: 'repository' });
    assert.equal(packRepo(local.entry.todos.find((todo: { title: string }) => todo.title === 'Local work').id), null);
    assert.equal(askRepo('repository'), 'github.com/synthetic/root');
    for (const [id, state] of [['unfinished', 'removed'], ['closed', 'closed_unverified'], ['failed', 'removed']])
      assert.equal(read.entry.todos.find((todo: { id: string }) => todo.id === id)?.state, state);
    assert.equal(read.entry.doneCount, 0);
    assert(read.entry.todos.find((todo: { id: string }) => todo.id === 'failed').reason.includes('check_failed: build exited 7'));
    assert((await call('neo.ask.doneTodos', { askId: 'ask' })).todos.length === 0);
    assert(store.listQuestions('ask').every((question) => question.state === 'retired' && question.answer === null && question.answeredBy === null));
    const audits = db.prepare('SELECT operation,reason,accepted FROM operation_refusals ORDER BY id').all();
    assert.equal(audits.filter((audit) => (audit as { accepted: number }).accepted === 1).length, 2);
    assert.equal(audits.filter((audit) => (audit as { reason: string }).reason.startsWith('place_required:')).length, 1);
    assert.equal(audits.filter((audit) => (audit as { reason: string }).reason.startsWith('todos_unfinished:')).length, 1);
    evidence.push({ phase, audits, todos: store.listTodos('ask') });
  } finally { await gatewayFor(db).close(); db.close(); writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
}
console.log('PASS: MCP catalog and settled-ask guidance match record behavior; unverified rows, unanswered questions and accepted audit records survive DB reopen.');
