process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { neoFolder } from '../../../packages/daemon/src/lib/neo/folder.ts';
import { CodingTurnPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/turn-prs.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { WorkTurnRepository } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
const codexHome = join(run, 'home/.codex');
for (const dir of [join(codexHome, 'app-server-control'), join(run, 'project'), join(run, 'evidence'), join(run, 'bin')])
  mkdirSync(dir, { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/open'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });

const base = Date.now() - 600_000;
const stamp = (second: number) => new Date(base + second * 1000).toISOString();
const line = (second: number, type: string, payload: object) =>
  `${JSON.stringify({ timestamp: stamp(second), type, payload })}\n`;
const started = (second: number, turn: string) =>
  line(second, 'event_msg', { type: 'task_started', turn_id: turn });
const completed = (second: number, turn: string, text: string) =>
  line(second, 'event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: text });
const said = (second: number, id: string, text: string) =>
  line(second, 'response_item', { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] });
const ran = (second: number, turn: string, text: string, clientId?: string) =>
  line(second, 'event_msg', {
    type: 'item_completed',
    thread_id: 'synthetic',
    turn_id: turn,
    item: {
      type: 'UserMessage',
      id: `item-${second}`,
      ...(clientId ? { client_id: clientId } : {}),
      content: [{ type: 'text', text, text_elements: [] }],
    },
  });

const rollout = join(run, 'data-rollout.jsonl');
writeFileSync(rollout, started(1, 'earlier') + said(2, 'msg_earlier', 'Earlier work') + completed(3, 'earlier', 'Done.'));
const codex = new Database(join(codexHome, 'state_5.sqlite'));
codex.exec(
  'CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,updated_at_ms INTEGER); CREATE TABLE project_roots (project_id TEXT,position INTEGER,path TEXT); CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)'
);
codex.prepare("INSERT INTO projects VALUES ('p','synthetic',1)").run();
codex.prepare("INSERT INTO project_roots VALUES ('p',0,?)").run(join(run, 'project'));
codex
  .prepare("INSERT INTO threads VALUES ('synthetic','synthetic','','',?,'vscode',0,?,?,NULL)")
  .run(join(run, 'project'), Date.now(), rollout);
const touch = () =>
  codex.prepare("UPDATE threads SET updated_at_ms = ? WHERE id = 'synthetic'").run(Date.now());

const evidence: Record<string, unknown> = { peer: [] as unknown[] };
const queued: { clientUserMessageId: string; text: string }[] = [];
const shared = Bun.serve({
  unix: join(codexHome, 'app-server-control/app-server-control.sock'),
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response('websocket only', { status: 400 });
  },
  websocket: {
    message(socket, data) {
      const message = JSON.parse(String(data));
      if (!('id' in message)) return;
      (evidence.peer as unknown[]).push(message.method);
      let result: unknown = {};
      if (message.method === 'thread/loaded/list') result = { data: ['synthetic'], nextCursor: null };
      if (message.method === 'permissionProfile/list')
        result = { data: [{ id: 'hyperneo-worker', allowed: true }] };
      if (message.method === 'thread/queue/add') {
        queued.push({
          clientUserMessageId: message.params.clientUserMessageId,
          text: message.params.input[0].text,
        });
        result = { queuedSubmission: { id: `queue-${queued.length}` } };
      }
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    },
  },
});

const sessionId = 'neo:10000000-0000-4000-8000-000000000003';
const ref = { adapter: 'codex-desktop', id: 'synthetic' };
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const sweep = async () => {
  const job = app.jobQueue.enqueue({ queue: 'neo.pack.sweep', payload: { scope: 'neo' }, runAt: Date.now() });
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const current = app.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('pack sweep did not complete');
};
try {
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase();
  const now = new Date().toISOString();
  await app.db.createSession({
    id: sessionId,
    title: 'Synthetic Neo',
    workspacePath: neoFolder(),
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  new NeoRepository(db).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  new NeoAskTodoRepository(db).openAsk({
    id: 'synthetic-ask', projectId: null, sessionId, originMessageId: null,
    title: 'Synthetic queued sends', request: 'Queue work on a Codex worker', createdAt: 1,
  });
  const handler = createOperationMcpHandler(
    () => app.sessionManager.getOperationRegistry(),
    () => ({ sessionId, role: 'neo' })
  );
  const invoke = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    const result = JSON.parse((reply.content[0] as { text: string }).text);
    (evidence[name] ??= [] as unknown[]) && (evidence[name] as unknown[]).push(result);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const sent = async (count: number) => {
    const deadline = performance.now() + 25000;
    while (performance.now() < deadline) {
      if (queued.length >= count && outcome(first.todo.id).length >= count && outcome(first.todo.id).every((row) => row))
        return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`queued sends: ${queued.length} of ${count}; peer ${JSON.stringify(evidence.peer)}`);
  };
  const outcome = (todoId: string) =>
    (db.prepare('SELECT outcome FROM work_delivery_inputs WHERE todo_id = ? ORDER BY rowid').all(todoId) as {
      outcome: string | null;
    }[]).map((row) => (row.outcome ? JSON.parse(row.outcome) : null));

  const first = await invoke('neo.todo.add', {
    after: [], askId: 'synthetic-ask', title: 'First queued work', doneWhen: 'Facts retained',
    check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing-proof') } },
    instruction: 'First queued instruction', target: { verb: 'send', ref },
  });
  assert.equal(first.todo.state, 'doing', JSON.stringify(first.todo));
  await sent(1);
  await invoke('neo.todo.continue', { todoId: first.todo.id, message: 'Second queued instruction' });
  await sent(2);
  const outcomes = outcome(first.todo.id);
  evidence.outcomes = outcomes;
  assert.deepEqual(
    outcomes.map((row) => row.delivery?.clientMessageId),
    queued.map((sent) => sent.clientUserMessageId),
    'each queued send keeps the client id it sent'
  );
  assert(outcomes.every((row) => row.delivery?.delivered === false && !row.receipt));
  console.log('PASS: each queued Codex send keeps the client message id it sent, with no guessed receipt');

  appendFileSync(
    rollout,
    started(10, 'turn-first') +
      said(11, 'msg_first', queued[0].text) +
      ran(12, 'turn-first', queued[0].text, queued[0].clientUserMessageId) +
      completed(13, 'turn-first', 'First done.') +
      started(14, 'turn-human') +
      said(15, 'msg_human', 'Typed by the human') +
      ran(16, 'turn-human', 'Typed by the human') +
      completed(17, 'turn-human', 'Human done.') +
      started(18, 'turn-second') +
      said(19, 'msg_second', queued[1].text) +
      ran(20, 'turn-second', queued[1].text, queued[1].clientUserMessageId) +
      completed(21, 'turn-second', 'Second done.')
  );
  touch();
  await sweep();
  const recorded = new WorkTurnRepository(db).list(ref);
  evidence.recorded = recorded.map(({ id, inputs }) => ({ id, inputs }));
  assert.deepEqual(
    recorded.map(({ id, inputs }) => [id, inputs]),
    [
      ['earlier', ['msg_earlier']],
      ['turn-first', ['msg_first', queued[0].clientUserMessageId]],
      ['turn-human', ['msg_human']],
      ['turn-second', ['msg_second', queued[1].clientUserMessageId]],
    ]
  );
  const own = new CodingTurnPrRepository(db).own(first.todo.id).map(({ id }) => id);
  evidence.own = own;
  assert.deepEqual(own, ['turn-first', 'turn-second']);
  console.log('PASS: the daemon records each client id with the turn it ran in, and those turns give the todo');
} finally {
  await app.cleanup();
  shared.stop(true);
  codex.close();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
