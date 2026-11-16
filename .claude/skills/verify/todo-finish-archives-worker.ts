process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0,
  dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'home') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
await app.spaceRuntimeService.ready();
const raw = app.db.getDatabase();
const evidence: Record<string, unknown> = {};
try {
  assert.notEqual(app.server.port, 8399);
  const now = new Date().toISOString();
  const workers = { released: crypto.randomUUID(), named: crypto.randomUUID() };
  for (const id of Object.values(workers)) await app.db.createSession({ id, title: 'Release proof', workspacePath: run,
    createdAt: now, lastActiveAt: now, status: 'active', config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const todos = new NeoAskTodoRepository(raw);
  const sessions = new NeoTodoSessionRepository(raw);
  const ask = todos.openAsk({ id: 'release', sessionId: `neo:${crypto.randomUUID()}`, projectId: null, originMessageId: null,
    title: 'Release proof', request: 'Release proof', createdAt: Date.now() });
  for (const [key, id] of Object.entries(workers)) {
    const todo = todos.addTodo(`todo-${key}`, ask.id, { title: `Finished ${key}`, doneWhen: 'Done', instruction: null, named: null, check: null }, Date.now());
    sessions.create(todo.id, { verb: 'start', adapter: 'hyperneo', ...(key === 'named' ? { name: 'Jason' } : {}) });
    raw.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'hyperneo', id }), todo.id);
    todos.updateTodo(todo, { state: 'done', finishedAt: Date.now() }, Date.now());
  }
  raw.prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'").run(Date.now());
  const status = async (id: string) => (await app.db.getSession(id))?.status;
  const deadline = Date.now() + 60_000;
  while ((await status(workers.released)) !== 'archived' && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 500));
  evidence.releasedStatus = await status(workers.released);
  evidence.namedStatus = await status(workers.named);
  evidence.releasedFacts = raw.prepare("SELECT todo_id, value_json FROM pack_facts WHERE pack = 'core' AND key = 'released'").all();
  assert.equal(evidence.releasedStatus, 'archived');
  assert.equal(evidence.namedStatus, 'active');
  assert.deepEqual((evidence.releasedFacts as { todo_id: string }[]).map((row) => row.todo_id), ['todo-released']);
  console.log('PASS: the daemon refresh job archived the worker a finished todo started, recorded it once, and kept the human-named worker active.');
} finally {
  writeFileSync(join(run, 'evidence/todo-release.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
