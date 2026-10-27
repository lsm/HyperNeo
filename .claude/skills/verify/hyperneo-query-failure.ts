import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, type Session } from '../../../packages/shared/src/mod.ts';
import { Database } from '../../../packages/daemon/src/storage/database.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';
import { sdkNeoWakeQueue } from '../../../packages/daemon/src/storage/repositories/sdk-message-transactions.ts';
import { sdkMessageBodyAt } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-read.ts';
import { AgentSession } from '../../../packages/daemon/src/lib/agent/agent-session.ts';
import { MessageDeliveryTerminalTurnError } from '../../../packages/daemon/src/lib/agent/message-delivery.ts';
import { createHyperneoAdapter } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { ErrorManager, ErrorCategory } from '../../../packages/daemon/src/lib/error-manager.ts';
import { createDaemonInternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createMailboxDeliveryHandler } from '../../../packages/daemon/src/lib/mailbox/delivery.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['evidence', 'data', 'workspace']) mkdirSync(join(run, name), { recursive: true });
const db = new Database(join(run, 'data/daemon.db'));
await db.initialize(createReactiveDatabase(db));
const hub = new MessageHub({ defaultSessionId: 'global' });
const events = createDaemonInternalEventBus();
const root = 'neo:10000000-0000-4000-8000-000000009095';
const worker = 'synthetic-query-failure-worker';
const error = 'Synthetic unknown query start failure';
const episode = { id: 'synthetic-episode', failures: 3, retryAt: 0, error, failed: true };
const seed = (id: string): Session => ({
  id, title: id === worker ? 'Synthetic worker' : 'Synthetic Neo', workspacePath: join(run, 'workspace'),
  type: id === worker ? 'worker' : 'general', status: 'active',
  createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
  config: { queryMode: 'manual' },
  metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
});
await db.createSession(seed(root));
await db.createSession(seed(worker));
const driver = createHyperneoAdapter({
  db: () => db.getDatabase(), machine: 'synthetic', searchChats: async () => [],
  handoff: async () => ({ kind: 'enqueued', id: 'unused' }),
  sessions: { create: async () => { throw new Error('unused'); }, resolveModel: async () => null,
    model: () => null, chooseWorktree: async () => {}, announce: () => {}, interrupt: () => false },
  neoFolder: () => join(run, 'workspace'), folderExists: () => true, makeFolder: () => {}, homeDir: join(run, 'home'),
});
const registry = createOperationRegistry(createWorkVerbOperations({
  adapters: () => [driver], daemonName: 'synthetic',
  remote: { list: () => [], invoke: async () => { throw new Error('No network in proof'); } },
}));
const service = createNeoService(db, { getOperationRegistry: () => registry } as never, hub, events);
service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
const agent = new AgentSession(db.getSession(root)!, db, hub, events, async () => null,
  undefined, undefined, undefined, undefined, { autoReplayPendingMessages: false });
const evidence: Record<string, unknown> = { surface: 'work.status operation and Neo recipient mailbox storage', governorSimulated: true, networkTransportVerified: false, modelConsumptionVerified: false };
const errors = new ErrorManager(hub, events);
const emit = () => errors.handleError(worker, new MessageDeliveryTerminalTurnError(error), ErrorCategory.SYSTEM, error, undefined,
  { queryFailureEpisode: episode });
const mailbox = () => db.getJobQueueRepo().listJobs({ queue: 'mailbox' });
try {
  for (let attempt = 0; attempt < 5; attempt++)
    await errors.handleError(worker, error, ErrorCategory.SYSTEM, error);
  evidence.throttleSaturated = true;
  assert.equal(mailbox().length, 0);
  await db.updateSession(worker, { metadata: { ...seed(worker).metadata, queryFailureEpisode: episode } } as never);
  evidence.status = await invokeOperation(registry, 'work.status', { ref: { adapter: 'hyperneo', id: worker } },
    { source: 'rpc', principal: 'local' });
  evidence.find = await driver.find({ includeClosed: false, limit: 20 });
  await emit();
  const deadline = Date.now() + 1000;
  while (mailbox().length === 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  await emit();
  await new Promise((done) => setTimeout(done, 30));
  evidence.mailbox = mailbox();
  const [queued] = db.getJobQueueRepo().dequeue('mailbox');
  if (queued) {
    const handler = createMailboxDeliveryHandler({
      jobQueue: db.getJobQueueRepo(), db: db.getDatabase(), sdkMessageRepo: db.getSDKMessageRepo(),
      getSession: async (id) => id === root ? agent : null, isSessionArchived: () => false,
      prepareEntry: (entry, jobId) => db.getSDKMessageRepo().runWrite(sdkNeoWakeQueue,
        { prepare: [entry, jobId, true] }),
    });
    evidence.delivery = await handler(queued);
  }
  evidence.recipientInputs = db.getDatabase().prepare(
    `SELECT ${sdkMessageBodyAt('m.rowid')} AS body, send_status FROM sdk_messages m WHERE session_id=? AND message_type='user'`
  ).all(root);
  assert.equal((evidence.status as any).value?.value?.status, 'failed');
  assert.equal((evidence.status as any).value?.value?.lastReply, error);
  assert.equal((evidence.find as any[]).flatMap((place) => place.work).find((work) => work.ref.id === worker)?.status, 'failed');
  assert.equal((evidence.mailbox as unknown[]).length, 1, 'Expected one wake per episode');
  assert.equal((evidence.recipientInputs as unknown[]).length, 1, 'Neo did not receive its durable input');
  assert(JSON.stringify(evidence.recipientInputs).includes(error));
  await db.updateSession(worker, { metadata: { ...seed(worker).metadata, queryFailureEpisode: { ...episode, id: 'reset-episode', failed: false, failures: 0 } } } as never);
  await emit();
  await new Promise((done) => setTimeout(done, 30));
  evidence.postResetMailboxCount = mailbox().length;
  assert.equal(mailbox().length, 1, 'A stale post-reset event produced another wake');
  evidence.pass = true;
  console.log('PASS: public work.status reports failed with the original error; one wake reaches Neo storage; stale post-reset error is ignored.');
} finally {
  await service.dispose();
  await agent.cleanup();
  hub.cleanup();
  events.clear();
  await db.close();
  evidence.cleaned = true;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
