import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const evidence: Record<string, unknown> = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  evidence.port = app.server.port;
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const root = 'neo:00000000-0000-4000-8000-000000008418';
  const worker = '00000000-0000-4000-8000-000000008419';
  const timestamp = new Date().toISOString();
  for (const id of [root, worker]) db.prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'Synthetic work', 'general', join(run, 'workspace'), timestamp, timestamp, 'active', '{}', '{}');
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  for (const id of ['open', 'closed', 'foreign']) {
    const ask = store.openAsk({ id, projectId: null, sessionId: id === 'foreign' ? worker : root, originMessageId: null, title: 'Synthetic ask', request: 'Synthetic admission proof', createdAt: Date.now() });
    store.addTodo(id + '-todo', ask.id, { title: 'Synthetic todo', doneWhen: 'Tracked', instruction: null, named: null, check: null }, Date.now());
    if (id === 'closed') store.settleAsk(ask, 'done', 'Synthetic closure', Date.now());
  }
  const registry = app.sessionManager.getOperationRegistry();
  const caller = { sessionId: root, role: 'neo' as const };
  const mcp = createOperationMcpHandler(() => registry, () => caller);
  const ref = { adapter: 'hyperneo', id: worker };
  const receipts: unknown[] = [];
  const call = async (name: string, input: Record<string, unknown>) => {
    const reply = await mcp({ name, input });
    const result = JSON.parse(reply.content[0].text);
    receipts.push({ name, input, result });
    return result;
  };
  const untracked = [];
  for (const extra of [{}, { todoId: 'unknown' }, { todoId: 'closed-todo' }, { todoId: 'foreign-todo' }, { message: 'todoId open-todo appears only in text', source: 'internal' }]) {
    untracked.push(await call('work.send', { ref, message: 'Synthetic new work', ...extra }));
  }
  untracked.push(await call('work.queue', { ref, message: 'Untracked next-turn work' }));
  const start = await call('work.start', { adapter: 'hyperneo', place: { machine: 'fixture', folder: join(run, 'workspace'), name: 'Synthetic' }, title: 'Synthetic new work', message: 'Synthetic work' });
  const followUp = await call('work.send', { ref, message: 'More context for the existing todo', todoId: 'open-todo' });
  const runner = await call('neo.todo.add', { askId: 'open', title: 'Synthetic runner work', doneWhen: 'Tracked dispatch', instruction: 'Synthetic opening task', target: { verb: 'send', ref }, start: true });
  const continued = await call('neo.todo.continue', { todoId: runner.todo?.id, message: 'Additional synthetic context' });
  const internal = await invokeOperation(registry, 'work.send', { ref, message: 'Trusted daemon notification' }, { ...caller, source: 'internal' });
  evidence.receipts = receipts;
  evidence.internal = internal;
  evidence.mailboxes = db.prepare("SELECT payload FROM job_queue WHERE queue='mailbox'").all();
  evidence.untracked = untracked;
  assert(untracked.every(result => result.ok === true && result.records?.some((record: string) => record.startsWith('todo_required:'))), 'Untracked Neo work must be accepted with a visible bookkeeping record');
  assert.equal(start.ok, true, JSON.stringify(start));
  assert(start.records?.some((record: string) => record.startsWith('todo_required:')));
  assert.equal(followUp.ok, true, JSON.stringify(followUp));
  assert.equal(runner.todo?.state, 'doing', JSON.stringify(runner));
  assert.equal(continued.ok, true, JSON.stringify(continued));
  assert.equal(internal.kind, 'completed');
  assert(internal.kind === 'completed' && (internal.value as { ok: boolean }).ok);
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await app.cleanup();
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
