import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000002';
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const missing = join(run, 'wrong-worktree/result.txt');
const present = join(run, 'result.txt');
const ids = { pr: '', evidence: '', settled: '', legacy: '' };
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.jobProcessor.stop();
      const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db);
      const registry = app.sessionManager.getOperationRegistry();
      const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
      const invoke = async (name: string, input: unknown, expected = true) => {
        const reply = await handler({ name, input });
        const result = JSON.parse(reply.content[0].text);
        evidence.push({ phase, name, input, result });
        assert.equal(reply.isError ?? false, false, JSON.stringify(result));
        if (name !== 'neo.snapshot') assert.equal(result.ok, expected, JSON.stringify(result));
        return result;
      };
      const start = (id: string) => store.updateTodo(store.getTodo(id)!, { startedAt: Date.now() }, Date.now());
      const blocked = (todo: { state: string; blockedBy: string | null; blockedReason: string | null; finishedAt: number | null }, reason: string) => {
        assert.equal(todo.state, 'blocked', JSON.stringify(todo));
        assert.equal(todo.blockedBy, 'check', JSON.stringify(todo));
        assert(todo.blockedReason?.startsWith(reason), JSON.stringify(todo));
        assert.equal(todo.finishedAt, null, JSON.stringify(todo));
      };
      if (phase === 'initial') {
        db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic unmet check proof', '/tmp', '2026-10-28T00:00:00Z', '2026-10-28T00:00:00Z', 'active', '{}', '{}')").run(sender);
        new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
        new SettingsRepository(db).updateGlobalSettings({ language: 'en' });
        const opened = await invoke('neo.ask.open', { title: 'Synthetic unmet check proof', request: 'Mark work done before its check passes', todos: [
          { after: [], title: 'Merge synthetic PR', check: { pack: 'coding', kind: 'pr_merged', params: { urls: ['https://github.com/synthetic/proof/pull/1'] } } },
          { after: [], title: 'Record result', check: { pack: 'core', kind: 'evidence', params: { path: missing } } },
        ] });
        ids.pr = opened.todos[0].id;
        ids.evidence = opened.todos[1].id;
        start(ids.pr);
        start(ids.evidence);
        const closed = await invoke('neo.todo.close', { todoId: ids.pr, reason: 'Neo believes it merged' });
        blocked(closed.todo, 'check_unmet:');
        const ticked = await invoke('neo.todo.edit', { todoId: ids.pr, done: 'met', evidence: 'Neo believes it merged' });
        blocked(ticked.todo, 'check_unmet:');
        const wrong = await invoke('neo.todo.close', { todoId: ids.evidence, reason: 'Result written elsewhere' });
        blocked(wrong.todo, 'check_unmet:');
        const terminal = await invoke('neo.ask.open', { title: 'Human drops unfinished work', request: 'Settle with an unmet check', todos: [{ after: [], title: 'Unverified terminal step', check: { pack: 'core', kind: 'evidence', params: { path: missing } } }] });
        ids.settled = terminal.todos[0].id;
        start(ids.settled);
        blocked((await invoke('neo.todo.close', { todoId: ids.settled, reason: 'Verification outstanding' })).todo, 'check_unmet:');
        const before = store.getTodo(ids.settled);
        const refused = await invoke('neo.ask.settle', { askId: terminal.ask.id, status: 'done', outcome: 'Too soon' }, false);
        assert(refused.reason.startsWith('todos_unfinished:'));
        assert.deepEqual(store.getTodo(ids.settled), before);
        assert.equal(store.getAsk(terminal.ask.id)?.status, 'open');
        await invoke('neo.ask.settle', { askId: terminal.ask.id, status: 'dropped', outcome: 'Human abandoned the work' });
        const legacy = await invoke('neo.ask.open', { title: 'Legacy unexplained removal', request: 'Abandon unexplained legacy work', todos: [{ after: [], title: 'Previously removed step', check: { pack: 'core', kind: 'evidence', params: { path: missing } } }] });
        ids.legacy = legacy.todos[0].id;
        store.updateTodo(store.getTodo(ids.legacy)!, { state: 'removed', reason: null }, Date.now());
        const removed = await invoke('neo.todo.remove', { todoId: ids.legacy, reason: 'Cannot amend an already removed row' }, false);
        assert(removed.reason.startsWith('todo_removed:'));
        const unexplained = await invoke('neo.ask.settle', { askId: legacy.ask.id, status: 'done', outcome: 'Not verified' }, false);
        assert(unexplained.reason.startsWith('todos_unfinished:') && unexplained.reason.includes('settle dropped'));
        assert.equal(store.getAsk(legacy.ask.id)?.status, 'open');
        await invoke('neo.ask.settle', { askId: legacy.ask.id, status: 'dropped', outcome: 'Human abandoned unexplained legacy work' });
      }
      for (const id of [ids.settled, ids.legacy]) {
        assert.equal(store.getTodo(id)?.state, 'removed');
        const ended = await invoke('neo.ask.read', { askId: store.getTodo(id)!.askId });
        assert.equal(ended.entry.ask.status, 'dropped');
        assert.equal(ended.entry.doneCount, 0);
      }
      assert.equal(store.getTodo(ids.legacy)?.reason, null);
      const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
      const sweep = (id: string) => service.todoRunner.checkNow([id], (message, error) => { throw new Error(message, { cause: error }); });
      await sweep(ids.pr);
      await sweep(ids.evidence);
      blocked(store.getTodo(ids.pr)!, 'check_unmet:');
      blocked(store.getTodo(ids.evidence)!, 'check_unmet:');
      const read = JSON.stringify(await invoke('neo.ask.read', { askId: store.getTodo(ids.pr)!.askId }));
      assert(read.includes('Waiting for its result'), read);
      assert(!read.includes('Blocked: check_unmet:'), read);
      assert(!read.includes('Closed unverified'), read);
      assert(!JSON.stringify(await invoke('neo.snapshot', {})).includes('"doneCount":1'));
      if (phase === 'restart') {
        writeFileSync(present, 'Synthetic result');
        const fixed = await invoke('neo.todo.edit', { todoId: ids.evidence, check: { pack: 'core', kind: 'evidence', params: { path: present } } });
        evidence.push({ phase, fixedState: fixed.todo.state });
        await sweep(ids.evidence);
        assert.equal(store.getTodo(ids.evidence)?.state, 'done', JSON.stringify(store.getTodo(ids.evidence)));
        assert.equal(store.getTodo(ids.evidence)?.blockedBy, null);
        blocked(store.getTodo(ids.pr)!, 'check_unmet:');
        evidence.push({ phase, final: store.listTodos(store.getTodo(ids.pr)!.askId) });
      }
    } finally { await app.cleanup(); }
  }
  console.log('PASS: real daemon MCP keeps unmet checks blocked across restart; done refuses unfinished and unexplained removed rows; explicit dropped succeeds without certifying them.');
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
