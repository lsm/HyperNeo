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
  for (let index = 0; index < 20; index++) {
    const entry = createMailboxEntry({ to: { kind: 'session', sessionId: root }, origin: 'session:synthetic-worker', messageUuid: `note-${index}`, message: { type: 'user', parent_tool_use_id: null, message: { content: `message-body-${String(index).padStart(2, '0')}` } } });
    await writer.call(neoWakeQueueWrite, 'hold', entry);
  }
  await handoffPromptToMailbox({ to: `session:${encodeURIComponent(root)}`, origin: 'session:synthetic-worker', messageUuid: 'store-trigger', message: { type: 'user', parent_tool_use_id: null, workerReportKind: 'blocked', message: { content: 'Original report.' } }, jobQueue: app.jobQueue });
  const [job] = await writer.call(jobQueueWrites, 'dequeue', 'mailbox', 1);
  const entry = parseMailboxEntry(job.payload);
  assert(entry);
  const prepared = await writer.call(neoWakeQueueWrite, 'prepare', entry, job.id, true);
  assert(prepared);
  assert.equal(prepared.message.message.content, 'Original report.');
  const body = JSON.stringify(prepared.message.neoBatchContent);
  let previous = -1;
  for (let index = 0; index < 20; index++) {
    const at = body.indexOf(`message-body-${String(index).padStart(2, '0')}`);
    assert(at > previous);
    previous = at;
  }
  assert(body.indexOf('Original report.') > previous);
  assert(app.jobQueue.isClaimCurrent(job.id, job.claimToken));
  const snapshot = app.jobQueue.getJob(job.id)!;
  const retry = parseMailboxEntry(snapshot.payload);
  assert(retry);
  assert.deepEqual(await writer.call(neoWakeQueueWrite, 'prepare', retry, job.id, true), prepared);
  saved = { jobId: job.id, message: snapshot.payload.message, notes: 20 };
} finally {
  await transport.close();
  await app.cleanup();
}
assert(saved);
const reopened = new Database(dbPath, { readonly: true });
try {
  assert.deepEqual(new JobQueueRepository(reopened).getJob(saved.jobId)?.payload.message, saved.message);
  const observed = { writerRoundtrip: true, originalReportUnchanged: true, orderedNotes: saved.notes, claimPreserved: true, retrySnapshotStable: true, snapshotSurvivesReopen: true };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed));
} finally {
  reopened.close();
}
