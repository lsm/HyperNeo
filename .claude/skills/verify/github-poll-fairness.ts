import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';

const [mode, portText, runText] = process.argv.slice(2);
const port = Number(portText), run = resolve(runText);
assert(['reproduce', 'verify', 'resume-reproduce', 'resume-verify'].includes(mode));
const resume = mode.startsWith('resume-');
const committed = Date.parse('2026-01-01T00:00:00Z');
const occurred = '2026-01-01T00:01:00Z';
const updated = '2026-01-01T00:02:00Z';
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'));
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
const repos = resume ? ['resume-4', 'resume-5', 'resume-6'] : ['a-heavy', 'b-phone', 'c-ops', 'd-research'];
let cycle = 0, remaining = 40;
const calls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.hostname, 'api.github.com', `unmocked network: ${url.hostname}`);
  calls.push(url.pathname);
  const repo = url.pathname.split('/')[3];
  let body: unknown = [];
  if (resume) {
    const row = { id: 30, number: 3, state: 'open', title: 'New PR', updated_at: updated, head: { sha: 'new-head' }, user: { login: 'synthetic-human' } };
    if (url.pathname.endsWith('/pulls')) body = [row];
    if (/\/pulls\/\d+$/.test(url.pathname)) body = { ...row, number: Number(url.pathname.split('/').at(-1)), mergeable: true };
    if (url.pathname.endsWith('/pulls/3/reviews')) body = [{ id: 301, state: 'APPROVED', submitted_at: occurred, user: { login: 'synthetic-reviewer' } }];
    if (url.pathname.endsWith('/issues/3/reactions')) body = [{ id: 302, content: '+1', created_at: occurred, user: { login: 'synthetic-human' } }];
    if (url.pathname.endsWith('/check-runs')) body = { check_runs: [{ id: 303, name: 'build', status: 'completed', conclusion: 'failure', completed_at: occurred, app: { id: 1 }, pull_requests: [{ number: 3 }] }] };
  } else if (/\/pulls\/\d+$/.test(url.pathname)) {
    body = { number: Number(url.pathname.split('/')[5]), state: repo === 'a-heavy' ? 'closed' : 'open', mergeable: true };
  } else if (url.pathname.endsWith('/reviews') && repo !== 'a-heavy') {
    body = [{ id: cycle * 1000 + repos.indexOf(repo), state: 'APPROVED', body: 'Synthetic approval', submitted_at: new Date().toISOString(), user: { login: 'synthetic-reviewer' }, html_url: `https://github.com/verify-test/${repo}/pull/162#pullrequestreview-${cycle}` }];
  } else if (url.pathname === '/user') {
    body = { login: 'synthetic-human' };
  }
  return Response.json(body, { headers: { 'X-RateLimit-Remaining': String(resume ? 5000 : --remaining), 'X-RateLimit-Reset': '1' } });
}) as typeof fetch;
const broker = createServer(async (req, res) => {
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    const args = JSON.parse(text) as string[];
    assert.equal(args[0], 'api');
    assert(args.includes('--include'));
    const path = args.find(arg => arg.startsWith('/repos/') || arg === '/user');
    assert(path);
    const response = await globalThis.fetch(`https://api.github.com${path}`);
    res.end(`HTTP/2.0 ${response.status} Synthetic\r\n${[...response.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${await response.text()}`);
  } catch { res.statusCode = 500; res.end('invalid fixture'); }
});
await new Promise<void>(done => broker.listen(0, '127.0.0.1', done));
const brokerPort = (broker.address() as { port: number }).port;
assert(brokerPort !== 8399);
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] !== 'api' || !args.includes('--include')) process.exit(2);\nconst response = await fetch('http://127.0.0.1:${brokerPort}', {method:'POST', body:JSON.stringify(args)});\nprocess.stdout.write(await response.text());\n`, { mode: 0o700 });
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
const evidence: unknown[] = [];
try {
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  const github = app.extensionManager.getExtension('github') as GitHubEventExtension;
  assert(github instanceof GitHubEventExtension);
  const config = new ExternalEventExtensionConfigStore(db);
  await config.setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { polling: true, rpcConfig: true } });
  const sessionId = 'synthetic-poll-owner';
  await app.db.createSession({ id: sessionId, title: 'Synthetic poll owner', workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: {}, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const subscriptions = new SessionEventSubscriptionRepository(db);
  for (const repo of repos) {
    github.repo.upsertWatchedRepo({ spaceId: 'sessions', owner: 'verify-test', repo, pollingEnabled: true });
    const numbers = resume ? [3] : repo === 'a-heavy' ? Array.from({ length: 201 }, (_, i) => i + 1) : [162];
    for (const pr of numbers) subscriptions.upsert({ sessionId, topic: `github/verify-test/${repo}/pull_request/${pr}.*` });
  }
  if (resume) {
    for (const repo of repos) {
      const watched = github.repo.getWatchedRepo('sessions', 'verify-test', repo)!;
      github.repo.updatePollCursorJson(watched.id, { lastSeenAt: committed, recentPullRequestNumbers: [2], pollResume: { stage: Number(repo.at(-1)), item: '2' } });
    }
  }
  const heavy = github.repo.getWatchedRepo('sessions', 'verify-test', 'a-heavy');
  if (!resume) github.repo.updatePollCursorJson(heavy!.id, { lastSeenAt: 0, recentPullRequestHeadShas: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [i + 1, `head-${i + 1}`])) });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const poll = () => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('poll RPC timed out')), 20_000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', method: 'space.github.pollOnce', data: {}, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  for (cycle = 1; cycle <= (mode === 'reproduce' ? 1 : 3); cycle++) {
    calls.length = 0; remaining = 40;
    const reply = await poll();
    if (cycle === 1 && !resume) assert(calls[0].includes('/a-heavy/'));
    const polled = github.repo.listPollingRepos().map((repo) => ({ repo: repo.repo, lastPollAt: repo.lastPollAt, resume: repo.pollCursor }));
    const events = db.prepare('SELECT topic, payload_json FROM session_external_events').all() as { topic: string; payload_json: string }[];
    const approvals = repos.slice(1).filter(repo => events.some(event => event.topic.includes(`/${repo}/`) && JSON.parse(event.payload_json).reviewId === String(cycle * 1000 + repos.indexOf(repo))));
    const queued = db.prepare("SELECT COUNT(*) AS count FROM job_queue WHERE queue = 'mailbox'").get();
    evidence.push({ cycle, reply, remaining, calls: [...calls], polled, approvals, queued });
    if (resume) {
      const cutoff = mode === 'resume-verify' && cycle === 1 ? committed : Date.parse(updated);
      assert(polled.every(repo => repo.resume?.lastSeenAt === cutoff));
      if (cycle === 3) {
        const count = (repo: string, matches: (payload: Record<string, unknown>) => boolean) => events.filter(event => event.topic.includes(`/${repo}/`) && matches(JSON.parse(event.payload_json))).length;
        if (mode === 'resume-reproduce') {
          assert.equal(count('resume-4', payload => payload.checkRunId === 303), 0);
          for (const repo of ['resume-5', 'resume-6']) assert.equal(count(repo, payload => payload.reviewId === '301'), 0);
          assert.equal(count('resume-6', payload => payload.type === 'reaction'), 0);
        } else {
          for (const repo of repos) {
            assert.equal(count(repo, payload => payload.reviewId === '301'), 1);
            assert.equal(count(repo, payload => payload.type === 'reaction'), 1);
            assert.equal(count(repo, payload => payload.checkRunId === 303), 1);
          }
        }
      }
      evidence.push({ cycle, events });
    } else if (mode === 'reproduce') {
      assert.deepEqual(approvals, []);
      assert(polled.filter(repo => repo.repo !== 'a-heavy').every(repo => repo.lastPollAt === null));
    } else {
      assert.deepEqual(approvals, repos.slice(1));
      assert(polled.every(repo => repo.lastPollAt !== null));
      assert(remaining >= 10);
      assert((queued as { count: number }).count >= cycle * 3);
    }
  }
  console.log(`${resume ? mode : mode === 'reproduce' ? 'REPRODUCED starvation' : 'PASS: every small repo approval is published each cycle'}; ${run}/evidence/polling.json`);
} finally {
  writeFileSync(join(run, 'evidence/polling.json'), JSON.stringify(evidence, null, 2));
  ws?.close();
  await app.cleanup();
  globalThis.fetch = realFetch;
  await new Promise<void>(done => broker.close(() => done()));
}
