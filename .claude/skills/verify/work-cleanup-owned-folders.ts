process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { getDataDir } from '../../../packages/daemon/src/lib/data-dir.ts';
import { cleanupOwnedWorktree } from '../../../packages/daemon/src/lib/drivers/work-placement.ts';
import { prepareCodingExecution } from '../../../packages/daemon/src/lib/neo/packs/coding/prepare-execution.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordWorkerStarted } from '../../../packages/daemon/src/storage/repositories/work-started-sessions-worker.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Proof', '-c', 'user.email=proof@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const source = join(run, 'source');
const origin = join(run, 'origin.git');
mkdirSync(source);
git(run, 'init', '-q', '--bare', '-b', 'dev', origin);
git(source, 'init', '-q', '-b', 'dev');
git(source, 'commit', '-q', '--allow-empty', '-m', 'initial');
git(source, 'remote', 'add', 'origin', origin);
git(source, 'push', '-q', '-u', 'origin', 'dev');
const evidence: Record<string, unknown> = {};

const effects = {
  run: async (command: readonly string[], directory: string) => {
    const result = spawnSync(command[0], command.slice(1), { cwd: directory, env: gitEnv, encoding: 'utf8' });
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  },
};
const desktopRoot = join(getDataDir(), 'claude-worktrees');
const prepare = async (name: string) => {
  const destination = join(desktopRoot, 'source', name);
  const prepared = await prepareCodingExecution({ directory: source, destination, parameters: { target: 'dev' } }, effects);
  assert.ok(prepared.ok, JSON.stringify(prepared));
  return destination;
};
const published = await prepare('published');
git(published, 'switch', '-q', '-c', 'worker-branch');
git(published, 'commit', '-q', '--allow-empty', '-m', 'worker work');
git(published, 'push', '-q', 'origin', 'worker-branch');
const unpublished = await prepare('unpublished');
git(unpublished, 'switch', '-q', '-c', 'local-only');
git(unpublished, 'commit', '-q', '--allow-empty', '-m', 'never pushed');
git(unpublished, 'switch', '-q', '--detach', 'origin/dev');
evidence.publishedClone = await cleanupOwnedWorktree(published, [desktopRoot]);
evidence.unpublishedClone = await cleanupOwnedWorktree(unpublished, [desktopRoot]);
assert.deepEqual(evidence.publishedClone, { directory: published, removed: true });
assert.equal(existsSync(published), false);
assert.equal((evidence.unpublishedClone as { removed: boolean }).removed, false);
assert.equal(git(unpublished, 'log', '-1', '--format=%s', 'local-only'), 'never pushed');

const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0,
  dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'home') }), disableGoalProcessing: true }, verbose: false });
await app.spaceRuntimeService.ready();
const raw = app.db.getDatabase();
const children: ReturnType<typeof spawn>[] = [];
try {
  assert.notEqual(app.server.port, 8399);
  const manager = app.sessionManager.getWorktreeManager();
  const workers = { clean: crypto.randomUUID(), unsaved: crypto.randomUUID(), busy: crypto.randomUUID() };
  const trees: Record<string, NonNullable<Awaited<ReturnType<typeof manager.createWorktree>>>> = {};
  const now = new Date().toISOString();
  for (const [key, id] of Object.entries(workers)) {
    const tree = await manager.createWorktree({ sessionId: id, repoPath: source });
    assert.ok(tree);
    trees[key] = tree;
    await app.db.createSession({ id, title: 'Cleanup proof', workspacePath: tree.worktreePath, worktree: tree,
      createdAt: now, lastActiveAt: now, status: 'active', config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
      metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  }
  writeFileSync(join(trees.unsaved.worktreePath, 'draft.txt'), 'unsaved work');
  const busy = spawn('sleep', ['120'], { cwd: trees.busy.worktreePath, stdio: 'ignore' });
  children.push(busy);
  const todos = new NeoAskTodoRepository(raw);
  const sessions = new NeoTodoSessionRepository(raw);
  const ask = todos.openAsk({ id: 'cleanup', sessionId: `neo:${crypto.randomUUID()}`, projectId: null, originMessageId: null,
    title: 'Cleanup proof', request: 'Cleanup proof', createdAt: Date.now() });
  for (const [key, id] of Object.entries(workers)) {
    recordWorkerStarted(raw, { adapter: 'hyperneo', id });
    const todo = todos.addTodo(`todo-${key}`, ask.id, { title: `Finished ${key}`, doneWhen: 'Done', instruction: null, named: null, check: null }, Date.now());
    sessions.create(todo.id, { verb: 'start', adapter: 'hyperneo' });
    raw.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'hyperneo', id }), todo.id);
    todos.updateTodo(todo, { state: 'done', finishedAt: Date.now() }, Date.now());
  }
  const refreshNow = () => raw.prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'").run(Date.now());
  const released = (todoId: string) => raw.prepare("SELECT 1 FROM pack_facts WHERE pack = 'core' AND key = 'released' AND todo_id = ?").all(todoId).length;
  refreshNow();
  const status = async (id: string) => (await app.db.getSession(id))?.status;
  const deadline = Date.now() + 60_000;
  const branchLeft = () => git(source, 'branch', '--list', trees.clean.branch);
  while (((await status(workers.clean)) !== 'archived' || (await status(workers.busy)) !== 'archived' || existsSync(trees.clean.worktreePath) || branchLeft()) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 500));
  evidence.cleanWorker = { status: await status(workers.clean), folderExists: existsSync(trees.clean.worktreePath),
    branch: branchLeft() };
  evidence.unsavedWorker = { status: await status(workers.unsaved), folderExists: existsSync(trees.unsaved.worktreePath) };
  assert.deepEqual(evidence.cleanWorker, { status: 'archived', folderExists: false, branch: '' });
  assert.deepEqual(evidence.unsavedWorker, { status: 'active', folderExists: true });
  evidence.busyWorkerWhileRunning = { status: await status(workers.busy), folderExists: existsSync(trees.busy.worktreePath), released: released('todo-busy') };
  assert.deepEqual(evidence.busyWorkerWhileRunning, { status: 'archived', folderExists: true, released: 0 });
  busy.kill();
  await new Promise((done) => busy.once('exit', done));
  const retryDeadline = Date.now() + 60_000;
  while ((existsSync(trees.busy.worktreePath) || !released('todo-busy')) && Date.now() < retryDeadline) {
    refreshNow();
    await new Promise((done) => setTimeout(done, 500));
  }
  evidence.busyWorkerAfterExit = { status: await status(workers.busy), folderExists: existsSync(trees.busy.worktreePath), released: released('todo-busy') };
  assert.deepEqual(evidence.busyWorkerAfterExit, { status: 'archived', folderExists: false, released: 1 });
  console.log('PASS: a published prepared clone under claude-worktrees is removed and an unpublished one kept; the daemon refresh job archived a finished todo\'s HyperNeo worker and removed its placed worktree and branch, kept the worker with unsaved work, and kept a busy worker\'s worktree without recording a release until a later refresh removed it after the process exited.');
} finally {
  for (const child of children) child.kill();
  writeFileSync(join(run, 'evidence/work-cleanup-owned-folders.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
