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
const evidence: Record<string, unknown> = {};
try {
  app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true }, verbose: false });
  await app.jobProcessor.stop();
  assert(fire);
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false, createSocket: url => createLocalSocket(url, join(run, 'data/local-rpc.credential')) });
  hub.registerTransport(transport);
  await transport.initialize();
  const call = (name: string, input: unknown = {}) => hub.request<any>('operation.invoke', { name, input });
  const ownerSessionId = (await call('neo.open')).sessionId;
  assert(ownerSessionId);
  const plainOwner = await hub.request<any>('session.create', { workspacePath: run, title: 'Synthetic parent' });
  const metric = { name: 'adopters', baseline: 2, target: 10, direction: 'increase' };
  evidence.plainOwner = await call('goal.session.create', { ownerSessionId: plainOwner.sessionId, title: 'Synthetic adoption', metric });
  assert.equal((evidence.plainOwner as any).reason, 'metric_review_unavailable: use a goal session or a Neo owner for a structured metric.');
  const created = await call('goal.session.create', { ownerSessionId, title: 'Synthetic adoption', metric: { name: 'adopters', baseline: 2, target: 10, direction: 'increase' } });
  assert(created.accepted, JSON.stringify(created));
  const goalId = created.goal.id;
  const db = app.db.getDatabase();
  const point = (runId: string, value: number) => call('goal.journal.append', { ownerSessionId, goalId, runId, done: 'Review', effect: 'yes', worked: 'Guide', metricPoint: { value, evidence: 'Synthetic counter' } });
  evidence.invalid = await point('work:1', 4);
  assert.equal((evidence.invalid as any).accepted, false);
  Date.now = () => now;
  const receipts = [];
  for (const value of [4, 10]) {
    const row = db.prepare("SELECT id, next_run_at, pending_job_id FROM session_schedules WHERE source_kind = 'goal_review' AND source_id = ?").get(goalId) as { id: string; next_run_at: number; pending_job_id: string };
    now = row.next_run_at;
    await fire(app.jobQueue.getJob(row.pending_job_id)!);
    const mailbox = db.prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox' AND json_extract(payload, '$.messageUuid') = ?").get(`schedule:${row.id}:${row.next_run_at}`) as { payload: string } | null;
    assert(mailbox);
    const runId = /runId (goal-review:[^, ]+)/.exec(mailbox.payload)?.[1];
    assert(runId);
    assert(mailbox.payload.includes('metricPoint'));
    if (value === 4) {
      evidence.missingPoint = await call('goal.journal.append', { ownerSessionId, goalId, runId, done: 'Review', effect: 'yes', worked: 'Guide' });
      assert.equal((evidence.missingPoint as any).reason, 'metric_point_required: reviews of a metric goal must include metricPoint.');
    }
    const receipt = await point(runId, value);
    assert(receipt.accepted, JSON.stringify(receipt));
    receipts.push(receipt);
  }
  evidence.receipts = receipts;
  evidence.facts = await call('goal.facts', { ownerSessionId, goalId });
  evidence.journal = await call('goal.journal.list', { ownerSessionId, goalId });
  evidence.goal = await call('goal.session.get', { ownerSessionId, goalId });
  const snapshot = await call('neo.snapshot');
  evidence.publications = await call('neo.publication.read', { conversationId: snapshot.conversationId, after: 0, limit: 100 });
  assert.equal(receipts[1].metricReached, true);
  assert((evidence.facts as any).facts.lines.join('\n').includes('adopters: 10; target 10; change 6'));
  assert.equal((evidence.journal as any).entries.length, 2);
  assert.deepEqual((evidence.journal as any).entries.map((entry: any) => entry.metricPoint.value), [10, 4]);
  assert((evidence.journal as any).entries.every((entry: any) => entry.metricPoint.evidence === 'Synthetic counter' && typeof entry.metricPoint.time === 'number'));
  assert.equal((evidence.goal as any).goal.status, 'active');
  assert(JSON.stringify(evidence.publications).includes('reached its target'));
  console.log('PASS: two scheduled reviews recorded; facts show 10/10 and change 6; owner and human received the target; goal remains active');
} finally {
  Date.now = clock;
  writeFileSync(join(run, 'evidence/goal-review-metric.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
  JobQueueProcessor.prototype.register = register;
}
