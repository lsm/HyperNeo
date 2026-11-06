import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const d of ['home/.codex/ipc', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, d), { recursive: true });

const root = 'neo:10000000-0000-4000-8000-000000009700';
const ref = { adapter: 'codex-desktop', id: 'shared-thread' };
const url = 'https://github.com/synthetic/plan/pull/9';
const rollout = join(run, 'home/.codex/shared-thread.jsonl');
const at = Date.now();
let clock = at;
const realNow = Date.now;
Date.now = () => clock;
const entry = (value: unknown) => JSON.stringify(value) + '\n';

writeFileSync(
  join(run, 'bin/gh'),
  `#!${process.execPath}
const fs=require('node:fs'),root=${JSON.stringify(run)},args=process.argv.slice(2);
fs.appendFileSync(root+'/evidence/gh.log',JSON.stringify(args)+String.fromCharCode(10));
process.exit(2);
`,
  { mode: 0o700 }
);
writeFileSync(join(run, 'bin/ps'), '#!/bin/sh\nprintf "%s\\n" /Applications/Codex.app/Contents/MacOS/Codex\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/open'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
writeFileSync(
  rollout,
  entry({
    timestamp: new Date(at - 60000).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: 'Prior synthetic turn' },
  })
);
const state = new Database(join(run, 'home/.codex/state_5.sqlite'));
state.exec(
  'CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,updated_at_ms INTEGER);CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)'
);
state
  .prepare("INSERT INTO threads VALUES (?,?,'','',?,'vscode',0,?,?,NULL)")
  .run(ref.id, ref.id, join(run, 'workspace'), at - 60000, rollout);
state.close();

const frames: { method: string }[] = [];
const sockets = new Set<Socket>();
const peer = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const size = buffer.readUInt32LE(0);
      const call = JSON.parse(buffer.subarray(4, size + 4).toString());
      buffer = buffer.subarray(size + 4);
      frames.push(call);
      const response =
        call.method === 'initialize'
          ? { resultType: 'success', result: { clientId: 'fixture' } }
          : call.method === 'thread-owner-discovery'
            ? { resultType: 'success', handledByClientId: 'fixture-owner' }
            : call.method === 'thread-follower-steer-turn'
              ? { resultType: 'error', error: 'NoActiveTurn' }
              : call.method === 'thread-follower-start-turn'
                ? { resultType: 'success', result: { result: { turn: { id: 'nudged-turn' } } } }
                : { resultType: 'error', error: 'Unknown synthetic IPC request' };
      const body = Buffer.from(
        JSON.stringify({ type: 'response', requestId: call.requestId, ...response })
      );
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    }
  });
});
await new Promise<void>((done) => peer.listen(join(run, 'home/.codex/ipc/ipc.sock'), done));

const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const job = async (queue: string) => {
  const queued = app.jobQueue.enqueue({ queue, payload: { scope: 'neo' }, runAt: realNow() });
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const current = app.jobQueue.getJob(queued.id)!;
    if (current.status === 'completed') return;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`${queue} did not complete`);
};
const evidence: Record<string, unknown> = { daemonPort: app.server.port };
try {
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const prs = new CodingTodoPrRepository(db);
  app.db.createSession({
    id: root,
    title: 'Synthetic send owner',
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
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  store.openAsk({
    id: 'ask',
    title: 'Shared worker',
    request: 'Synthetic work on one worker',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: at,
  });
  for (const id of ['feature', 'docs']) {
    const todo = store.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'Merged',
        check: { pack: 'coding', kind: 'pr_merged', params: id === 'feature' ? { urls: [url] } : {} },
        instruction: `Do ${id}`,
        named: null,
      },
      at
    );
    sessions.create(id, { verb: 'send', ref });
    sessions.recordRef(id, ref, at);
    store.updateTodo(todo, { state: 'doing', startedAt: at, report: `${id} report` }, at);
  }
  prs.record('feature', [{ url, state: 'OPEN', createdAt: at } as never], at);
  const last = await sessions.inputs.accept('docs', root, { verb: 'send', ref }, 'Docs PR', at);
  await sessions.inputs.recordOutcome(last, { ref }, at);
  db.prepare(
    "INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES ('proof','Synthetic','','',1,?,?)"
  ).run(at, at);
  db.prepare(
    "INSERT INTO neo_project_workspaces(alias,project_id) VALUES ('repo:synthetic/plan','proof')"
  ).run();

  db.prepare(
    "UPDATE neo_pack_preferences SET value_json = ? WHERE pack = 'coding' AND key = 'watchedRepos'"
  ).run(JSON.stringify(['synthetic/plan']));
  db.prepare(
    `INSERT INTO pack_coding_pr_ledger
      (repo, number, title, branch, head, state, state_since, owner, nudges, read_at, created_at, author_is_bot)
      VALUES ('synthetic/plan', 9, 'Synthetic feature PR', 'synthetic', ?, 'changes_requested', ?, ?, 0, ?, ?, 1)`
  ).run('a'.repeat(40), at - 25 * 60000, JSON.stringify(ref), at, at - 30 * 60000);
  clock += 1000;
  await job('neo.pack.sweep');
  const row = db
    .prepare(
      "SELECT todo_id AS todoId, outcome FROM work_delivery_inputs WHERE message LIKE '%requested changes%'"
    )
    .get() as { todoId: string; outcome: string } | null;
  assert(row, 'the PR nudge must be recorded');
  assert.equal(row.todoId, 'feature', 'the nudge belongs to the todo that holds the PR');
  evidence.nudge = { todoId: row.todoId, outcome: JSON.parse(row.outcome) };

  clock += 1000;
  const turnAt = new Date(clock).toISOString();
  appendFileSync(
    rollout,
    entry({
      timestamp: turnAt,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'nudged-turn' },
    }) +
      entry({
        timestamp: turnAt,
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'nudged-turn',
          last_agent_message: 'Fixed nothing yet.\n\nBlocked (needs_human): choose the CI fix.',
        },
      })
  );
  clock += 1000;
  await job('neo.work.driver.refresh');
  const docs = store.getTodo('docs')!;
  const feature = store.getTodo('feature')!;
  evidence.todos = {
    docs: { state: docs.state, report: docs.report },
    feature: { state: feature.state, blockedBy: feature.blockedBy, reason: feature.blockedReason },
  };
  assert.equal(docs.state, 'doing');
  assert.equal(docs.report, 'docs report', 'the nudged turn must not touch the other todo');
  assert.equal(feature.state, 'blocked');
  assert.equal(feature.blockedBy, 'needs-human');
  assert.equal(feature.blockedReason, 'choose the CI fix.');

  const sent = frames.length;
  const refused = await invokeOperation(
    app.sessionManager.getOperationRegistry(),
    'work.send',
    { ref, message: 'No purpose' },
    { source: 'internal', role: 'neo', sessionId: root }
  );
  assert.equal(frames.length, sent, 'a refused send reaches no worker');
  assert.match(JSON.stringify(refused), /todo_required/);
  evidence.refused = refused;
  evidence.verified = true;
  console.log(
    'VERIFIED: a real PR nudge is recorded under the todo holding the PR; its blocker lands there, not on the last todo; a Neo send with no purpose is refused unsent'
  );
} finally {
  Date.now = realNow;
  await app.cleanup();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((done, fail) => peer.close((error) => (error ? fail(error) : done())));
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
