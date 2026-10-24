import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { SESSION_EVENT_SCOPE, SessionExternalEventStore } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import type { ExternalEvent } from '../../../packages/daemon/src/lib/external-events/types.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data/daemon.db')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\necho refused >> "$HOME/../evidence/gh.log"\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in terminal replay proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const proof: Record<string, unknown> = { verified: false, providerTurns: 0, unstoredClosureDiscoveryVerified: false, cardAcknowledgementVerified: false };
const prefix = 'github/synthetic/replay/pull_request/';
const sql = () => app!.db.getDatabase();
const subscriptions = () => new SessionEventSubscriptionRepository(sql());
const jobs = () => sql().prepare("SELECT id, payload FROM job_queue WHERE queue = 'mailbox' ORDER BY id").all();
const receipts = () => sql().prepare('SELECT * FROM message_send_receipts ORDER BY key').all();
const history = () => sql().prepare('SELECT * FROM session_external_events ORDER BY id').all();
const ghCalls = () => existsSync(join(run, 'evidence/gh.log')) ? readFileSync(join(run, 'evidence/gh.log'), 'utf8') : '';
const snapshot = () => ({ jobs: jobs(), receipts: receipts(), subscriptions: subscriptions().listAll(), history: history() });
function event(id: string, pr: number, action: string, state: string, at: number): ExternalEvent {
  return { id, spaceId: SESSION_EVENT_SCOPE, source: 'github', topic: `${prefix}${pr}.${action}`, dedupeKey: id, summary: `Synthetic ${action}`, occurredAt: at, ingestedAt: at, urgency: 'queued', payload: { state, prNumber: pr } };
}
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  app.db.updateGlobalSettings({ neo: { packs: [] } });
  await new ExternalEventExtensionConfigStore(sql()).setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { polling: true, rpcConfig: true } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC unavailable')); });
}
async function close() { ws?.close(); ws = undefined; await app?.cleanup(); app = undefined; }
async function poll() {
  return new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = message => {
      const reply = JSON.parse(String(message.data)); if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); done(reply);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', method: 'space.github.pollOnce', data: {}, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
try {
  await open(); proof.runtime = { commit: BUILD_METADATA.commit, pid: process.pid, port: app!.server.port };
  for (const [id, status] of [['synthetic-general', 'active'], ['synthetic-review-only', 'active'], ['synthetic-archived', 'archived']] as const) {
    await app!.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status, config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  }
  for (const [sessionId, pattern] of [['synthetic-general', '7.*'], ['synthetic-review-only', '7.review_*'], ['synthetic-archived', '7.*'], ['synthetic-general', '8.*'], ['synthetic-general', '9.*'], ['synthetic-general', '*.review_*']]) subscriptions().upsert({ sessionId, topic: prefix + pattern });
  const store = new SessionExternalEventStore(sql());
  for (const e of [event('terminal-7', 7, 'polled', 'closed', 100), event('comment-7', 7, 'review_submitted', 'open', 300), event('old-terminal-8', 8, 'closed', 'closed', 100), event('reopened-8', 8, 'reopened', 'open', 200), event('late-old-terminal-8', 8, 'closed', 'closed', 50)]) store.store(e);
  const originalHistory = history(), ghBefore = ghCalls();
  const config = new ExternalEventExtensionConfigStore(sql());
  await config.setGlobalConfig('github', { source: 'github', globallyEnabled: false, capabilities: { polling: true, rpcConfig: true } });
  proof.disabledPoll = await poll(); assert.equal(jobs().length, 0);
  assert((proof.disabledPoll as Record<string, unknown>).error);
  assert.equal(subscriptions().listAll().length, 5);
  await config.setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { polling: true, rpcConfig: true } });
  sql().exec("CREATE TRIGGER reject_terminal BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' AND json_extract(NEW.payload, '$.to.sessionId') = 'synthetic-review-only' BEGIN SELECT RAISE(ABORT, 'synthetic terminal rejection'); END");
  proof.failedPoll = await poll(); proof.afterFailure = snapshot();
  assert.equal(jobs().length, 1, 'poll must attempt final delivery even for queued terminal facts');
  assert.match(String((proof.failedPoll as Record<string, unknown>).error), /handler failure/);
  assert.equal(receipts().length, 1);
  assert.equal(subscriptions().listAll().filter(s => s.topic.startsWith(prefix + '7.')).length, 2);
  const firstAcceptance = { jobs: jobs(), receipts: receipts() };
  sql().prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'mailbox'").run(Date.now() + 86400000);
  await close(); await open();
  proof.retryAfterRestart = await poll(); assert.deepEqual({ jobs: jobs(), receipts: receipts() }, firstAcceptance);
  sql().exec('DROP TRIGGER reject_terminal');
  proof.recoveredPoll = await poll(); proof.afterRecovery = snapshot();
  assert.equal((proof.recoveredPoll as Record<string, unknown>).error, undefined);
  assert.equal(jobs().length, 2); assert.equal(receipts().length, 2);
  assert.deepEqual(jobs().map((r: { payload: string }) => JSON.parse(r.payload).to.sessionId).sort(), ['synthetic-general', 'synthetic-review-only']);
  assert.deepEqual(subscriptions().listAll().map(s => s.topic).sort(), [prefix + '*.review_*', prefix + '8.*', prefix + '9.*'].sort());
  assert.equal(subscriptions().listBySession('synthetic-archived').length, 1);
  assert.deepEqual(history(), originalHistory);
  const accepted = { jobs: jobs(), receipts: receipts() };
  subscriptions().upsert({ sessionId: 'synthetic-general', topic: prefix + '7.*' });
  subscriptions().upsert({ sessionId: 'synthetic-review-only', topic: prefix + '7.review_*' });
  await poll(); await poll(); assert.deepEqual({ jobs: jobs(), receipts: receipts() }, accepted);
  assert.equal(subscriptions().listAll().filter(s => s.topic.startsWith(prefix + '7.')).length, 0);
  assert.equal(sql().prepare('SELECT count(*) AS count FROM sdk_messages').get().count, 0);
  assert.equal(ghCalls(), ghBefore);
  proof.afterRepeatedPolls = snapshot(); proof.verified = true;
  console.log(JSON.stringify({ verified: true, finalMailboxJobs: jobs().length, receipts: receipts().length, historyPreserved: true }));
} finally {
  await close(); globalThis.fetch = network; proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/terminal-replay.json'), JSON.stringify(proof, null, 2));
}
