import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createMailboxEntry, parseMailboxEntry } from '../../../packages/daemon/src/lib/mailbox/entry.ts';
import { handoffPromptToMailbox } from '../../../packages/daemon/src/lib/mailbox/handoff.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { jobQueueWrites, JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { neoWakeQueueWrite } from '../../../packages/daemon/src/storage/repositories/neo-wake-queue-repository.ts';
import { sdkNeoWakeQueue, sdkDeliveryTeardown } from '../../../packages/daemon/src/storage/repositories/sdk-message-transactions.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const run = resolve(process.argv[2] ?? '');
assert(process.argv[2] && process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath));
mkdirSync(join(run, 'bin'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = `${run}/bin:${process.env.PATH}`;
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
let saved: { jobId: string; message: unknown; notes: number } | undefined;
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  await app.jobProcessor.stop();
  const opened = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', { name: 'neo.open', input: {} });
  assert(opened.ok);
  const root = opened.sessionId;
  const writer = gatewayFor(app.db.getDatabase());
  await handoffPromptToMailbox({ to: `session:${encodeURIComponent(root)}`, origin: 'session:synthetic-worker', messageUuid: 'in-flight', message: { type: 'user', parent_tool_use_id: null, message: { content: 'Already admitted report.' } }, jobQueue: app.jobQueue });
  const [inFlight] = await writer.call(jobQueueWrites, 'dequeue', 'mailbox', 1);
  const inFlightEntry = parseMailboxEntry(inFlight.payload);
  assert(inFlightEntry);
  await writer.run(sdkNeoWakeQueue, { prepare: [inFlightEntry, inFlight.id, true] });
  const note = (messageUuid: string, content: string) => createMailboxEntry({ to: { kind: 'session' as const, sessionId: root }, origin: 'session:synthetic-worker' as const, messageUuid, message: { type: 'user' as const, parent_tool_use_id: null, message: { content } } });
  await writer.call(neoWakeQueueWrite, 'hold', note('later-note', 'Later queued note.'));
  await writer.run(sdkNeoWakeQueue, { flush: Date.now() + 15 * 60_000 });
  const timed = app.jobQueue.listActiveByPayload('message_delivery', { sessionId: root }, ['pending']);
  assert.equal(timed.length, 1);
  const timedContent = JSON.stringify(app.db.getSDKMessageRepo().getDeliveryContent(root, String(timed[0].payload.messageUuid))!.content);
  assert(timedContent.includes('Later queued note.'));
  await writer.call(neoWakeQueueWrite, 'hold', note('cancelled-report', 'Cancelled report.'));
  const cancelled = await writer.run(sdkDeliveryTeardown, { sessionId: root, options: { deliveries: { failEnqueued: true, failDeferred: true } } });
  await writer.run(sdkNeoWakeQueue, { flush: Date.now() + 15 * 60_000 });
  const reviewObserved = { processingReportExcluded: !timedContent.includes('Already admitted report.'), cancellationIncludesParkedNote: cancelled.deleted.some((row) => JSON.parse(row.payload).messageUuid === 'cancelled-report'), noBatchAfterCancellation: app.jobQueue.listActiveByPayload('mailbox', { 'to.sessionId': root }).length === 0 && app.jobQueue.listActiveByPayload('message_delivery', { sessionId: root }).length === 0 };
  writeFileSync(join(run, 'evidence/review-cases.json'), JSON.stringify(reviewObserved, null, 2));
  assert.deepEqual(reviewObserved, { processingReportExcluded: true, cancellationIncludesParkedNote: true, noBatchAfterCancellation: true });
  for (let index = 0; index < 20; index++) {
    const entry = createMailboxEntry({ to: { kind: 'session', sessionId: root }, origin: 'session:synthetic-worker', messageUuid: `note-${index}`, message: { type: 'user', parent_tool_use_id: null, message: { content: `message-body-${String(index).padStart(2, '0')}` } } });
    await writer.call(neoWakeQueueWrite, 'hold', entry);
  }
  await handoffPromptToMailbox({ to: `session:${encodeURIComponent(root)}`, origin: 'session:synthetic-worker', messageUuid: 'store-trigger', message: { type: 'user', parent_tool_use_id: null, workerReportKind: 'blocked', message: { content: 'Original report.' } }, jobQueue: app.jobQueue });
  const [job] = await writer.call(jobQueueWrites, 'dequeue', 'mailbox', 1);
  const entry = parseMailboxEntry(job.payload);
  assert(entry);
  const prepared = await writer.run(sdkNeoWakeQueue, { prepare: [entry, job.id, true] });
  assert(prepared);
  assert.equal(prepared.message.message.content, 'Original report.');
  const [batch] = app.jobQueue.listActiveByPayload('message_delivery', { sessionId: root });
  assert(batch);
  const body = JSON.stringify(app.db.getSDKMessageRepo().getDeliveryContent(root, String(batch.payload.messageUuid))!.content);
  let previous = -1;
  for (let index = 0; index < 20; index++) {
    const at = body.indexOf(`message-body-${String(index).padStart(2, '0')}`);
    assert(at > previous);
    previous = at;
  }
  assert(!body.includes('Original report.'));
  assert(body.includes('System-forwarded worker messages'));
  assert(app.jobQueue.isClaimCurrent(job.id, job.claimToken));
  const snapshot = app.jobQueue.getJob(job.id)!;
  const retry = parseMailboxEntry(snapshot.payload);
  assert(retry);
  assert.deepEqual(await writer.run(sdkNeoWakeQueue, { prepare: [retry, job.id, true] }), prepared);
  assert.equal(app.jobQueue.listActiveByPayload('message_delivery', { sessionId: root }).length, 1);
  saved = { jobId: job.id, message: { event: snapshot.payload.message, batch: batch.payload }, notes: 20 };
} finally {
  await transport.close();
  await app.cleanup();
}
assert(saved);
const reopened = new Database(dbPath, { readonly: true });
try {
  const expected = saved.message as { event: unknown; batch: { sessionId: string; messageUuid: string } };
  assert.deepEqual(new JobQueueRepository(reopened).getJob(saved.jobId)?.payload.message, expected.event);
  assert.deepEqual(new JobQueueRepository(reopened).getLatestByPayload('message_delivery', { sessionId: expected.batch.sessionId, messageUuid: expected.batch.messageUuid })?.payload, expected.batch);
  const observed = { writerRoundtrip: true, originalReportUnchanged: true, orderedNotes: saved.notes, claimPreserved: true, retrySnapshotStable: true, snapshotSurvivesReopen: true };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed));
} finally {
  reopened.close();
}
