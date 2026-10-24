import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
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
  app = await createDaemonApp({ config, disableWorktrees: true, disableGoalProcessing: true, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  (evidence.ports ??= [] as number[]);
  (evidence.ports as number[]).push(app.server.port!);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
};
const close = async () => { await service?.dispose(); service = undefined; await app?.cleanup(); app = undefined; };
const refresh = () => refreshNeoDriverWork(app!.jobQueue, service!);
const notes = () => app!.db.getDatabase().prepare("SELECT payload FROM job_queue WHERE queue='mailbox'").all() as { payload: string }[];
const check = (name: string, count: number) => {
  const rows = notes();
  (evidence.checks as unknown[]).push({ name, clock, rows });
  assert.equal(rows.length, count, name);
  for (const row of rows) {
    const input = JSON.parse(row.payload);
    assert.equal(input.to.sessionId, 'neo:00000000-0000-4000-8000-000000008419');
    assert(JSON.stringify(input).includes('This ask has nothing in progress. Add the next todo, or settle it.'));
    assert(JSON.stringify(input).includes('stalled'));
  }
};
try {
  await open();
  const root = 'neo:00000000-0000-4000-8000-000000008419';
  app!.db.getDatabase().prepare('INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)').run(root, 'Synthetic coordinator', 'general', join(run, 'workspace'), new Date(at).toISOString(), new Date(at).toISOString(), 'active', '{}', '{}');
  for (const id of ['stalled', 'settled', 'question']) {
    const ask = service!.todos.openAsk({ id, sessionId: root, projectId: null, originMessageId: null, title: id, request: 'Synthetic work', createdAt: at });
    if (id === 'settled') service!.todos.settleAsk(ask, 'done', 'Settled', at);
    if (id === 'question') service!.todos.askQuestion('q', id, { text: 'Choose', kind: 'yesno', options: null, multiple: false, noLabel: 'No', yesLabel: 'Yes', startTodos: null, confirm: null, document: null, replyTo: [], todoId: null, artifacts: [] }, at);
  }
  clock = at + 2 * hour - 1;
  await refresh(); check('before threshold', 0);
  clock++;
  await Promise.all([refresh(), refresh()]); check('one wake at threshold', 1);
  await close();
  await open();
  await refresh(); check('restart preserves cooldown', 1);
  clock += 4 * hour - 1;
  await refresh(); check('no early repeat', 1);
  clock++;
  await refresh(); check('repeat at four hours', 2);
  assert.equal(new Set(notes().map(row => JSON.parse(row.payload).messageUuid)).size, 2);
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
