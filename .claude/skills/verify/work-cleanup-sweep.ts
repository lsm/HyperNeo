process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { todoEvidenceFile, workerWorkLocations } from '../../../packages/daemon/src/lib/work-locations.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { recordWorkerStarted } from '../../../packages/daemon/src/storage/work-started-sessions.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const source = join(run, 'source');
mkdirSync(source);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git(source, 'init', '-q', '-b', 'dev');
const imported = spawnSync('git', ['fast-import', '--quiet'], { cwd: source, encoding: 'utf8',
  input: 'commit refs/heads/dev\ncommitter Proof <proof@example.com> 1700000000 +0000\ndata 7\nfixture\n\ndone\n' });
assert.equal(imported.status, 0, imported.stderr);
git(run, 'clone', '-q', '--bare', source, join(run, 'origin.git'));
git(source, 'remote', 'add', 'origin', join(run, 'origin.git'));
git(source, 'fetch', '-q', 'origin');
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0,
  dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'home') }), disableGoalProcessing: true }, verbose: false });
const evidence: Record<string, unknown> = {};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const raw = app.db.getDatabase();
  const root = `neo:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  raw.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(root, 'Synthetic Neo', 'general', join(run, 'home'), now, now, 'active', '{}', '{}');
  new NeoRepository(raw).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const trees: Record<string, string> = {};
  let todoWorker = '';
  for (const key of ['clean', 'unsaved', 'live', 'todo']) {
    const id = crypto.randomUUID();
    const tree = await app.sessionManager.getWorktreeManager().createWorktree({ sessionId: id, repoPath: source });
    assert.ok(tree);
    trees[key] = tree.worktreePath;
    await app.db.createSession({ id, title: `Sweep ${key}`, workspacePath: tree.worktreePath, worktree: tree,
      createdAt: now, lastActiveAt: now, status: key === 'live' || key === 'todo' ? 'active' : 'archived',
      config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
      metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
    if (key === 'todo' || key === 'unsaved') recordWorkerStarted(raw, { adapter: 'hyperneo', id });
    if (key === 'todo') todoWorker = id;
  }
  const todos = new NeoAskTodoRepository(raw);
  const ask = todos.openAsk({ id: 'sweep-ask', sessionId: root, projectId: null, originMessageId: null,
    title: 'Sweep proof', request: 'Retain active work', createdAt: Date.now() });
  const todo = todos.addTodo('sweep-todo', ask.id, { title: 'Finished worker', doneWhen: 'Done', instruction: null, named: null, check: null }, Date.now());
  new NeoTodoSessionRepository(raw).create(todo.id, { verb: 'start', adapter: 'hyperneo' });
  raw.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify({ adapter: 'hyperneo', id: todoWorker }), todo.id);
  todos.updateTodo(todo, { state: 'done', finishedAt: Date.now() }, Date.now());
  const retainedEvidence = [
    join(workerWorkLocations(trees.todo).evidence, 'result.md'), todoEvidenceFile(todo.id),
  ];
  for (const file of retainedEvidence) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'Retained completion evidence');
  }
  writeFileSync(join(trees.unsaved, 'draft.txt'), 'keep this draft');
  const unknown = join(run, 'data/worktrees/orphan');
  const humanCodex = join(run, 'home/.codex/worktrees/human/source');
  const humanClaude = join(source, '.claude/worktrees/human');
  for (const path of [unknown, humanCodex, humanClaude]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'keep.txt'), 'human or unknown');
  }
  const broken = join(run, 'data/projects/broken/worktrees');
  mkdirSync(join(run, 'data/projects/broken'), { recursive: true });
  writeFileSync(broken, 'not a directory');
  const rpc = () => new Promise<unknown>((resolveReply, reject) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), 'work.cleanup.sweep', '{}'], {
      env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
    });
    void Promise.all([new Response(child.stdout).text(), child.exited]).then(([text, code]) => {
      if (code !== 0) reject(new Error(`RPC exit ${code}: ${text}`));
      else resolveReply(JSON.parse(text));
    }, reject);
  });
  evidence.first = await rpc();
  const first = evidence.first as { reply: { removed: { directory: string; reason: string }[]; kept: Record<string, string[]> } };
  assert.deepEqual(first.reply.removed.toSorted((a, b) => a.directory.localeCompare(b.directory)), [
    { directory: trees.todo, reason: 'todo done' },
  ].toSorted((a, b) => a.directory.localeCompare(b.directory)));
  assert(first.reply.kept.error.includes(broken), 'listing failure is retained without aborting the sweep');
  assert.equal(existsSync(trees.clean), true, JSON.stringify(evidence.first));
  assert(first.reply.kept.not_started_by_us.includes(trees.clean));
  assert.equal(existsSync(trees.todo), false, JSON.stringify(evidence.first));
  assert(raw.prepare('SELECT released_at FROM work_started_sessions WHERE id = ?').get(todoWorker));
  assert(raw.prepare("SELECT 1 FROM pack_facts WHERE todo_id = ? AND pack = 'core' AND key = 'released'").get(todo.id));
  for (const path of [trees.unsaved, trees.live, unknown, humanCodex, humanClaude]) assert(existsSync(path), path);
  const receipt = JSON.stringify(evidence.first);
  assert(Object.entries(first.reply.kept).some(([reason, kept]) => reason.includes('changes') && kept.includes(trees.unsaved)), receipt);
  assert(receipt.includes('unknown'));
  assert(!receipt.includes(humanCodex));
  assert(!receipt.includes(humanClaude));
  evidence.second = await rpc();
  assert.equal(existsSync(trees.clean), true);
  assert((evidence.second as typeof first).reply.kept.not_started_by_us.includes(trees.clean));
  raw.prepare("UPDATE job_queue SET run_at = ? WHERE status = 'pending'").run(Date.now() + 2 * 86400000);
  const job = app.jobQueue.enqueue({ queue: 'work.cleanup.sweep', payload: {}, runAt: Date.now() });
  await app.jobProcessor.tick();
  await app.jobProcessor.stop();
  evidence.dailyJob = app.jobQueue.getJob(job.id);
  assert.equal(app.jobQueue.getJob(job.id)?.status, 'completed');
  const next = app.jobQueue.listJobs({ queue: 'work.cleanup.sweep', status: 'pending' });
  assert.equal(next.length, 1);
  assert(next[0].runAt >= Date.now() + 86300000);
  evidence.nextDailyAt = next[0].runAt;
  for (const file of retainedEvidence) assert.equal(readFileSync(file, 'utf8'), 'Retained completion evidence');
  evidence.retainedEvidence = retainedEvidence;
  evidence.mailbox = raw.prepare("SELECT payload FROM job_queue WHERE queue = 'neo_notes'").all();
  assert(JSON.stringify(evidence.mailbox).includes('Work cleanup:'), 'cleanup reaches the attention digest');
  evidence.retained = [trees.clean, trees.unsaved, trees.live, unknown, humanCodex, humanClaude].length;
  console.log('PASS: RPC removed one finished worker worktree; retained an unmarked archived worktree and 5 live, unsaved, unknown or human folders; attention digest delivered; repeat sweep and daily job completed with one next-day run scheduled.');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/work-cleanup-sweep.json'), JSON.stringify(evidence, null, 2));
}
