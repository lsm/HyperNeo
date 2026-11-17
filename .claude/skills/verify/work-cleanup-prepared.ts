import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { getWorktreeBaseDir } from '../../../packages/daemon/src/lib/worktree-path-utils.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const git = (cwd: string, ...args: string[]) => {
  const identity = { GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' };
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const remote = join(run, 'remote');
const source = join(run, 'source');
git(run, 'init', '--initial-branch=dev', remote);
writeFileSync(join(remote, 'code.txt'), 'base');
git(remote, 'add', '.');
git(remote, 'commit', '-m', 'initial');
git(run, 'clone', remote, source);
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: Record<string, unknown> = {};
const rpc = async (name: string, input: unknown) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  assert.equal(code, 0, text);
  return (JSON.parse(text) as { reply: unknown }).reply;
};
try {
  await rpc('rpc:customEndpoints.add', { endpoint: { id: 'synthetic', name: 'Synthetic', type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:1', models: [{ id: 'synthetic', name: 'Synthetic' }] } });
  await rpc('rpc:models.list', { forceRefresh: true });
  const started = await rpc('work.start', {
    adapter: 'hyperneo', place: { machine: hostname(), folder: source, name: 'Synthetic source' },
    title: 'Prepared cleanup worker', message: 'Synthetic placement only', model: 'synthetic',
    preparation: { pack: 'coding', parameters: { target: 'dev' } },
  }) as { ok: boolean; value: { ref: { adapter: string; id: string } } };
  assert(started.ok, JSON.stringify(started));
  const ref = started.value.ref;
  const clone = join(getWorktreeBaseDir(source), ref.id);
  assert(existsSync(join(clone, '.git', 'hyperneo-source-checkout')), 'a real prepared clone exists');
  for (let tries = 0; tries < 60; tries++) {
    const state = app.sessionManager.getCachedSession(ref.id)?.getProcessingState().status;
    if (!state || ['idle', 'interrupted'].includes(state)) break;
    await Bun.sleep(500);
  }
  const raw = app.db.getDatabase();
  const root = `neo:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  raw.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(root, 'Synthetic Neo', 'general', join(run, 'home'), now, now, 'active', '{}', '{}');
  new NeoRepository(raw).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(raw);
  const ask = todos.openAsk({ id: 'prepared-ask', sessionId: root, projectId: null, originMessageId: null,
    title: 'Prepared cleanup', request: 'Remove the finished clone', createdAt: Date.now() });
  const todo = todos.addTodo('prepared-todo', ask.id, { title: 'Finished prepared worker', doneWhen: 'Done', instruction: null, named: null, check: null }, Date.now());
  new NeoTodoSessionRepository(raw).create(todo.id, { verb: 'start', adapter: 'hyperneo' });
  raw.prepare('UPDATE neo_todo_sessions SET ref = ? WHERE todo_id = ?').run(JSON.stringify(ref), todo.id);
  todos.updateTodo(todo, { state: 'done', finishedAt: Date.now() }, Date.now());
  evidence.sweep = await rpc('work.cleanup.sweep', {});
  const reply = evidence.sweep as { removed: { directory: string; reason: string }[] };
  assert.deepEqual(reply.removed, [{ directory: clone, reason: 'todo done' }], JSON.stringify(reply));
  assert.equal(existsSync(clone), false, 'the finished prepared clone is removed');
  assert(raw.prepare("SELECT 1 FROM pack_facts WHERE todo_id = ? AND pack = 'core' AND key = 'released'").get(todo.id));
  assert(existsSync(join(source, 'code.txt')), 'the source checkout stays');
  console.log('PASS: the sweep removed a real finished prepared HyperNeo clone through the archive path and kept its source checkout.');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/work-cleanup-prepared.json'), JSON.stringify(evidence, null, 2));
}
process.exit(0);
