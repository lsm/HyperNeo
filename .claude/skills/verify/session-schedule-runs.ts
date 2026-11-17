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
let now = clock();
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
const hub = new MessageHub({ defaultSessionId: 'global' });
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = { firings: [] };
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableGoalProcessing: true, disableWorktrees: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  assert(fire, 'The real daemon did not register its schedule handler');
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: url => createLocalSocket(url, join(run, 'data/local-rpc.credential')) });
  hub.registerTransport(transport); await transport.initialize();
  const call = (name: string, input: unknown = {}) => hub.request<any>('operation.invoke', { name, input });
  const target = await app.sessionManager.createSession({ workspacePath: run, title: 'Reminder recipient' });
  const live = await app.sessionManager.getSessionForControl(target); assert(live);
  await live.stateManager.setIdle();
  const created = await call('schedule.session.create', { target: { adapter: 'hyperneo', id: target }, cadence: { kind: 'every', everyMs: 60_000 }, note: 'Check the release checklist.' });
  const id = created.schedule?.id; assert(id, JSON.stringify(created));
  Date.now = () => now;
  const wake = async () => {
    const row = app!.db.getDatabase().prepare('SELECT next_run_at, pending_job_id FROM session_schedules WHERE id = ?').get(id) as { next_run_at: number; pending_job_id: string };
    now = row.next_run_at;
    await fire!(app!.jobQueue.getJob(row.pending_job_id)!);
    const after = app!.db.getDatabase().prepare('SELECT last_outcome FROM session_schedules WHERE id = ?').get(id) as { last_outcome: string };
    (evidence.firings as unknown[]).push({ due: row.next_run_at, outcome: after.last_outcome });
    return { due: row.next_run_at, outcome: after.last_outcome };
  };
  const fired = await wake();
  const unchanged = await wake();
  await live.stateManager.setQueued('verify-busy');
  const busy = await wake();
  await live.stateManager.setIdle();
  await hub.request('session.delete', { sessionId: target });
  const gone = await wake();
  assert.deepEqual([fired, unchanged, busy, gone].map(f => f.outcome), ['fired', 'skipped_unchanged', 'skipped_busy', 'target_gone']);
  const runs = await call('schedule.session.runs', { scheduleId: id });
  evidence.runs = runs;
  assert.deepEqual(runs, {
    ok: true,
    runs: [
      { dueAt: gone.due, firedAt: gone.due, outcome: 'target_gone', skipReason: null, messageId: null },
      { dueAt: busy.due, firedAt: busy.due, outcome: 'skipped_busy', skipReason: 'busy', messageId: null },
      { dueAt: unchanged.due, firedAt: unchanged.due, outcome: 'skipped_unchanged', skipReason: 'unchanged', messageId: null },
      { dueAt: fired.due, firedAt: fired.due, outcome: 'fired', skipReason: null, messageId: `schedule:${id}:${fired.due}` },
    ],
  });
  console.log(`PASS four firings left four runs, newest first, read through schedule.session.runs. ${run}/evidence/schedule-runs.json`);
} finally {
  Date.now = clock;
  writeFileSync(join(run, 'evidence/schedule-runs.json'), JSON.stringify(evidence, null, 2));
  await transport?.close(); await app?.cleanup();
  JobQueueProcessor.prototype.register = register;
}
