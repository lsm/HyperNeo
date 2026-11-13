import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const mode = process.argv[2],
  run = resolve(process.argv.at(-1)!);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const d of ['home/.codex/app-server-control', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, d), { recursive: true });
const root = 'neo:10000000-0000-4000-8000-000000010483',
  at = Date.now();
const url = (n: number) => `https://github.com/synthetic/plan/pull/${n}`;
const report = 'Complete persisted plan report 🦊\n'.repeat(4000);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fixture = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7].map((n) => [
    url(n),
    {
      url: url(n),
      state: n === 1 || n === 3 || n === 7 ? 'MERGED' : 'OPEN',
      headRefOid: 'a'.repeat(40),
      reviews: [],
      statusCheckRollup: [],
      createdAt: new Date(at - 60000).toISOString(),
      mergedAt: n === 1 || n === 3 || n === 7 ? new Date(at).toISOString() : null,
    },
  ])
);
writeFileSync(join(run, 'prs.json'), JSON.stringify(fixture));
writeFileSync(
  join(run, 'bin/gh'),
  `#!${process.execPath}
const fs=require('node:fs'),root=${JSON.stringify(run)},args=process.argv.slice(2);
fs.appendFileSync(root+'/evidence/gh.log',JSON.stringify(args)+'\\n');
if(args[0]!=='pr'||args[1]!=='view')process.exit(2);
const rows=JSON.parse(fs.readFileSync(root+'/prs.json','utf8')),row=rows[args.find(s=>s.startsWith('https://'))];
if(!row)process.exit(2);
if(row.pause){fs.writeFileSync(root+'/read-started','');const deadline=Date.now()+20000;while(!fs.existsSync(root+'/read-release')){if(Date.now()>deadline)process.exit(3);await Bun.sleep(10);}}
process.stdout.write(JSON.stringify(row));
`,
  { mode: 0o700 }
);
writeFileSync(join(run, 'bin/ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
const state = new Database(join(run, 'home/.codex/state_5.sqlite'));
state.exec(
  'CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,updated_at_ms INTEGER);CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)'
);
for (const id of ['flow', 'restart', 'blocked']) {
  const rollout = join(run, `home/.codex/${id}.jsonl`);
  writeFileSync(
    rollout,
    JSON.stringify({
      timestamp: new Date(at - 600000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'Prior synthetic turn' },
    }) + '\n'
  );
  state
    .prepare("INSERT INTO threads VALUES (?,?,'','',?,'vscode',0,?,?,NULL)")
    .run(id, id, join(run, 'workspace'), at - 600000, rollout);
}
state.close();
const calls: Record<string, unknown>[] = [];
const peer = Bun.serve({
  unix: join(run, 'home/.codex/app-server-control/app-server-control.sock'),
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('websocket', { status: 400 });
  },
  websocket: {
    message(socket, bytes) {
      const call = JSON.parse(String(bytes));
      if (!('id' in call)) return;
      calls.push(call);
      if (['turn/start', 'thread/queue/add'].includes(call.method)) {
        const input = call.params.input
          .map((part: { text?: string }) => part.text ?? '')
          .join('\n');
        writeFileSync(
          join(run, `home/.codex/${call.params.threadId}.jsonl`),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              ...(mode.startsWith('chain-') ? { id: call.params.clientUserMessageId } : {}),
              content: [{ type: 'input_text', text: input }],
            },
          }) + '\n',
          { flag: 'a' }
        );
      }
      const result =
        ['thread/turns/list', 'thread/loaded/list'].includes(call.method)
          ? { data: [] }
          : call.method === 'thread/resume'
            ? { thread: { id: call.params.threadId, status: { type: 'idle' }, turns: [] } }
            : call.method === 'thread/queue/add'
              ? { queuedSubmission: { id: crypto.randomUUID() } }
              : call.method === 'turn/start'
              ? { turn: { id: crypto.randomUUID() } }
              : {};
      socket.send(JSON.stringify({ id: call.id, jsonrpc: '2.0', result }));
    },
  },
});
const evidence: Record<string, unknown> = {
  mode,
  calls,
  inputReport: { bytes: Buffer.byteLength(report), sha256: hash(report) },
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
let store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository;
const starts = () => calls.filter((c) => ['turn/start', 'thread/queue/add'].includes(String(c.method))).length;
const open = async () => {
  app = await createDaemonApp({
    config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  if (process.argv.includes('--without-coding'))
    app.db.updateGlobalSettings({ neo: { packs: ['inbox-triage'] } });
  store = new NeoAskTodoRepository(app.db.getDatabase());
  sessions = new NeoTodoSessionRepository(app.db.getDatabase());
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('RPC unavailable'));
  });
};
const rpc = (name: string, input: unknown) =>
  new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(),
      timer = setTimeout(() => fail(new Error(name + ' timeout')), 20000);
    ws!.onmessage = (e) => {
      const r = JSON.parse(String(e.data));
      if (r.id !== id && r.requestId !== id) return;
      clearTimeout(timer);
      r.error ? fail(new Error(JSON.stringify(r.error))) : done(r.data);
    };
    ws!.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method: 'operation.invoke',
        data: { name, input },
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
const refresh = async () => {
  const job = app!.jobQueue.enqueue({
      queue: 'neo.work.driver.refresh',
      payload: { scope: 'neo' },
      runAt: Date.now(),
    }),
    deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const current = app!.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return current;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Driver refresh did not complete');
};
const ask = (id: string) =>
  store.openAsk({
    id,
    title: id,
    request: 'Synthetic ordered work',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: at,
  });
const add = (id: string, askId: string, n: number, worker?: string) => {
  const todo = store.addTodo(
    id,
    askId,
    {
      title: id,
      doneWhen: 'Synthetic PR merged',
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url(n)] } },
      instruction: worker ? `Perform ${id}` : null,
      named: null,
    },
    at
  );
  if (worker) sessions.create(id, { verb: 'send', ref: { adapter: 'codex-desktop', id: worker } });
  return todo;
};
try {
  await open();
  await app!.db.createSession({
    id: root,
    title: 'Synthetic plan proof',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date(at).toISOString(),
    lastActiveAt: new Date(at).toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  new NeoRepository(app!.db.getDatabase()).reserveBinding({
    sessionId: root,
    kind: 'neo',
    projectId: null,
  });
  {
    const mcp = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
    const call = async (name: string, input: unknown, accepted = true) => {
      const response = await mcp({ name, input });
      const result = JSON.parse(response.content[0].text);
      assert(!response.isError && result.ok === accepted, JSON.stringify(result));
      return result;
    };
    const target = (id = 'flow') => ({ verb: 'send', ref: { adapter: 'codex-desktop', id } });
    const step = (title: string, id = 'flow') => ({ after: [], title, instruction: `Complete ${title}.`, target: target(id), check: { pack: 'core', kind: 'evidence', params: { path: join(run, title) } } });
    const read = async (askId: string) => (await rpc('neo.ask.read', { askId })).entry;
    const complete = async (title: string) => { writeFileSync(join(run, title), 'Verified outcome'); await refresh(); };
    const open = (view: { questions: { state: string }[] }) => view.questions.filter((q) => q.state === 'open');
    const state = (view: { todos: { id: string; state: string }[] }, id: string) => view.todos.find((t) => t.id === id)?.state;
    const until = async (ready: () => boolean | Promise<boolean>, what: string) => {
      const deadline = Date.now() + 15000;
      while (!(await ready())) {
        if (Date.now() >= deadline) evidence.timedOut = { what, rows: store.listTodos(opened.todos[0].askId) };
        assert(Date.now() < deadline, `timed out waiting for ${what}`);
        await refresh();
      }
    };
    const reply = (askId: string) => {
      const id = crypto.randomUUID();
      store.askQuestion(id, askId, { text: 'Which release?', kind: 'reply', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: null }, Date.now());
      return id;
    };
    const opened = await call('neo.ask.open', { title: 'Chain', request: 'Run the plan in order.', todos: [
      { ...step('chain-1'), after: [] },
      { ...step('chain-2', 'restart'), after: [0] },
      { ...step('chain-3', 'blocked'), after: [1] },
      { title: 'chain-held', after: [], check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'chain-held') } } },
    ] });
    const [one, two, three, held] = opened.todos;
    await until(() => starts() === 1, 'the first step to dispatch');
    const first = await read(one.askId);
    evidence.afterOpen = first;
    assert.deepEqual(open(first), []);
    assert.deepEqual([state(first, one.id), state(first, two.id), state(first, three.id)], ['doing', 'todo', 'todo']);
    assert.equal(starts(), 1);
    await call('neo.todo.hold', { todoId: held.id, reason: 'Human paused this step.' });
    const unapproved = add('unapproved', one.askId, 2, 'flow');
    app!.db.getDatabase().prepare("UPDATE neo_todos SET state = 'blocked', blocked_by = 'question', approved_at = NULL WHERE id = ?").run(unapproved.id);
    store.askQuestion(crypto.randomUUID(), one.askId, { text: 'Start "unapproved"?', kind: 'start', options: null, multiple: false, noLabel: null, yesLabel: null, startTodos: [unapproved.id] }, Date.now());
    const unrelated = reply(one.askId);
    assert.equal((await rpc('neo.question.answer', { questionId: unrelated, answer: 'The next one' })).ok, true);
    await refresh();
    const afterUnrelated = await read(one.askId);
    evidence.afterUnrelatedCard = afterUnrelated;
    assert.equal(store.getTodo(held.id)?.blockedBy, 'held');
    assert.equal(store.getTodo(unapproved.id)?.startedAt, null);
    assert.deepEqual(open(afterUnrelated).map((q: { kind: string }) => q.kind), ['start']);
    assert.equal(starts(), 1);
    await complete('chain-1');
    await until(() => starts() === 2, 'the second step to dispatch');
    assert.deepEqual([state(await read(one.askId), two.id), state(await read(one.askId), three.id)], ['doing', 'todo']);
    assert.equal(starts(), 2);
    await complete('chain-2');
    await until(() => starts() === 3, 'the third step to dispatch');
    const finished = await read(one.askId);
    evidence.chainFinished = finished;
    assert.equal(state(finished, three.id), 'doing');
    assert.equal(starts(), 3);
    assert.deepEqual(open(finished).map((q: { kind: string }) => q.kind), ['start']);
    assert.equal(store.getTodo(held.id)?.blockedBy, 'held');
    assert.equal(store.getTodo(unapproved.id)?.startedAt, null);
    evidence.verified = true;
    console.log('PASS: an added chain started step by step with no Start card; an unrelated answer left the held and the unapproved todo held');
  }
} finally {
  ws?.close();
  await app?.cleanup();
  peer.stop(true);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
