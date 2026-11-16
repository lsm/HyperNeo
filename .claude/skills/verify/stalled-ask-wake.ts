process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createCleanupHandler } from '../../../packages/daemon/src/lib/job-handlers/cleanup.handler.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { refreshNeoDriverWork } from '../../../packages/daemon/src/lib/neo/driver-refresh.ts';

const run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home', 'workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const hour = 3_600_000, at = Date.now(), realNow = Date.now;
let clock = at;
Date.now = () => clock;
const evidence: Record<string, unknown> = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), checks: [] };
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
const open = async () => {
  app = await createDaemonApp({ config: { ...config, disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  (evidence.ports ??= [] as number[]);
  (evidence.ports as number[]).push(app.server.port!);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
};
const close = async () => { await service?.dispose(); service = undefined; await app?.cleanup(); app = undefined; };
const refresh = () => refreshNeoDriverWork(app!.jobQueue, service!);
const root = 'neo:00000000-0000-4000-8000-000000008419';
const idle = 'This ask has nothing in progress. Add the next todo, or settle it.';
const finished = 'All todos are finished: write the outcome with neo.ask.settle, or add the next todo.';
const told = (queue: 'mailbox' | 'neo_notes') => (app!.db.getDatabase().prepare("SELECT payload FROM job_queue WHERE queue=? ORDER BY created_at, rowid").all(queue) as { payload: string }[]).map((row) => JSON.parse(row.payload) as { to: { sessionId: string }; messageUuid: string; message: { message: { content: string } } }).filter((input) => input.message.message.content.startsWith('Ask: '));
const check = (name: string, digests: number, wakes = 0) => {
  const rows = { digests: told('neo_notes'), wakes: told('mailbox') };
  (evidence.checks as unknown[]).push({ name, clock, rows });
  assert.equal(rows.digests.length, digests, name);
  assert.equal(rows.wakes.length, wakes, name);
  for (const input of [...rows.digests, ...rows.wakes]) assert.equal(input.to.sessionId, root);
  for (const input of rows.digests) assert.equal(input.message.message.content, `Ask: stalled (stalled)\n${idle}`);
  for (const input of rows.wakes) assert.equal(input.message.message.content, `Ask: finished (finished)\n${finished}`);
};
try {
  await open();
  app!.db.getDatabase().prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run(root, 'Synthetic coordinator', 'general', join(run, 'workspace'), new Date(at).toISOString(), new Date(at).toISOString(), 'active', '{}', '{}');
  service!.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  for (const id of ['stalled', 'settled', 'question', 'blocked']) {
    const ask = service!.todos.openAsk({ id, sessionId: root, projectId: null, originMessageId: null, title: id, request: 'Synthetic work', createdAt: at });
    if (id === 'settled') service!.todos.settleAsk(ask, 'done', 'Settled', at);
    if (id === 'question') service!.todos.askQuestion('q', id, { text: 'Choose', kind: 'yesno', options: null, multiple: false, noLabel: 'No', yesLabel: 'Yes', confirm: null, document: null, replyTo: [], todoId: null, artifacts: [] }, at);
    if (id === 'blocked') service!.todos.updateTodo(service!.todos.addTodo('blocked-step', id, { title: 'Step', doneWhen: 'Done', check: null, instruction: null, named: null }, at), { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Needs a decision' }, at);
  }
  clock = at + 2 * hour - 1;
  await refresh(); check('before threshold', 0);
  clock++;
  await Promise.all([refresh(), refresh()]); check('one digest line at threshold', 1);
  await close();
  await open();
  await refresh(); check('restart tells nothing again', 1);
  clock = at + 6 * hour;
  await refresh(); check('no repeat at four hours', 1);
  clock = at + 24 * hour - 1;
  await refresh(); check('no early repeat', 1);
  clock++;
  await refresh(); check('one repeat after a day', 2);
  clock = at + 72 * hour;
  await refresh(); check('no repeat after the last rung', 2);
  assert.equal(new Set(told('neo_notes').map((input) => input.messageUuid)).size, 2);
  clock = at + 30 * 24 * hour;
  evidence.cleaned = (await createCleanupHandler(app!.db.getJobQueueRepo())({} as never)).deletedJobs;
  check('queue cleanup removes the delivered lines', 0);
  await refresh(); check('a cleaned-up line is not told again', 0);
  service!.todos.openAsk({ id: 'finished', sessionId: root, projectId: null, originMessageId: null, title: 'finished', request: 'Synthetic work', createdAt: clock });
  service!.todos.updateTodo(service!.todos.addTodo('finished-step', 'finished', { title: 'Step', doneWhen: 'Done', check: null, instruction: null, named: null }, clock), { state: 'done' }, clock);
  await Promise.all([refresh(), refresh()]); check('a finished ask wakes at once', 0, 1);
  clock += 60_000;
  service!.todos.recordAskOutcome('finished', 'Shipped', clock);
  await refresh(); check('writing the outcome does not wake again', 0, 1);
  evidence.askColumns = (app!.db.getDatabase().prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map((column) => column.name);
  assert(!(evidence.askColumns as string[]).includes('stalled_wake_at'));
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await close();
  Date.now = realNow;
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
