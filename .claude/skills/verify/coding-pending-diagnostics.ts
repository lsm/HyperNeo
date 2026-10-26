import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

const run = resolve(process.argv[2]), repo = 'synthetic/pending', alias = 'synthetic/old-pending', root = 'synthetic-neo', owner = 'synthetic-owner';
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No external HTTP in pending diagnosis proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, neo: ReturnType<typeof createNeoService> | undefined, ws: WebSocket | undefined;
let phase = 'pending', reads = 0;
const proof: Record<string, unknown> = { verified: false, providerTurns: 0, recipientConsumptionVerified: false };
const start = Date.now(), stale = start + 15 * 60_000, reset = stale + 60_000;
const sql = () => app!.db.getDatabase();
const jobs = () => sql().prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY id").all().map((row: { payload: string }) => JSON.parse(row.payload));
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connect')); });
}
async function close() { ws?.close(); ws = undefined; await neo?.dispose(); neo = undefined; await app?.cleanup(); app = undefined; }
async function rpc(name: string, input: unknown) {
  return new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
function pack() {
  const db = sql();
  return createCodingPack({ database: () => db, readPrs: async () => [], readClaudeOwners: async () => [], todoPrs: new CodingTodoPrRepository(db), prLedger: new CodingPrLedgerRepository(db), prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db), projectRepos: () => [repo], prSweepDeps: { tell: (ref, key, text) => neo!.sendToRef(ref, key, text), wake: (key, text) => neo!.wakeNeo(key, text) }, readLedgerRepo: async (_repo, previous) => {
    if (phase === 'rate' && previous?.retryAt) return { error: 'GitHub acquisition cooldown', retryAt: reset, quota: { ...previous, deferred: true } };
    reads++;
    if (phase === 'rate') return { error: 'HTTP 429 synthetic-private-diagnostic', retryAt: reset, quota: { status: 429, resource: 'graphql', remaining: 0, resetAt: reset, requestId: 'synthetic', retryAfterMs: null, credentialBucket: 'synthetic:1', retryAt: reset } };
    const node = { number: 1, title: 'Synthetic approved work', headRefName: 'topic', headRefOid: 'approved-head', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', closedAt: null, reviews: { nodes: [{ state: 'APPROVED', commit: { oid: 'approved-head' }, author: { login: 'synthetic-reviewer' } }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: phase === 'green' ? 'SUCCESS' : 'PENDING' } } }] } };
    return { data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false }, nodes: [node] }, done: { nodes: [] } } } };
  } });
}
try {
  await open();
  for (const id of [root, owner]) await app!.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  neo!.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
  for (const [key, value] of Object.entries({ mergePolicy: 'review_bot', reviewBot: 'synthetic-reviewer', watchedRepos: [repo] })) assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: key === 'watchedRepos' ? { kind: 'global', key: '' } : { kind: 'repo', key: repo }, key, value })).ok, true);
  const coding = pack();
  await coding.observeSessions!([{ ref: { adapter: 'hyperneo', id: owner }, status: 'running', lastActivityAt: start, remotes: [], branches: [], openedPrs: [`https://github.com/${repo}/pull/1`] }], start);
  await coding.sweep!(start); assert.equal(jobs().length, 0);
  await new CodingPrLedgerRepository(sql()).write('recordAlias', alias, repo);
  assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'global', key: '' }, key: 'watchedRepos', value: [alias] })).ok, true);
  phase = 'rate'; await coding.sweep!(stale);
  proof.beforeRestart = { snapshot: await rpc('neo.snapshot', {}), health: new CodingPrLedgerRepository(sql()).health.read(repo), jobs: jobs() };
  const pending = new CodingPrLedgerRepository(sql()).snapshot(null, stale)[0];
  const publicSnapshot = (proof.beforeRestart as { snapshot: { packRows: Array<{ pack: string; rows: unknown[] }> } }).snapshot;
  assert.deepEqual(publicSnapshot.packRows.find(pack => pack.pack === 'coding')?.rows, [pending]);
  assert.equal(pending.lastError, 'rate_limited', 'pending rows must expose acquisition diagnostics');
  assert.equal(pending.readAt, start); assert.equal(pending.completeAt, start); assert.equal(pending.nextRetryAt, reset);
  assert(!JSON.stringify(proof.beforeRestart).includes('synthetic-private-diagnostic'));
  assert.equal(jobs().length, 1); assert.equal(jobs()[0].to.sessionId, root);
  assert(jobs()[0].messageUuid.startsWith('github-pending:'));
  sql().prepare("UPDATE job_queue SET run_at=? WHERE queue='mailbox'").run(Date.now() + 86400000);
  await close(); await open();
  const reopened = pack(), count = reads;
  await reopened.sweep!(stale + 1); assert.equal(reads, count); assert.equal(jobs().length, 1);
  phase = 'green'; await reopened.sweep!(reset); await reopened.sweep!(reset + 1);
  const accepted = jobs();
  proof.afterRestart = { snapshot: await rpc('neo.snapshot', {}), jobs: accepted, reads };
  assert.equal(accepted.length, 2);
  const ready = accepted.filter(job => job.messageUuid === `neo-pr-event:${repo}#1:approved-head:approved_green`);
  assert.equal(ready.length, 1); assert.equal(ready[0].to.sessionId, owner);
  assert(sql().prepare('SELECT told_at FROM pack_coding_pr_ledger').get().told_at);
  const health = new CodingPrLedgerRepository(sql()).health.read(repo)!;
  assert.equal(health.nextRetryAt, null); assert.equal(health.lastError, 'rate_limited'); assert.equal(health.lastErrorAt, stale);
  proof.afterRestart = { snapshot: await rpc('neo.snapshot', {}), health, jobs: accepted, reads };
  assert.equal(sql().prepare('SELECT count(*) AS n FROM sdk_messages').get().n, 0);
  proof.verified = true; console.log('PASS: pending diagnostics and one stale notice survive reopen; reset resumes one approved-green owner event');
} finally {
  await close(); globalThis.fetch = network; proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/pending-diagnostics.json'), JSON.stringify(proof, null, 2));
}
