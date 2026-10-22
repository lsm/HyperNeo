import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import {
  normalizeGitHubReview,
  toExternalEvent,
} from '../../../packages/daemon/src/lib/external-events/github/github-normalizer.ts';
import { SessionExternalEventStore } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';
import { mailSessionEvent } from '../../../packages/daemon/src/lib/external-events/session-event-delivery.ts';

const [mode, directory] = process.argv.slice(2),
  run = resolve(directory);
assert(['before', 'verify', 'observe'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'bin'));
mkdirSync(join(run, 'evidence'));
const now = Date.now(),
  old = now - 6 * 86400000,
  floor = now - 86400000;
const review = (id: number, body: string, at: number) => ({
  id,
  body,
  state: 'APPROVED',
  submitted_at: new Date(at).toISOString(),
  user: { login: 'synthetic-reviewer', type: 'User' },
  commit_id: 'a'.repeat(40),
});
const prior = review(800, 'Previously delivered verdict', now - 120000);
const rows = {
  old: [review(700, 'Historical merged verdict', old)],
  fresh: [prior, review(801, 'Fresh verdict', now - 60000)],
  next: review(802, 'Next verdict', now - 30000),
};
writeFileSync(join(run, 'rows.json'), JSON.stringify(rows));
writeFileSync(join(run, 'phase'), 'first');
writeFileSync(
  join(run, 'bin/gh'),
  `#!${process.execPath}
const fs=require('node:fs'),root=${JSON.stringify(run)},args=process.argv.slice(2);
if(args[0]!=='api')process.exit(2);
const path=args.find(a=>a.startsWith('/repos/')||a==='/user');if(!path)process.exit(2);
const rows=JSON.parse(fs.readFileSync(root+'/rows.json','utf8')),phase=fs.readFileSync(root+'/phase','utf8');
let body=[];
if(path==='/user')body={login:'synthetic-self'};
else if(path.includes('/pulls/7/reviews'))body=rows.old;
else if(path.includes('/pulls/8/reviews'))body=phase==='first'?rows.fresh:[...rows.fresh,rows.next];
else if(/\\/pulls\\/[78](?:\\?|$)/.test(path))body={number:path.includes('/7')?7:8,state:path.includes('/7')?'closed':'open',merged:path.includes('/7'),mergeable:true,head:{sha:'a'.repeat(40)}};
else if(path.includes('/check-runs'))body={check_runs:[]};
fs.appendFileSync(root+'/evidence/requests.jsonl',JSON.stringify({path,phase})+'\\n');
if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\nX-RateLimit-Remaining: 4900\\r\\nX-RateLimit-Limit: 5000\\r\\n\\r\\n');
process.stdout.write(JSON.stringify(body));
`,
  { mode: 0o700 }
);
const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('No real HTTP in proof');
}) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, unknown> = { mode, now, old, floor };
try {
  app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    verbose: false,
  });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  for (const [id, status] of [
    ['active-worker', 'active'],
    ['archived-worker', 'archived'],
  ] as const)
    app.db.createSession({
      id,
      title: 'Synthetic ' + id,
      workspacePath: join(run, 'home'),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status,
      config: {},
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    });
  const subscriptions = new SessionEventSubscriptionRepository(db);
  subscriptions.upsert({
    sessionId: 'active-worker',
    topic: 'github/synthetic/replay/pull_request/7.*',
  });
  subscriptions.upsert({
    sessionId: 'active-worker',
    topic: 'github/synthetic/replay/pull_request/8.*',
  });
  subscriptions.upsert({
    sessionId: 'archived-worker',
    topic: 'github/synthetic/replay/pull_request/8.*',
  });
  const github = app.extensionManager.getExtension('github') as GitHubEventExtension;
  github.repo.upsertWatchedRepo({
    spaceId: 'sessions',
    owner: 'synthetic',
    repo: 'replay',
    pollingEnabled: true,
  });
  const watched = github.repo.listPollingRepos()[0];
  github.repo.updatePollCursor(watched.id, {
    lastSeenAt: 0,
    reviewLastSeenAt: { 7: old },
    recentPullRequestNumbers: [7, 8],
    endpointLastSeenAt: { pulls: floor, issue_comments: floor, review_comments: floor },
    pollResume: { stage: 5, item: '7', page: 1, skipFeeds: true },
  });
  const normalized = normalizeGitHubReview(watched, 8, prior);
  assert(normalized);
  new SessionExternalEventStore(db).store(toExternalEvent('sessions', normalized));
  await mailSessionEvent(app.jobQueue, {
    sessionId: 'active-worker',
    messageUuid: 'previous-delivery',
    text: 'Previously delivered verdict',
    mode: 'immediate',
  });
  db.prepare("UPDATE job_queue SET status='completed' WHERE queue='mailbox'").run();
  await new ExternalEventExtensionConfigStore(db).setGlobalConfig('github', {
    source: 'github',
    globallyEnabled: true,
    capabilities: { polling: true, rpcConfig: true },
  });
  ws = new WebSocket('ws://127.0.0.1:' + app.server.port + '/ws');
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('RPC unavailable'));
  });
  const poll = () =>
    new Promise<unknown>((done, fail) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => fail(new Error('RPC timeout')), 30000);
      ws!.onmessage = (event) => {
        const m = JSON.parse(String(event.data));
        if (m.id !== id && m.requestId !== id) return;
        clearTimeout(timer);
        m.error ? fail(new Error(JSON.stringify(m.error))) : done(m.data);
      };
      ws!.send(
        JSON.stringify({
          id,
          type: 'REQ',
          method: 'space.github.pollOnce',
          data: {},
          sessionId: 'global',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    });
  evidence.first = await poll();
  writeFileSync(join(run, 'phase'), 'next');
  evidence.next = await poll();
  evidence.repeat = await poll();
  const mailbox = db
    .prepare(
      "SELECT json_extract(payload,'$.to.sessionId') target,payload FROM job_queue WHERE queue='mailbox'"
    )
    .all() as { target: string; payload: string }[];
  const count = (target: string, text: string) =>
    mailbox.filter((row) => row.target === target && row.payload.includes(text)).length;
  evidence.counts = {
    historical: count('active-worker', 'Historical merged verdict'),
    fresh: count('active-worker', 'Fresh verdict'),
    next: count('active-worker', 'Next verdict'),
    prior: count('active-worker', 'Previously delivered verdict'),
    archived: mailbox.filter((row) => row.target === 'archived-worker').length,
  };
  evidence.mailbox = mailbox.map((row) => ({
    target: row.target,
    payload: JSON.parse(row.payload),
  }));
  evidence.cursor = github.repo.getWatchedRepoById(watched.id)?.pollCursor;
  evidence.storedEvents = db
    .prepare(
      'SELECT topic,dedupe_key,occurred_at FROM session_external_events ORDER BY occurred_at'
    )
    .all();
  evidence.subscriptions = db
    .prepare('SELECT session_id,topic FROM session_event_subscriptions ORDER BY session_id,topic')
    .all();
  const counts = evidence.counts as Record<string, number>;
  if (mode === 'before') {
    assert(counts.historical > 0);
    assert(counts.archived > 0);
  }
  if (mode === 'verify') {
    assert.deepEqual(counts, { historical: 0, fresh: 1, next: 1, prior: 1, archived: 0 });
    assert.equal((evidence.storedEvents as unknown[]).length, 3);
  }
  assert.equal((evidence.subscriptions as unknown[]).length, 3);
  console.log(JSON.stringify({ mode, counts }));
} finally {
  writeFileSync(join(run, 'evidence/review-replay.json'), JSON.stringify(evidence, null, 2));
  ws?.close();
  await app?.cleanup();
  globalThis.fetch = realFetch;
}
