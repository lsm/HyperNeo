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
const register = JobQueueProcessor.prototype.register;
let fire: JobHandler | undefined;
JobQueueProcessor.prototype.register = function (queue, handler, options) {
  if (queue === 'sessionSchedule.fire') fire = handler;
  return register.call(this, queue, handler, options);
};
const clock = Date.now;
let now = clock();
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
const hub = new MessageHub({ defaultSessionId: 'global' });
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = {};
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  assert(fire);
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: url => createLocalSocket(url, join(run, 'data/local-rpc.credential')) });
  hub.registerTransport(transport); await transport.initialize();
  const call = (name: string, input: unknown = {}) => hub.request<any>('operation.invoke', { name, input });
  const ownerSessionId = (await call('neo.open')).sessionId; assert(ownerSessionId);
  const goal = await call('goal.session.create', { ownerSessionId, title: 'Synthetic review', doneTest: 'Done' }); assert(goal.accepted);
  const goalId = goal.goal.id;
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const result = await call('goal.journal.append', { ownerSessionId, goalId, done: `work-${String(i).padStart(2, '0')}`, effect: 'None', worked: 'Read' });
    assert(result.accepted); ids.push(result.entry.id);
  }
  const db = app.db.getDatabase();
  const wake = async () => {
    const row = db.prepare("SELECT id, next_run_at, pending_job_id FROM session_schedules WHERE source_kind = 'goal_review' AND source_id = ?").get(goalId) as { id: string; next_run_at: number; pending_job_id: string };
    now = row.next_run_at; Date.now = () => now;
    await fire!(app!.jobQueue.getJob(row.pending_job_id)!);
    const message = db.prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox' AND json_extract(payload, '$.messageUuid') = ?").get(`schedule:${row.id}:${row.next_run_at}`) as { payload: string } | null;
    assert(message); return message.payload;
  };
  const first = await wake();
  assert(!first.includes('work-00') && first.includes('work-05') && first.includes('work-24') && first.includes('5 earlier'));
  const page = await call('goal.journal.list', { ownerSessionId, goalId, before: ids[5], limit: 20 });
  assert.equal(page.entries.length, 5);
  const runId = /runId (goal-review:[^, ]+)/.exec(first)?.[1]; assert(runId?.endsWith(ids[24]));
  await call('goal.journal.append', { ownerSessionId, goalId, done: 'work-during-review', effect: 'Changed', worked: 'Read' });
  await call('goal.journal.append', { ownerSessionId, goalId, runId, done: 'Review', effect: 'yes', worked: 'Read' });
  const next = await wake();
  assert(next.includes('work-during-review') && !next.includes('work-24'));
  evidence.snapshot = { included: 20, earlier: page.entries.length, concurrentEntryInNextReview: true };
  console.log('PASS: review wake contains 20 entries, five older entries page through RPC, and concurrent work appears in the next wake.');
} finally {
  Date.now = clock;
  writeFileSync(join(run, 'evidence/goal-review-snapshot.json'), JSON.stringify(evidence, null, 2));
  await transport?.close(); await app?.cleanup();
  JobQueueProcessor.prototype.register = register;
}
