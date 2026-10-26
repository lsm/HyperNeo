import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const name of ['evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2), root = ${JSON.stringify(run)};
fs.appendFileSync(root+'/evidence/gh.log', JSON.stringify(args)+'\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  const url = args.find(x => x.startsWith('https://'));
  if (!url || !url.startsWith('https://github.com/synthetic/facts/pull/')) process.exit(2);
  process.stdout.write(JSON.stringify({ url, state: url.endsWith('/6') ? 'OPEN' : 'MERGED', headRefOid: 'a'.repeat(40),
    mergeCommit: { oid: 'b'.repeat(40) }, reviews: [], statusCheckRollup: [], createdAt: '2026-10-20T00:00:00Z', mergedAt: '2026-10-21T00:00:00Z' }));
} else if (args[0] === 'api' && args[1] === 'graphql' && args.includes('o=synthetic') && args.includes('n=facts')) {
  const closed = args.includes('p=219');
  process.stdout.write(JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'dev' }, issueOrPullRequest: {
    __typename: 'Issue', url: 'https://github.com/synthetic/facts/issues/'+(closed ? 219 : 220), state: closed ? 'CLOSED' : 'OPEN',
    stateReason: closed ? 'COMPLETED' : null, closedByPullRequestsReferences: { nodes: [] }, closedAt: closed ? '2026-10-21T00:00:00Z' : null,
  } } } }));
} else if (args[0] === 'api' && args.some(x => x.startsWith('repos/synthetic/facts/commits/') && x.includes('/check-runs?'))) {
  process.stdout.write(JSON.stringify({ check_runs: [] }));
} else if (args[0] === 'api' && args.some(x => x.startsWith('repos/synthetic/facts/commits/') && x.includes('/status?'))) {
  process.stdout.write(JSON.stringify({ statuses: [] }));
} else process.exit(2);
`, { mode: 0o700 });
const root = 'neo:10000000-0000-4000-8000-000000008973';
const cases = [
  { id: 'merged-delivery', kind: 'pr_merged', state: 'doing', marked: true, done: true },
  { id: 'issue-delivery', kind: 'issue_closed', state: 'doing', marked: true, done: true },
  { id: 'merged-human', kind: 'pr_merged', state: 'blocked', blocker: 'needs-human', done: true },
  { id: 'issue-human', kind: 'issue_closed', state: 'blocked', blocker: 'needs-human', done: true },
  { id: 'merged-worker', kind: 'pr_merged', state: 'blocked', blocker: 'worker', done: true },
  { id: 'open-human', kind: 'pr_merged', state: 'blocked', blocker: 'needs-human', done: false },
  { id: 'removed', kind: 'pr_merged', state: 'removed', done: false },
];
const evidence: unknown[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert(app.server.port > 0 && app.server.port !== 8399);
  await app.jobProcessor.stop();
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db);
  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES (?, 'Synthetic completion facts', ?, '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z', 'active', '{"queryMode":"manual"}', '{}')`).run(root, run);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  for (const [index, item] of cases.entries()) {
    store.openAsk({ id: item.id, title: item.id, request: 'Observe completion', sessionId: root, projectId: null, originMessageId: null, createdAt: 1 });
    const url = `https://github.com/synthetic/facts/pull/${index + 1}`;
    const todo = store.addTodo(item.id, item.id, { title: item.id, doneWhen: 'Declared check passes', instruction: null, named: null,
      check: { pack: 'coding', kind: item.kind, params: item.kind === 'pr_merged' ? { urls: [url] } : { issue: 'synthetic/facts#219' } } }, 1);
    db.prepare('UPDATE neo_todos SET state=?, blocked_by=?, blocked_reason=?, next_action=?, report=? WHERE id=?')
      .run(item.state, item.blocker ?? null, item.blocker ? 'Old blocker' : null, item.blocker ? 'Answer' : null, 'Preserve the complete worker report', todo.id);
    if (item.blocker === 'needs-human') store.askQuestion(`question-${item.id}`, item.id, {
      text: 'Old question', kind: 'yesno', options: null, multiple: false, noLabel: 'No', yesLabel: 'Yes', startTodos: null, todoId: todo.id,
    }, 2);
    if (item.marked) {
      await new CodingTodoPrRepository(db).write('record', todo.id, [{ url, head: 'a'.repeat(40), state: 'OPEN', checks: 'none', review: 'none' }], Date.now());
      const assignments = new CodingAssignmentsRepository(db);
      const base = { url, head: 'a'.repeat(40), acceptanceContract: 'synthetic-acceptance', newDispatch: true as const, write: { adapter: 'test', id: 'author' } };
      assert(await assignments.recordLater(todo.id, 'review', { ...base, bot: 'review-bot' }));
      assert(await assignments.recordLater(todo.id, 'qa', { ...base, ref: { adapter: 'test', id: 'qa' }, actor: { kind: 'agent', id: 'qa', harness: 'test', model: 'synthetic' } }));
    }
  }
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WebSocket open failed')); });
  const rpc = (name: string, input: unknown) => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timeout = setTimeout(() => fail(new Error(name+' timeout')), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timeout); evidence.push({ name, input, reply }); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data.value ?? reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const refresh = async () => {
    const job = app!.jobQueue.enqueue({ queue: 'neo.work.driver.refresh', payload: { scope: 'neo' }, runAt: Date.now() });
    await app!.jobProcessor.tick();
    const deadline = Date.now() + 20000;
    while (app!.jobQueue.getJob(job.id)?.status !== 'completed') {
      const current = app!.jobQueue.getJob(job.id)!;
      assert(!['failed', 'dead'].includes(current.status), JSON.stringify(current));
      assert(Date.now() < deadline, 'Driver refresh completed');
      await new Promise(done => setTimeout(done, 10));
    }
  };
  await refresh();
  const observed = cases.map(item => ({ id: item.id, todo: store.getTodo(item.id), question: store.getQuestion(`question-${item.id}`) }));
  evidence.push({ observed });
  for (const item of cases) {
    const response = await rpc('neo.ask.read', { askId: item.id });
    const entry = response.entry as { todos: { id: string; state: string }[] };
    assert.equal(entry.todos.find(todo => todo.id === item.id)?.state, item.done ? 'done' : item.state, item.id);
  }
  for (const item of cases) {
    const todo = store.getTodo(item.id)!;
    assert.equal(todo.state, item.done ? 'done' : item.state, item.id);
    assert.equal(todo.report, 'Preserve the complete worker report');
    if (item.done) assert.equal(todo.blockedBy, null, item.id);
    if (item.blocker === 'needs-human') {
      const question = store.getQuestion(`question-${item.id}`)!;
      assert.equal(question.state, item.done ? 'retired' : 'open', item.id);
      assert.equal(question.answer, null, item.id);
    }
  }
  await refresh();
  assert.deepEqual(cases.map(item => store.getTodo(item.id)), observed.map(item => item.todo));
  console.log('PASS: the real scheduled driver refresh completes merged/closed checks despite old human, worker or delivery gates; RPC reads show the resulting done state.');
} catch (error) { evidence.push({ error: String(error) }); throw error; }
finally { ws?.close(); await app?.cleanup(); globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
