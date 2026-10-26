import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const [mode, directory] = process.argv.slice(2),
  run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const d of ['home/.codex/app-server-control', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, d), { recursive: true });
const root = 'neo:10000000-0000-4000-8000-000000008229',
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
      timestamp: new Date(at - 60000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: 'Prior synthetic turn' },
    }) + '\n'
  );
  state
    .prepare("INSERT INTO threads VALUES (?,?,'','',?,'vscode',0,?,?,NULL)")
    .run(id, id, join(run, 'workspace'), at - 60000, rollout);
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
      if (call.method === 'turn/start') {
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
              content: [{ type: 'input_text', text: input }],
            },
          }) + '\n',
          { flag: 'a' }
        );
      }
      const result =
        call.method === 'thread/turns/list'
          ? { data: [] }
          : call.method === 'thread/resume'
            ? { thread: { id: call.params.threadId, status: { type: 'idle' }, turns: [] } }
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
const starts = () => calls.filter((c) => c.method === 'turn/start').length;
const open = async () => {
  app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  if (process.argv.includes('--without-coding'))
    app.db.updateGlobalSettings({ neo: { packs: ['inbox-triage'] } });
  store = new NeoAskTodoRepository(app.db.getDatabase());
  sessions = new NeoTodoSessionRepository(app.db.getDatabase());
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
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
  app!.db.createSession({
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
  ask('flow');
  add('first', 'flow', 1);
  add('next', 'flow', 2, 'flow');
  ask('blocked');
  const blocked = add('held', 'blocked', 5);
  store.updateTodo(
    blocked,
    { state: 'blocked', blockedBy: 'question', blockedReason: 'Synthetic question', report },
    at
  );
  store.askQuestion(
    'hold',
    'blocked',
    {
      text: 'Synthetic blocker',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Yes',
      startTodos: null,
      confirm: null,
    },
    at
  );
  add('after-held', 'blocked', 6, 'blocked');
  ask('removed');
  const removed = add('removed', 'removed', 1, 'blocked');
  store.updateTodo(removed, { report }, at);
  evidence.removalReceipt = await rpc('neo.todo.remove', {
    todoId: 'removed',
    reason: 'Synthetic explicit removal',
  });
  assert.equal((evidence.removalReceipt as any).ok, true);
  evidence.firstRefresh = await refresh();
  evidence.firstSnapshot = await rpc('neo.snapshot', {});
  evidence.initial = {
    first: store.getTodo('first')?.state,
    next: store.getTodo('next')?.state,
    starts: starts(),
  };
  if (mode === 'before') {
    assert.deepEqual(evidence.initial, { first: 'done', next: 'todo', starts: 0 });
    console.log('REPRODUCED: merged facts leave the next todo pending, with no worker dispatch.');
  } else {
    assert.deepEqual(evidence.initial, { first: 'done', next: 'doing', starts: 1 });
    const workerInput = JSON.stringify(calls.find((call) => call.method === 'turn/start'));
    evidence.workerRuleDelivered = workerInput;
    assert(workerInput.includes('10. Write PR descriptions and issues for a person to read in 30 seconds.'));
    assert(workerInput.includes('Your full report (rule 9) goes to Neo, not into the PR.'));
    assert(workerInput.includes('In a public repo: no local paths, machine names, session ids or private repo names.'));
    assert(workerInput.includes('An issue states the problem and what done looks like, in a few sentences.'));

    await refresh();
    assert.equal(starts(), 1);
    store.askQuestion(
      'running-question',
      'flow',
      {
        text: 'A question about later work',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Yes',
        startTodos: null,
      },
      Date.now()
    );
    const rollout = join(run, 'home/.codex/flow.jsonl');
    writeFileSync(
      rollout,
      JSON.stringify({
        timestamp: new Date(Date.now() + 1000).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: 'Synthetic report after question' },
      }) + '\n',
      { flag: 'a' }
    );
    const threadState = new Database(join(run, 'home/.codex/state_5.sqlite'));
    threadState
      .prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?')
      .run(Date.now() + 1000, 'flow');
    threadState.close();
    ws!.close();
    await app!.cleanup();
    app = undefined;
    await open();
    await refresh();
    evidence.runningQuestion = {
      state: store.getTodo('next')?.state,
      report: store.getTodo('next')?.report,
    };
    assert.equal(store.getTodo('next')?.state, 'doing');
    assert.equal(sessions.readSent('next')?.receipt, undefined);
    assert.equal(store.getTodo('next')?.report, null);
    assert.equal(starts(), 1);
    ask('race');
    add('race-close', 'race', 7);
    fixture[url(7)].pause = true;
    writeFileSync(join(run, 'prs.json'), JSON.stringify(fixture));
    const closing = rpc('neo.todo.close', {
      todoId: 'race-close',
      reason: 'Merged during report update',
    });
    const deadline = Date.now() + 15000;
    while (!existsSync(join(run, 'read-started'))) {
      assert(Date.now() < deadline, 'fact read did not reach the upstream stub');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const concurrent = store.getTodo('race-close')!;
    store.updateTodo(concurrent, { report }, concurrent.updatedAt + 1);
    writeFileSync(join(run, 'read-release'), '');
    evidence.concurrentClose = await closing;
    assert.equal((evidence.concurrentClose as any).todo.state, 'done');
    assert.equal(store.getTodo('race-close')?.report, report);
    fixture[url(2)].state = 'MERGED';
    fixture[url(2)].mergedAt = new Date().toISOString();
    writeFileSync(join(run, 'prs.json'), JSON.stringify(fixture));
    evidence.finalReceipt = await rpc('neo.todo.close', {
      todoId: 'next',
      reason: 'Synthetic final merge',
    });
    assert.equal((evidence.finalReceipt as any).ok, true);
    assert.equal(starts(), 1);
    ask('restart');
    const completed = add('persisted-done', 'restart', 3);
    store.updateTodo(completed, { state: 'done', evidence: 'Persisted merge', report }, at);
    add('after-restart', 'restart', 4, 'restart');
    ws!.close();
    await app!.cleanup();
    app = undefined;
    await open();
    evidence.restartRefresh = await refresh();
    await refresh();
    evidence.restartSnapshot = await rpc('neo.snapshot', {});
    assert.equal(store.getTodo('after-restart')?.state, 'doing');
    assert.equal(starts(), 2);
    assert.equal(store.getTodo('held')?.state, 'blocked');
    assert.equal(store.getTodo('after-held')?.state, 'blocked');
    assert.equal(store.getTodo('removed')?.state, 'removed');
    assert.equal(store.getTodo('removed')?.report, report);
    assert.equal(store.getTodo('persisted-done')?.report, report);
    if (process.argv.includes('--lifecycle')) {
      ask('lifecycle');
      add('question-todo', 'lifecycle', 6);
      const question = await rpc('neo.question.ask', { askId: 'lifecycle', todoId: 'question-todo', kind: 'reply', text: 'Choose the synthetic implementation?' });
      evidence.todoQuestion = question;
      const general = await rpc('neo.question.ask', { askId: 'lifecycle', kind: 'reply', text: 'General synthetic ask question?' });
      assert.equal(question.question.todoId, 'question-todo');
      await rpc('neo.todo.remove', { todoId: 'question-todo', reason: 'Synthetic plan item no longer needed' });
      await refresh();
      evidence.retiredQuestion = await rpc('neo.question.get', { questionId: question.question.id });
      assert.equal(evidence.retiredQuestion.question.state, 'retired');
      evidence.generalQuestion = await rpc('neo.question.get', { questionId: general.question.id });
      assert.equal(evidence.generalQuestion.question.state, 'open');
      const failed = store.getTodo('after-restart')!;
      store.updateTodo(failed, { state: 'failed', reason: 'Synthetic worker failure' }, Date.now());
      const previousInputs = sessions.inputs.list(failed.id);
      const beforeRetry = starts();
      evidence.retryReceipt = await rpc('neo.todo.retry', { todoId: failed.id });
      assert.equal(evidence.retryReceipt.ok, true);
      assert.equal(evidence.retryReceipt.todo.id, failed.id);
      assert.equal(evidence.retryReceipt.todo.state, 'doing');
      assert.equal(starts(), beforeRetry + 1);
      const retriedInputs = sessions.inputs.list(failed.id);
      assert.equal(retriedInputs.length, previousInputs.length + 1);
      assert.deepEqual(retriedInputs.slice(0, previousInputs.length), previousInputs);
      assert.notEqual(retriedInputs.at(-1)?.id, previousInputs.at(-1)?.id);
      assert.equal(sessions.readRetries(failed.id), 1);
      ws!.close(); await app!.cleanup(); app = undefined; await open();
      evidence.lifecycleSnapshot = await rpc('neo.snapshot', {});
      const lifecycleAsk = evidence.lifecycleSnapshot.todoAsks.find((group: any) => group.ask.id === 'lifecycle');
      assert.equal(lifecycleAsk.questions.find((card: any) => card.id === question.question.id)?.state, 'retired');
      assert.equal(lifecycleAsk.questions.find((card: any) => card.id === general.question.id)?.state, 'open');
      const retryAsk = evidence.lifecycleSnapshot.todoAsks.find((group: any) => group.ask.id === 'restart');
      assert.equal(retryAsk.todos.find((todo: any) => todo.id === failed.id)?.state, 'doing');
      assert.equal(store.getTodo(failed.id)?.state, 'doing');
      assert.equal(store.getQuestion(question.question.id)?.state, 'retired');
      assert.equal(sessions.inputs.list(failed.id).length, retriedInputs.length);
      console.log('PASS: todo question retired, general question open, same todo retried with a new durable input, ownership and attempts survive restart.');
      evidence.lifecycle = { sameTodo: failed.id, inputs: retriedInputs.map(input => input.id), retries: sessions.readRetries(failed.id), starts: starts() };
    }
    evidence.observed = {
      states: store.listTodos('restart').map((t) => ({ id: t.id, state: t.state })),
      starts: starts(),
      removedReportHash: hash(store.getTodo('removed')!.report!),
    };
    console.log(
      'PASS: stored plan advances via actual Codex turn/start once, final step does not dispatch, restart recovers once, blocked/removed and report bytes preserved.'
    );
  }
} finally {
  ws?.close();
  await app?.cleanup();
  peer.stop(true);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
