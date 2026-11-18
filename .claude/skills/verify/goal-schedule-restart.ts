import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { JobQueueProcessor, type JobHandler } from '../../../packages/daemon/src/storage/job-queue-processor.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const name of ['data', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
copyFileSync(new URL('./gh-stub.sh', import.meta.url), join(run, 'bin/gh'));
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
let fire: JobHandler | undefined;
const register = JobQueueProcessor.prototype.register;
JobQueueProcessor.prototype.register = function (queue, handler, options) {
  if (queue === 'sessionSchedule.fire') fire = handler;
  return register.call(this, queue, handler, options);
};
const clock = Date.now;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let hub: MessageHub | undefined;
const evidence: Record<string, unknown> = {};
const start = async () => {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: url => createLocalSocket(url, join(run, 'data/local-rpc.credential')) });
  hub.registerTransport(transport);
  await transport.initialize();
};
const call = (name: string, input: unknown = {}) => hub!.request<any>('operation.invoke', { name, input });
try {
  await start();
  const ownerSessionId = (await call('neo.open')).sessionId;
  const created = await call('goal.session.create', { ownerSessionId, title: 'Synthetic schedule restart', doneTest: 'Done' });
  assert(created.accepted);
  const db = app!.db.getDatabase();
  const rows = db.prepare('SELECT id, next_run_at, pending_job_id FROM session_schedules WHERE source_id = ? ORDER BY source_kind').all(created.goal.id) as { id: string; next_run_at: number; pending_job_id: string }[];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    db.prepare("UPDATE session_schedules SET cadence_kind = 'once', once_at = next_run_at WHERE id = ?").run(row.id);
    Date.now = () => row.next_run_at;
    assert(fire);
    await fire(app!.jobQueue.getJob(row.pending_job_id)!);
  }
  Date.now = clock;
  const pausedGoal = await call('goal.session.create', { ownerSessionId, title: 'Synthetic paused schedules', doneTest: 'Done' });
  assert(pausedGoal.accepted);
  const pausedRows = db.prepare('SELECT id FROM session_schedules WHERE source_id = ?').all(pausedGoal.goal.id) as { id: string }[];
  assert.equal(pausedRows.length, 2);
  for (const row of pausedRows) assert((await call('schedule.session.pause', { scheduleId: row.id })).ok);
  const deleted: { goalId: string; kind: string }[] = [];
  for (const kind of ['goal', 'goal_review']) {
    const created = await call('goal.session.create', { ownerSessionId, title: `Synthetic deleted ${kind}`, doneTest: 'Done' });
    assert(created.accepted);
    const row = db.prepare('SELECT id FROM session_schedules WHERE source_id = ? AND source_kind = ?').get(created.goal.id, kind) as { id: string };
    assert((await call('schedule.session.delete', { scheduleId: row.id })).ok);
    deleted.push({ goalId: created.goal.id, kind });
  }
  const before = await call('schedule.session.list', { target: { adapter: 'hyperneo', id: ownerSessionId } });
  assert.equal(before.schedules.filter((row: { status: string }) => row.status === 'done').length, 2);
  assert.equal(before.schedules.filter((row: { status: string }) => row.status === 'paused').length, 2);
  evidence.before = before;
  await transport!.close();
  await app!.cleanup();
  app = undefined;
  transport = undefined;
  await start();
  const after = await call('schedule.session.list', { target: { adapter: 'hyperneo', id: ownerSessionId } });
  evidence.after = after;
  for (const item of deleted) assert(!after.schedules.some((row: { sourceId: string; sourceKind: string }) => row.sourceId === item.goalId && row.sourceKind === item.kind), `Deleted ${item.kind} schedule returned`);
  assert.deepEqual(after.schedules.map((row: { id: string; status: string; pendingJobId: string | null }) => [row.id, row.status, row.pendingJobId]), before.schedules.map((row: { id: string; status: string; pendingJobId: string | null }) => [row.id, row.status, row.pendingJobId]));
  console.log('PASS: completed, paused and deleted goal schedules stay settled after daemon restart.');
} finally {
  Date.now = clock;
  writeFileSync(join(run, 'evidence/goal-schedule-restart.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
  JobQueueProcessor.prototype.register = register;
}
