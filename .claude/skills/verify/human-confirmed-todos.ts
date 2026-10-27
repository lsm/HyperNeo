import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import type { NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const evidence: unknown[] = [];
const dispatches: string[] = [];
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const owner = 'neo:10000000-0000-4000-8000-000000009097';
async function rpc(name: string, input: unknown): Promise<Record<string, unknown>> {
  assert(ws);
  const id = crypto.randomUUID();
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 10000);
    ws!.onmessage = ({ data }) => {
      const reply = JSON.parse(String(data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data.value ?? reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke',
      data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1',
    dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), verbose: false });
  assert(app.server.port > 0 && app.server.port !== 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await app.db.createSession({ id: owner, title: 'Synthetic human confirmation',
    workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  new NeoRepository(db).reserveBinding({ sessionId: owner, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db), sessions = new NeoTodoSessionRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  app.sessionManager.setOperationRegistryProvider(() => createOperationRegistry(registry.entries.map(
    entry => ['work.send', 'work.status'].includes(entry.name) ? { ...entry, execute: async input => {
      const ref = (input as { ref: { adapter: string; id: string } }).ref;
      if (entry.name === 'work.send') dispatches.push(ref.id);
      return { ok: true, value: { delivered: true, ref, status: 'running', lastActivityAt: 1 } };
    } } : entry
  )));
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WebSocket failed')); });
  for (const [index, kind, chat, answer, state] of [
    [0, 'yesno', false, 'yes', 'todo'],
    [1, 'choice', false, ['Delete the approved synthetic leftovers'], 'blocked'],
    [2, 'reply', true, 'The synthetic plan is approved.', 'doing'],
    [3, 'yesno', true, 'Yes, go ahead with this plan.', 'failed'],
    [4, 'yesno', false, 'no', 'closed_unverified'],
    [5, 'yesno', true, 'no', 'todo'],
  ] as const) {
    const askId = `ask-${index}`, id = `approval-${index}`, questionId = `question-${index}`, next = `next-${index}`;
    store.openAsk({ id: askId, sessionId: owner, projectId: null, originMessageId: null,
      title: 'Synthetic approval', request: 'Confirm and advance', createdAt: 1 });
    const approval = store.addTodo(id, askId, { title: 'Human decides', doneWhen: 'Human confirms', instruction: null, named: null,
      check: { pack: 'core', kind: 'human_confirmed', params: { questionId } } }, 1);
    store.askQuestion(questionId, askId, { text: 'Approve synthetic work?', kind,
      options: kind === 'choice' ? ['Keep everything', 'Delete the approved synthetic leftovers'] : null,
      multiple: false, noLabel: 'No', yesLabel: 'Yes', startTodos: null, todoId: id }, 2);
    store.addTodo(next, askId, { title: 'Run the next synthetic step', doneWhen: 'Synthetic output exists',
      instruction: 'Record a synthetic successor dispatch; delete nothing.', named: null,
      check: { pack: 'core', kind: 'evidence', params: { path: join(run, next) } } }, 3);
    sessions.create(next, { verb: 'send', ref: { adapter: 'hyperneo', id: next } });
    store.updateTodo(approval, { state }, 4);
    assert.equal(store.getTodo(id)?.state, state);
    const receipt = chat
      ? await rpc('neo.message.send', { sessionId: owner, requestId: crypto.randomUUID(), content: answer,
          replyTo: { kind: 'question', id: questionId } })
      : await rpc('neo.question.answer', { questionId, answer });
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    const deadline = Date.now() + 5000;
    let view: { todos: NeoTodo[] };
    do {
      view = (await rpc('neo.ask.read', { askId })).entry as { todos: NeoTodo[] };
      if (view.todos.find(todo => todo.id === next)?.state === 'doing') break;
      assert(Date.now() < deadline, 'Answer must finish the queued todo and start its successor without a scheduled refresh');
      await new Promise(done => setTimeout(done, 10));
    } while (true);
    assert.equal(view.todos.find(todo => todo.id === id)?.state, 'done');
    assert.equal(view.todos.find(todo => todo.id === next)?.state, 'doing');
    assert.equal(dispatches.filter(value => value === next).length, 1);
    evidence.push({ kind, chat, answer, state, view });
  }
  evidence.push({ dispatches, verified: true });
  console.log('PASS: real answer and chat RPCs complete recorded decisions across all checkable states and dispatch successors once.');
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/human-confirmed-todos.json'), JSON.stringify(evidence, null, 2));
}
