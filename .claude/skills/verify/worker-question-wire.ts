import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app = await createDaemonApp({ config, verbose: false });
const receipts: unknown[] = [];
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  receipts.push({ name, result });
  return result.reply.value ?? result.reply;
}
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  for (const id of ['synthetic-neo', 'synthetic-worker'])
    db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, ?, ?, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', 'active', '{}', '{}')`).run(id, id, join(run, 'workspace'));
  new NeoRepository(db).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({ id: 'synthetic-ask', sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Build', createdAt: 1 });
  const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Build', doneWhen: 'Built', instruction: 'Stay quiet. No routine progress pings.', check: null, named: null }, 1);
  sessions.create(todo.id, { verb: 'start', adapter: 'hyperneo', place: { machine: 'test', name: 'Synthetic' } });
  sessions.recordRef(todo.id, ref, 2);
  store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  const input = { to: 'synthetic-neo', from: 'session:synthetic-worker', kind: 'blocked', text: 'Original worker blocker', question: { todoId: todo.id, title: 'Choose a destination', options: ['Staging', 'Production'], language: 'en' } };
  const first = await rpc('message.send', input);
  assert.equal(first.kind, 'accepted');
  const question = store.listQuestions(todo.askId)[0];
  assert(question, 'message.send must create a human card before returning');
  assert.equal(store.getTodo(todo.id)?.blockedBy, 'needs-human');
  assert.equal(question.document, input.text);
  assert.equal(question.sourceSession?.id, ref.id);
  for (let i = 0; i < 8; i++) assert.deepEqual(await rpc('message.send', { ...input, text: `Repeat ${i}` }), first);
  const wakes = () => app.db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': 'synthetic-neo' });
  assert.equal(wakes().length, 1);
  const wake = wakes()[0];
  app.db.getJobQueueRepo().complete(wake.id, {});
  assert.deepEqual(await rpc('message.send', { ...input, kind: 'question' }), first);
  assert.equal(wakes().length, 0, 'consuming a wake must not allow repeats to create another');
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.deepEqual(await rpc('message.send', input), first);
  const restored = new NeoAskTodoRepository(app.db.getDatabase());
  const links = new NeoTodoSessionRepository(app.db.getDatabase());
  assert.equal(restored.listQuestions(todo.askId).length, 1);
  assert.equal(wakes().length, 0);
  const reminders: string[] = [];
  const runner = createNeoTodoRunner({ store: restored, sessions: links, packs: () => [], changed: () => {},
    invoke: async (_caller, name) => { reminders.push(name); return { kind: 'completed', value: { ok: true, value: { ref, title: 'Stopped', place: { machine: 'test', name: 'Test' }, status: 'stopped', lastActivityAt: 1 } } }; },
    tell: async () => { reminders.push('tell'); },
  });
  await runner.refresh((message, error) => { throw new Error(`${message}: ${error}`); });
  assert(!reminders.includes('work.send'));
  assert(!reminders.includes('tell'));
  const read = await rpc('neo.question.get', { questionId: question.id });
  assert.equal(read.question.state, 'open');
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ receipts, question, hold: restored.getTodo(todo.id), reminders, consumedWakeId: wake.id, restartRetained: true }, null, 2));
  console.log('PASS: message.send immediately creates a held card; repeats and restart share one consumed wake; held todo receives no runner nudge');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
