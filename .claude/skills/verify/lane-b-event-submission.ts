import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ingestSessionEvent, SessionExternalEventStore, SESSION_EVENT_SCOPE } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { sessionEventText, mailSessionEvent } from '../../../packages/daemon/src/lib/external-events/session-event-delivery.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';
import { buildImmediateEventMessageUuid } from '../../../packages/daemon/src/lib/external-events/immediate-delivery-pipeline.ts';
import type { ExternalEvent } from '../../../packages/daemon/src/lib/external-events/types.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = {};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
try {
  app = await createDaemonApp({ config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
    disableWorktrees: true, disableGoalProcessing: true,
  }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'), config: { queryMode: 'manual' },
  });
  const raw = app.db.getDatabase();
  new SessionEventSubscriptionRepository(raw).upsert({ sessionId, topic: 'github/synthetic/repo/pull_request/7.*' });
  const event: ExternalEvent = {
    id: 'synthetic-review', spaceId: SESSION_EVENT_SCOPE, source: 'github',
    topic: 'github/synthetic/repo/pull_request/7.review_submitted',
    dedupeKey: 'synthetic-review', occurredAt: Date.now(), ingestedAt: Date.now(),
    summary: 'Synthetic review', payload: { actor: 'synthetic-reviewer', title: 'Review ready ' + 'complete synthetic feedback '.repeat(5000) },
    urgency: 'queued',
  };
  await app.db.gateway.run(ingestSessionEvent, event);
  const expectedText = sessionEventText(new SessionExternalEventStore(raw).getById(event.id)!.event);
  const payload = { ...event, namespaceId: SESSION_EVENT_SCOPE, eventId: event.id };
  const publish = () => app!.internalEventBus.publish('externalEvent.published', payload);
  const messageId = buildImmediateEventMessageUuid(event.id, `session:${sessionId}`);
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if ((new Error().stack ?? '').includes('/external-events/session-event-delivery.ts')) {
      mainSqlAttempts++;
      throw new Error('event submission SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    const start = performance.now();
    evidence.routeResults = await Promise.all([publish(), publish()]);
    evidence.submitMs = performance.now() - start;
    assert.equal(mainSqlAttempts, 0, 'session event receipt and enqueue must run off main');
    const jobs = app.jobQueue.listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid: messageId });
    assert.equal(jobs.length, 1);
    const queued = jobs[0].payload as { message: { message: { content: string } }; id: string };
    assert.equal(hash(queued.message.message.content), hash(expectedText));
    const receipts = raw.prepare('SELECT receipt FROM message_send_receipts').all() as { receipt: string }[];
    assert.equal(receipts.filter(row => JSON.parse(row.receipt).id === queued.id).length, 1);
    evidence.status = await hub.request('operation.invoke', { name: 'message.status', input: { sessionId, messageId } });
    assert.deepEqual(evidence.status, { status: 'queued' });
    const conflict = await mailSessionEvent(app.jobQueue, { sessionId, messageUuid: messageId, text: 'changed feedback', mode: 'defer' });
    assert.equal(conflict.kind, 'rejected');
    if (conflict.kind === 'rejected') assert(conflict.reason.includes('idempotency_conflict'));
    evidence.conflictRejected = true;
    const retryEvent = { ...event, id: 'synthetic-retry', dedupeKey: 'synthetic-retry' };
    await app.db.gateway.run(ingestSessionEvent, retryEvent);
    const retryId = buildImmediateEventMessageUuid(retryEvent.id, `session:${sessionId}`);
    const retry = () => app!.internalEventBus.publish('externalEvent.published', { ...retryEvent, namespaceId: SESSION_EVENT_SCOPE, eventId: retryEvent.id });
    raw.exec(`CREATE TRIGGER reject_event_receipt BEFORE INSERT ON message_send_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt unavailable'); END`);
    await assert.rejects(retry(), /Publish of 'externalEvent.published' failed/);
    assert.equal(app.jobQueue.listActiveByPayload('mailbox', { messageUuid: retryId }).length, 0);
    raw.exec('DROP TRIGGER reject_event_receipt');
    const accepted = await retry();
    assert.equal(accepted.failures.length, 0);
    assert.equal(app.jobQueue.listActiveByPayload('mailbox', { messageUuid: retryId }).length, 1);
    evidence.rollbackAndRetry = true;
    evidence.bodyBytes = Buffer.byteLength(expectedText);
    evidence.fullBodyHash = hash(expectedText);
    evidence.health = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  writeFileSync(join(run, 'evidence/event-submission.json'), JSON.stringify(evidence, null, 2));
  await transport?.close();
  await app?.cleanup();
}
console.log('ok real event routing commits one receipt and mailbox job; RPC observes queued; rollback permits retry');
