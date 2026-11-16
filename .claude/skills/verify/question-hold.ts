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
  store.openAsk({ id: 'synthetic-ask', sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Choose a deployment', createdAt: 1 });
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Deploy', doneWhen: 'Deployed', instruction: 'Deploy it', check: null, named: null }, 1);
  const card = store.askQuestion('synthetic-card', 'synthetic-ask', { text: 'Where should it deploy?', kind: 'choice', options: ['Staging', 'Production'], multiple: false, noLabel: null, yesLabel: null, todoId: todo.id }, 2);
  const needsYou = async () => (await rpc('neo.snapshot', {})).needsYou;
  const hold = (held: boolean, requestId: string = crypto.randomUUID()) => rpc('neo.question.hold', { questionId: card.id, held, requestId });
  assert.equal(await needsYou(), 1, 'an open card needs the human');
  const first = crypto.randomUUID();
  const held = await hold(true, first);
  assert.equal(held.ok, true, JSON.stringify(held));
  assert.equal(typeof held.question.heldAt, 'number');
  assert.equal((await hold(true)).question.heldAt, held.question.heldAt, 'holding again changes nothing');
  assert.equal(await needsYou(), 0, 'an ask whose only card is held does not need the human');
  assert.equal((await rpc('neo.question.get', { questionId: card.id })).question.heldAt, held.question.heldAt);
  const back = await hold(false);
  assert.equal(back.question.heldAt, undefined);
  assert.equal((await hold(false)).question.heldAt, undefined, 'taking back again changes nothing');
  assert.equal((await hold(true, first)).question.heldAt, undefined, 'a replayed hold after the take-back changes nothing');
  assert.equal(await needsYou(), 1, 'a card taken back needs the human again');
  await hold(true);
  const answered = await rpc('neo.question.answer', { questionId: card.id, answer: 'Staging' });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.equal(answered.question.state, 'answered');
  assert.equal(answered.question.heldAt, undefined, 'answering clears the hold');
  const refused = await hold(true);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /^question_closed:/);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ receipts }, null, 2));
  console.log('PASS: hold and take back over RPC, repeatable; a replayed hold is ignored; held card drops needsYou to 0; answer clears the hold; an answered card cannot be held');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
