import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { readCodingLedgerRepo } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { SessionEventSubscriptionRepository } from '../../../packages/daemon/src/storage/repositories/session-event-subscription-repository.ts';

const [mode, scenario, portText, runText] = process.argv.slice(2);
const port = Number(portText), run = resolve(runText);
assert(['reproduce', 'verify'].includes(mode));
assert(['private', 'exhausted', 'secondary'].includes(scenario));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
mkdirSync(join(run, 'bin'), { recursive: true });
mkdirSync(join(run, 'evidence'));
const repos = ['a-public', 'b-public', 'c-public', 'd-phone', 'e-qlark', 'f-money', 'g-ops', 'h-review', 'i-research', 'j-review-test'];
const calls: { path: string; authenticated: boolean; limit: number; resource: string; status: number }[] = [];
const api = (url: URL, authenticated: boolean) => {
  const repo = url.pathname.split('/')[3];
  const secondary = authenticated && scenario === 'secondary' && calls.length === 0;
  const status = secondary ? 403 : authenticated || repos.indexOf(repo) < 3 ? 200 : scenario === 'private' ? 404 : 403;
  let body: unknown = [];
  if (status !== 200) body = { message: status === 404 ? 'Not Found' : 'API rate limit exceeded' };
  else if (/\/pulls\/\d+$/.test(url.pathname)) body = { number: 162, state: 'open', mergeable: true };
  else if (url.pathname.endsWith('/reviews')) body = [{ id: 1000 + repos.indexOf(repo), state: 'APPROVED', submitted_at: new Date().toISOString(), user: { login: 'synthetic-reviewer' } }];
  if (url.pathname === '/user') body = { login: 'synthetic-human' };
  const limit = authenticated ? 5000 : 60;
  calls.push({ path: url.pathname, authenticated, limit, resource: 'core', status });
  return Response.json(body, { status, headers: { 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': authenticated ? '4900' : scenario === 'exhausted' ? '0' : '59', 'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + 3600), 'X-RateLimit-Resource': 'core', ...(secondary ? { 'Retry-After': '2' } : {}) } });
};
const ledgerCalls: unknown[] = [];
const mock = createServer(async (req, res) => {
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    const args = JSON.parse(text) as string[];
    assert.equal(args[0], 'api');
    assert(args.includes('--include'));
    assert(!args.includes('auth'));
    if (args.includes('graphql')) {
      const budget = { cost: 7, remaining: 4866, resetAt: new Date(Date.now() + 3600_000).toISOString() };
      ledgerCalls.push({ resource: 'graphql', ...budget });
      res.end(`HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ data: { rateLimit: budget } })}`);
      return;
    }
    const path = args.find(arg => arg.startsWith('/repos/') || arg === '/user');
    assert(path);
    const response = api(new URL(path, 'https://api.github.com'), true);
    res.end(`HTTP/2.0 ${response.status} Synthetic\r\n${[...response.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${await response.text()}`);
  } catch { res.statusCode = 500; res.end('invalid fixture request'); }
});
await new Promise<void>(done => mock.listen(0, '127.0.0.1', done));
const mockPort = (mock.address() as { port: number }).port;
assert(mockPort !== 8399);
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] !== 'api' || !args.includes('--include')) process.exit(2);\nconst response = await fetch('http://127.0.0.1:${mockPort}', {method:'POST', body:JSON.stringify(args)});\nprocess.stdout.write(await response.text());\n`, { mode: 0o700 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.hostname, 'api.github.com');
  return api(url, false);
}) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const evidence: unknown[] = [];
try {
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  const github = app.extensionManager.getExtension('github') as GitHubEventExtension;
  const config = new ExternalEventExtensionConfigStore(db);
  await config.setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { polling: true, rpcConfig: true } });
  const sessionId = 'synthetic-private-owner';
  await app.db.createSession({ id: sessionId, title: 'Synthetic private PR owner', workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: {}, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const subscriptions = new SessionEventSubscriptionRepository(db);
  for (const repo of repos) {
    const row = github.repo.upsertWatchedRepo({ spaceId: 'sessions', owner: 'synthetic', repo, pollingEnabled: true });
    subscriptions.upsert({ sessionId, topic: `github/synthetic/${repo}/pull_request/162.*` });
    if (repos.indexOf(repo) < 3) db.prepare('UPDATE space_github_watched_repos SET last_poll_at = ? WHERE id = ?').run(Date.now() - 3600_000, row.id);
  }
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (method: string) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 30_000);
    ws!.onmessage = event => { const msg = JSON.parse(String(event.data)); if (msg.id !== id && msg.requestId !== id) return; clearTimeout(timer); msg.error ? fail(new Error(JSON.stringify(msg.error))) : done(msg.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', method, data: {}, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const started = Date.now();
  for (let cycle = 1; cycle <= 2; cycle++) {
    const reply = await rpc('space.github.pollOnce');
    const rows = github.repo.listPollingRepos().map(repo => ({ repo: repo.repo, lastPollAt: repo.lastPollAt }));
    const approvals = db.prepare("SELECT topic FROM session_external_events WHERE json_extract(payload_json, '$.state') = 'APPROVED'").all();
    const mailbox = db.prepare("SELECT COUNT(*) AS count FROM job_queue WHERE queue = 'mailbox'").get() as { count: number };
    evidence.push({ cycle, reply, rows, approvals, mailbox, calls: [...calls] });
    if (mode === 'reproduce') {
      assert(rows.filter(row => repos.indexOf(row.repo) >= 3).every(row => row.lastPollAt === null));
      assert(calls.every(call => !call.authenticated));
    } else {
      if (scenario === 'secondary' && cycle === 1) {
        assert((reply as { retryAt: number }).retryAt <= Date.now() + 2100);
        assert((reply as { skipped: string }).skipped === 'rate-limited');
        await new Promise(done => setTimeout(done, 2100));
        continue;
      }
      assert(rows.every(row => row.lastPollAt !== null && row.lastPollAt >= started));
      assert(calls.every(call => call.authenticated && call.limit === 5000 && call.resource === 'core'));
      assert.equal(approvals.length, 10);
      assert(mailbox.count >= 1);
    }
  }
  if (mode === 'verify') {
    const tokenStatus = await rpc('space.github.getTokenStatus') as { configured: boolean; source: string; login?: string };
    assert(tokenStatus.configured && tokenStatus.source === 'gh' && tokenStatus.login === 'synthetic-human');
    evidence.push({ tokenStatus });
    await readCodingLedgerRepo('synthetic/a-public');
    assert.equal(ledgerCalls.length, 1);
    evidence.push({ ledgerDiagnostics: ledgerCalls });
  }
  console.log(`${mode} ${scenario}: ${run}/evidence/auth-bucket.json`);
} finally {
  writeFileSync(join(run, 'evidence/auth-bucket.json'), JSON.stringify(evidence, null, 2));
  ws?.close();
  await app?.cleanup();
  globalThis.fetch = realFetch;
  await new Promise<void>(done => mock.close(() => done()));
}
