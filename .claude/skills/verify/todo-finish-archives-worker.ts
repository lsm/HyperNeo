process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordWorkerStarted, readFreeWorkers } from '../../../packages/daemon/src/storage/work-started-sessions.ts';

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
  const workers = { released: crypto.randomUUID(), named: crypto.randomUUID(), neoNamed: crypto.randomUUID(), unsaved: crypto.randomUUID(), removed: crypto.randomUUID(), existing: crypto.randomUUID() };
  const unsaved = join(run, 'unsaved');
  mkdirSync(unsaved);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Proof', '-c', 'user.email=proof@example.com', ...args], { cwd: unsaved, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(unsaved, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-q', '--no-gpg-sign', '-m', 'a');
  writeFileSync(join(unsaved, 'draft.txt'), 'draft');
  for (const [key, id] of Object.entries(workers)) await app.db.createSession({ id, title: 'Release proof', workspacePath: key === 'unsaved' || key === 'existing' ? unsaved : run,
    createdAt: now, lastActiveAt: now, status: 'active', config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const todos = new NeoAskTodoRepository(raw);
  const sessions = new NeoTodoSessionRepository(raw);
  const ask = todos.openAsk({ id: 'release', sessionId: `neo:${crypto.randomUUID()}`, projectId: null, originMessageId: null,
    title: 'Release proof', request: 'Release proof', createdAt: Date.now() });
  for (const [key, id] of Object.entries(workers)) {
    if (key !== 'existing') recordWorkerStarted(raw, { adapter: 'hyperneo', id });
    const todo = todos.addTodo(`todo-${key}`, ask.id, { title: `Finished ${key}`, doneWhen: 'Done', instruction: null, named: key === 'named' ? { session: 'Jason' } : null, check: null }, Date.now());
    sessions.create(todo.id, { verb: 'start', adapter: 'hyperneo', ...(key === 'named' ? { name: 'Jason' } : key === 'neoNamed' ? { name: 'dev-6' } : {}) });
    raw.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'hyperneo', id }), todo.id);
    todos.updateTodo(todo, key === 'removed' ? { state: 'removed' } : { state: 'done', finishedAt: Date.now() }, Date.now());
  }
  raw.prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'").run(Date.now());
  const status = async (id: string) => (await app.db.getSession(id))?.status;
  const deadline = Date.now() + 60_000;
  while (((await status(workers.released)) !== 'archived' || (await status(workers.removed)) !== 'archived' || (await status(workers.neoNamed)) !== 'archived') && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 500));
  evidence.releasedStatus = await status(workers.released);
  evidence.namedStatus = await status(workers.named);
  evidence.neoNamedStatus = await status(workers.neoNamed);
  evidence.unsavedStatus = await status(workers.unsaved);
  evidence.removedStatus = await status(workers.removed);
  evidence.existingStatus = await status(workers.existing);
  evidence.releasedWorkers = raw.prepare('SELECT id FROM work_started_sessions WHERE released_at IS NOT NULL ORDER BY id').all();
  raw.prepare('UPDATE work_started_sessions SET unusable_at = NULL').run();
  evidence.freeLaterThanAnHour = [...readFreeWorkers(raw, 'hyperneo')].sort();
  evidence.releasedFacts = raw.prepare("SELECT todo_id, value_json FROM pack_facts WHERE pack = 'core' AND key = 'released'").all();
  assert.equal(evidence.releasedStatus, 'archived');
  assert.equal(evidence.namedStatus, 'active');
  assert.equal(evidence.neoNamedStatus, 'archived');
  assert.equal(evidence.unsavedStatus, 'active');
  assert.equal(evidence.removedStatus, 'archived');
  assert.equal(evidence.existingStatus, 'active');
  assert.equal(raw.prepare('SELECT 1 FROM work_started_sessions WHERE adapter = ? AND id = ?').get('hyperneo', workers.existing), null);
  assert.deepEqual((evidence.releasedWorkers as { id: string }[]).map((row) => row.id), [workers.released, workers.neoNamed, workers.removed].sort());
  assert.ok(!(evidence.freeLaterThanAnHour as string[]).some((id) => id === workers.released || id === workers.neoNamed || id === workers.removed));
  assert.deepEqual((evidence.releasedFacts as { todo_id: string }[]).map((row) => row.todo_id).sort(), ['todo-existing', 'todo-named', 'todo-neoNamed', 'todo-released', 'todo-removed']);
  assert.deepEqual(JSON.parse((evidence.releasedFacts as { todo_id: string; value_json: string }[]).find((row) => row.todo_id === 'todo-existing')!.value_json), { kept: 'not_started_by_us' });
  console.log('PASS: the daemon refresh job archived the workers finished and removed todos started (one only Neo named), fenced them against reuse with no expiry, recorded each once, and kept the human-named worker and the worker with unsaved work active.');
} finally {
  writeFileSync(join(run, 'evidence/todo-release.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
