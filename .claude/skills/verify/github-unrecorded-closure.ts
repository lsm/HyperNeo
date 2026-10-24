import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { normalizeGitHubPollingRow, toExternalEvent } from '../../../packages/daemon/src/lib/external-events/github/github-normalizer.ts';
import { SessionExternalEventStore } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data/daemon.db')));
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[k], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
let phase = 'open', app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const requests: { phase: string; path: string; conditional: string | null }[] = [], closedAt = '2026-10-23T10:00:00Z', sha = 'a'.repeat(40);
const row = (number: number, state = 'closed') => ({ id: number, number, state, closed_at: state === 'closed' ? closedAt : null, updated_at: state === 'closed' ? closedAt : '2026-10-20T00:00:00Z', title: 'Synthetic PR', head: { sha }, user: { login: 'synthetic-self' }, html_url: `https://github.com/synthetic/discovery/pull/${number}` });
const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname, conditional = request.headers.get('if-none-match'); requests.push({ phase, path, conditional });
  const headers = { 'content-type': 'application/json', 'x-ratelimit-remaining': '4900', etag: 'old-etag' };
  if (path === '/user') return Response.json({ login: 'synthetic-self' }, { headers });
  const number = /\/pulls\/(\d+)$/.exec(path)?.[1];
  if (number) {
    if (phase === 'unreadable') return new Response('Synthetic unavailable', { status: 503, headers });
    if (phase === 'notmodified' || conditional) return new Response(null, { status: 304, headers });
    return Response.json({ ...row(Number(number), phase === 'open' ? 'open' : 'closed'), ...(phase === 'missing' ? { closed_at: null } : {}) }, { headers });
  }
  return Response.json(path.endsWith('/check-runs') ? { check_runs: [] } : [], { headers });
} });
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}
const args=process.argv.slice(2),path=args.find(a=>a.startsWith('/repos/synthetic/discovery')||a==='/user');if(args[0]!=='api'||!path)process.exit(1);
const headers={};for(let i=0;i<args.length;i++)if(args[i]==='-H'&&args[i+1].toLowerCase().startsWith('if-none-match:'))headers['if-none-match']=args[i+1].slice(14).trim();
const r=await fetch(${JSON.stringify(fixture.url.origin)}+path,{headers});if(args.includes('--include')){process.stdout.write('HTTP/1.1 '+r.status+' Synthetic\\r\\n');for(const [k,v]of r.headers)process.stdout.write(k+': '+v+'\\r\\n');process.stdout.write('\\r\\n');}process.stdout.write(await r.text());
`, { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, 'https://api.github.com'); assert(url.pathname === '/user' || url.pathname.startsWith('/repos/synthetic/discovery'));
  return network(new URL(url.pathname + url.search, fixture.url), init);
}) as typeof fetch;
const proof: Record<string, unknown> = { verified: false, providerTurns: 0, cardAcknowledgementVerified: false };
const sql = () => app!.db.getDatabase(), subs = () => new SessionEventSubscriptionRepository(sql());
const jobs = () => sql().prepare("SELECT id, payload FROM job_queue WHERE queue = 'mailbox' ORDER BY id").all();
const receipts = () => sql().prepare('SELECT * FROM message_send_receipts ORDER BY key').all();
const events = () => sql().prepare('SELECT * FROM session_external_events ORDER BY created_at, rowid').all();
const prefix = 'github/synthetic/discovery/pull_request/';
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399); app.db.updateGlobalSettings({ neo: { packs: [] } });
  await new ExternalEventExtensionConfigStore(sql()).setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { polling: true, rpcConfig: true, webhooks: false } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC unavailable')); });
}
async function close() { ws?.close(); ws = undefined; await app?.cleanup(); app = undefined; }
async function poll() {
  return new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 20000);
    ws!.onmessage = message => { const reply = JSON.parse(String(message.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); done(reply); };
    ws!.send(JSON.stringify({ id, type: 'REQ', method: 'space.github.pollOnce', data: {}, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
try {
  await open(); proof.runtime = { commit: BUILD_METADATA.commit, pid: process.pid, port: app!.server.port };
  for (const id of ['synthetic-general', 'synthetic-review']) await app!.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  subs().upsert({ sessionId: 'synthetic-general', topic: prefix + '7.*' }); subs().upsert({ sessionId: 'synthetic-review', topic: prefix + '7.review_*' });
  const github = () => app!.extensionManager.getExtension('github') as GitHubEventExtension;
  github().repo.upsertWatchedRepo({ spaceId: 'sessions', owner: 'synthetic', repo: 'discovery', pollingEnabled: true });
  const seed = () => { const watched = github().repo.listPollingRepos()[0]; github().repo.updatePollCursor(watched.id, { ...watched.pollCursor, pollResume: { stage: 4, item: '7', skipFeeds: true }, recentPullRequestNumbers: [], mergeConflictEtags: { 7: 'old-etag', 8: 'old-etag' } }); };
  const original = normalizeGitHubPollingRow({ owner: 'synthetic', repo: 'discovery' }, row(7, 'open'), 'pulls')!;
  new SessionExternalEventStore(sql()).store(toExternalEvent('sessions', original)); const originalRows = events();
  for (phase of ['open', 'missing', 'unreadable', 'notmodified']) { seed(); await poll(); assert.equal(jobs().length, 0); assert.equal(subs().listAll().length, 2); }
  phase = 'closed'; seed(); sql().exec("CREATE TRIGGER reject_discovery BEFORE INSERT ON job_queue WHEN NEW.queue='mailbox' AND json_extract(NEW.payload,'$.to.sessionId')='synthetic-review' BEGIN SELECT RAISE(ABORT,'synthetic rejection'); END");
  proof.discoveryPoll = await poll(); proof.discovered = { jobs: jobs(), events: events(), subscriptions: subs().listAll() };
  assert(requests.filter(r => r.phase === 'closed' && r.path.endsWith('/pulls/7')).every(r => r.conditional === null), 'subscribed details need a full body');
  assert.equal(jobs().length, 1); assert.equal(receipts().length, 1); assert.equal(events().length, 2); assert.equal(subs().listAll().length, 2);
  const accepted = { jobs: jobs(), receipts: receipts() }, recorded = events();
  sql().prepare("UPDATE job_queue SET run_at=? WHERE queue='mailbox'").run(Date.now() + 86400000);
  await close(); await open(); phase = 'restart'; await poll(); assert.deepEqual({ jobs: jobs(), receipts: receipts() }, accepted);
  sql().exec('DROP TRIGGER reject_discovery'); phase = 'recover'; await poll(); assert.equal(jobs().length, 2); assert.equal(receipts().length, 2); assert.equal(subs().listAll().length, 0); assert.deepEqual(events(), recorded);
  subs().upsert({ sessionId: 'synthetic-general', topic: prefix + '7.*' }); await poll(); assert.equal(jobs().length, 2); assert.deepEqual(events(), recorded);
  const reopened = toExternalEvent('sessions', normalizeGitHubPollingRow({ owner: 'synthetic', repo: 'discovery' }, { ...row(8, 'open'), updated_at: '2026-10-24T00:00:00Z' }, 'pulls')!);
  new SessionExternalEventStore(sql()).store(reopened); subs().upsert({ sessionId: 'synthetic-general', topic: prefix + '8.*' }); phase = 'stale-close'; seed(); await poll();
  assert.equal(subs().listBySession('synthetic-general').length, 1); assert.equal(jobs().length, 2); assert.equal(new SessionExternalEventStore(sql()).latestPrState(prefix.slice(0, -1) + '/8')?.event.id, reopened.id);
  assert.deepEqual(events().slice(0, originalRows.length), originalRows); assert.equal(sql().prepare('SELECT count(*) AS count FROM sdk_messages').get().count, 0);
  proof.afterRecovery = { jobs: jobs(), receipts: receipts(), events: events(), subscriptions: subs().listAll() }; proof.verified = true; console.log(JSON.stringify({ verified: true, mailboxJobs: jobs().length, historyPreserved: true }));
} finally {
  await close(); await fixture.stop(true); globalThis.fetch = network; proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/unrecorded-closure.json'), JSON.stringify(proof, null, 2)); writeFileSync(join(run, 'evidence/requests.json'), JSON.stringify(requests, null, 2));
}
