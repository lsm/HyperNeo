process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { workerWorkKey } from '../../../packages/daemon/src/lib/work-locations.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { recordWorkerStarted } from '../../../packages/daemon/src/storage/repositories/work-started-sessions-worker.ts';

const DAY = 86400000;
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
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const root = `neo:${crypto.randomUUID()}`;
  raw.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(root, 'Synthetic Neo', 'general', join(run, 'home'), iso, iso, 'active', '{}', '{}');
  new NeoRepository(raw).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(raw);
  todos.openAsk({ id: 'evidence-ask', sessionId: root, projectId: null, originMessageId: null,
    title: 'Evidence proof', request: 'Age evidence', createdAt: now });
  const folder = (name: string) => join(run, 'data/work/evidence', name);
  const todo = (id: string, finishedAt: number) => {
    const added = todos.addTodo(id, 'evidence-ask', { title: id, doneWhen: 'Done', instruction: null, named: null, check: null }, now);
    todos.updateTodo(added, { state: 'done', finishedAt }, finishedAt);
    mkdirSync(folder(id), { recursive: true });
    writeFileSync(join(folder(id), 'result.md'), `Evidence for ${id}`);
  };
  todo('old-todo', now - 8 * DAY);
  todo('fresh-todo', now - 2 * DAY);
  todo('cited-todo', now - 8 * DAY);
  todos.askQuestion('cited-card', 'evidence-ask', { kind: 'reply', options: null, multiple: false, noLabel: null, yesLabel: null, text: `Review ${folder('cited-todo')}/result.md` }, now);
  const gone = (name: string) => join(run, 'data/worktrees', name);
  const session = (id: string, path: string) => raw.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata,worktree_path)
    VALUES (?,?,?,?,?,'archived','{}','{}',?)`).run(id, id, path, iso, iso, path);
  session('old-worker', gone('old-worker'));
  session('new-worker', gone('new-worker'));
  for (const name of ['old-worker', 'new-worker']) {
    mkdirSync(folder(workerWorkKey(gone(name))), { recursive: true });
    writeFileSync(join(folder(workerWorkKey(gone(name))), 'result.md'), `Worker evidence for ${name}`);
  }
  raw.prepare('INSERT INTO work_cleanup_gone (key, gone_at) VALUES (?, ?)').run(workerWorkKey(gone('old-worker')), now - 8 * DAY);
  const id = crypto.randomUUID();
  const tree = await app.sessionManager.getWorktreeManager().createWorktree({ sessionId: id, repoPath: source });
  assert.ok(tree);
  await app.db.createSession({ id, title: 'Unsaved worker', workspacePath: tree.worktreePath, worktree: tree,
    createdAt: iso, lastActiveAt: iso, status: 'archived',
    config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  recordWorkerStarted(raw, { adapter: 'hyperneo', id });
  writeFileSync(join(tree.worktreePath, 'draft.txt'), 'keep this draft');
  const rpc = () => new Promise<{ reply: { removed: { directory: string; reason: string }[]; kept: Record<string, string[]> } }>((resolveReply, reject) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), 'work.cleanup.sweep', '{}'], {
      env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
    });
    void Promise.all([new Response(child.stdout).text(), child.exited]).then(([text, code]) => {
      if (code !== 0) reject(new Error(`RPC exit ${code}: ${text}`));
      else resolveReply(JSON.parse(text));
    }, reject);
  });
  const notes = () => JSON.stringify(raw.prepare("SELECT payload FROM job_queue WHERE queue = 'neo_notes'").all());
  const first = await rpc();
  evidence.first = first;
  const removed = first.reply.removed.map(({ directory, reason }) => [directory, reason]);
  assert.deepEqual(removed.toSorted(), [
    [folder('old-todo'), 'todo done'],
    [folder(workerWorkKey(gone('old-worker'))), 'worktree gone'],
  ].toSorted());
  for (const kept of ['old-todo', workerWorkKey(gone('old-worker'))]) assert.equal(existsSync(folder(kept)), false, kept);
  for (const kept of ['fresh-todo', 'cited-todo', workerWorkKey(gone('new-worker'))]) assert(existsSync(folder(kept)), kept);
  assert(raw.prepare('SELECT gone_at FROM work_cleanup_gone WHERE key = ?').get(workerWorkKey(gone('new-worker'))),
    'the first sweep that finds a worker evidence folder without its worktree records when it went');
  assert(existsSync(tree.worktreePath), 'unsaved work stays');
  assert(!notes().includes('Unsaved work kept'), 'no notice on the first day');
  raw.prepare('UPDATE work_cleanup_gone SET gone_at = ? WHERE key = ?').run(now - 4 * DAY, `unsaved:${tree.worktreePath}`);
  evidence.second = await rpc();
  assert(notes().includes(`Unsaved work kept for 3 days at ${tree.worktreePath}`), 'unsaved work reaches Neo after 3 days');
  const told = notes().split('Unsaved work kept').length;
  evidence.third = await rpc();
  assert.equal(notes().split('Unsaved work kept').length, told, 'the notice is sent once');
  assert(existsSync(tree.worktreePath), 'unsaved work is never removed');
  evidence.mailbox = JSON.parse(notes());
  console.log('PASS: old todo and worker evidence removed; fresh, cited and newly gone evidence kept with its gone time recorded; unsaved work kept and told to Neo once after 3 days.');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/work-cleanup-evidence.json'), JSON.stringify(evidence, null, 2));
}
