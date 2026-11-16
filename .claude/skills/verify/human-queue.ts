process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
const app = await createDaemonApp({ config, verbose: false });
const receipts: unknown[] = [];
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  receipts.push({ name, input, reply: result.reply });
  return result.reply.value ?? result.reply;
}
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('synthetic-neo', 'synthetic-neo', ?, '2026-11-16T00:00:00Z', '2026-11-16T00:00:00Z', 'active', '{}', '{}')`).run(join(run, 'workspace'));
  new NeoRepository(db).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  const store = new NeoAskTodoRepository(db);
  const ask = (id: string, createdAt: number) => store.openAsk({ id, sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: id, request: 'Synthetic request', createdAt });
  const todo = (id: string, askId: string, dependsOn: string[] = [], approvedAt: number | null = 1) => store.addTodo(id, askId, { approvedAt, title: `Title ${id}`, doneWhen: 'Done', instruction: null, check: null, named: null, dependsOn }, 1);
  const card = (id: string, askId: string, todoId: string) => store.askQuestion(id, askId, { text: `Question ${id}?`, kind: 'reply', options: null, multiple: false, noLabel: null, yesLabel: null, todoId }, 2);
  ask('ask-a', 1);
  ask('ask-b', 2);
  todo('asked', 'ask-a');
  todo('first', 'ask-a');
  todo('second', 'ask-a', ['first']);
  todo('aside', 'ask-b');
  todo('unapproved', 'ask-b', [], null);
  card('waiting-card', 'ask-a', 'asked');
  card('held-card', 'ask-b', 'aside');
  await rpc('neo.question.hold', { questionId: 'held-card', held: true, requestId: crypto.randomUUID() });
  const { humanQueue } = await rpc('neo.snapshot', {});
  const items = Object.fromEntries(humanQueue.items.map((item: { questionId?: string; todoId?: string }) => [item.questionId ?? item.todoId, item]));
  assert.deepEqual(Object.keys(items).sort(), ['first', 'held-card', 'second', 'unapproved', 'waiting-card'], 'covered todos appear only under their cards');
  assert.deepEqual(items['waiting-card'], { state: 'waiting', askId: 'ask-a', questionId: 'waiting-card', text: 'Question waiting-card?', todos: [{ id: 'asked', title: 'Title asked' }] });
  assert.equal(items['held-card'].state, 'held');
  assert.deepEqual(items.first, { state: 'progress', askId: 'ask-a', todoId: 'first', title: 'Title first', owner: 'neo' });
  assert.equal(items.second.owner, 'prerequisite', "a todo waiting on an unfinished prerequisite is the prerequisite's step");
  assert.equal(items.unapproved.owner, 'neo', 'an unapproved todo is Neo\'s to review');
  assert.deepEqual(humanQueue.counts, { 'ask-a': { waiting: 1, held: 0, progress: 2 }, 'ask-b': { waiting: 0, held: 1, progress: 1 } });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ receipts }, null, 2));
  console.log('PASS: the RPC snapshot lists the waiting card, the held card and each uncovered todo with its next-step owner (neo, prerequisite, unapproved is neo), counted by ask');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
