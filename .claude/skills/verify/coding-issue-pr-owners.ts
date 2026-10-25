import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
const repo = 'synthetic/MixedCase', root = 'synthetic-owner-neo';
const workers = ['synthetic-closing-worker', 'synthetic-opening-worker'];
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2), dir = ${JSON.stringify(run)};
if (args[0] !== 'api' || args[1] !== 'graphql' || !args.includes('o=synthetic') || !args.some(arg => arg.toLowerCase() === 'n=mixedcase')) process.exit(90);
appendFileSync(dir + '/evidence/requests.jsonl', JSON.stringify(args) + '\\n');
const response = JSON.parse(readFileSync(dir + '/fixture.json', 'utf8'));
if (!args.some(arg => arg.startsWith('query=') && /\\bbody\\b/.test(arg))) for (const pr of response.data.repository.open.nodes) delete pr.body;
process.stdout.write(JSON.stringify(response));
`, { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No external HTTP in ownership proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let neo: ReturnType<typeof createNeoService> | undefined;
let ws: WebSocket | undefined;
const proof: Record<string, unknown> = { verified: false, providerTurns: 0, recipientConsumptionVerified: false };
const sql = () => app!.db.getDatabase();
const jobs = () => sql().prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY id").all().map((row: { payload: string }) => JSON.parse(row.payload) as { to: { sessionId: string }; messageUuid: string });
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  app.db.updateGlobalSettings({ neo: { packs: [] } });
  neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connect')); });
}
async function close() { ws?.close(); ws = undefined; await neo?.dispose(); neo = undefined; await app?.cleanup(); app = undefined; }
function rpc(name: string, input: unknown) {
  return new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
function fixture(ci: string) {
  const nodes = [20, 21, 22].map(number => ({ number, body: number === 20 ? 'Closes Synthetic/MixedCase#7' : 'Related to Synthetic/MixedCase#7', title: `Synthetic PR ${number}`, headRefName: `unmatched-${number}`, headRefOid: `head-${number}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', closedAt: null, reviews: { nodes: [{ state: 'APPROVED', commit: { oid: `head-${number}` }, author: { login: 'synthetic-reviewer' } }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] } }));
  writeFileSync(join(run, 'fixture.json'), JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4000, resetAt: new Date(Date.now() + 3600000).toISOString() }, repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false }, nodes }, done: { nodes: [] } } } }));
}
function pack() {
  const db = sql();
  return createCodingPack({ database: () => db, readPrs: async () => [], readClaudeOwners: async () => [], todoPrs: new CodingTodoPrRepository(db), prLedger: new CodingPrLedgerRepository(db), prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db), projectRepos: () => [repo], prSweepDeps: { tell: (ref, key, text) => neo!.sendToRef(ref, key, text), wake: (key, text) => neo!.wakeNeo(key, text) } });
}
try {
  await open();
  for (const id of [root, ...workers]) await app!.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  neo!.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
  for (const [key, value] of Object.entries({ mergePolicy: 'review_bot', reviewBot: 'synthetic-reviewer', watchedRepos: [repo] })) assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: key === 'watchedRepos' ? { kind: 'global', key: '' } : { kind: 'repo', key: repo }, key, value })).ok, true);
  const store = new NeoAskTodoRepository(sql()), sessions = new NeoTodoSessionRepository(sql());
  store.openAsk({ id: 'ask', projectId: null, sessionId: root, originMessageId: null, title: 'Synthetic issue work', request: 'Fix two issues', createdAt: 1 });
  for (const [index, id] of workers.entries()) {
    const todo = store.addTodo(`todo-${index}`, 'ask', { title: `Issue ${7 + index}`, doneWhen: 'Issue completed', check: { pack: 'coding', kind: 'issue_closed', params: { issue: `Synthetic/MixedCase#${7 + index}` } }, instruction: 'Fix issue', named: null }, 1);
    store.updateTodo(todo, { state: 'doing', startedAt: 1 }, 1);
    sessions.create(todo.id, { verb: 'start', adapter: 'hyperneo', place: { machine: 'synthetic', folder: join(run, 'home') } });
    sessions.recordRef(todo.id, { adapter: 'hyperneo', id }, 1);
  }
  const coding = pack(), now = Date.now();
  await coding.observeSessions!([{ ref: { adapter: 'hyperneo', id: workers[1] }, status: 'running', lastActivityAt: now, remotes: ['git@github.com:synthetic/old-repo.git'], branches: [], linkedPrs: [], openedPrs: ['https://github.com/synthetic/mixedcase/pull/21'] }], now);
  await coding.todos!.openedPrs!(store.getTodo('todo-1')!, ['https://github.com/synthetic/mixedcase/pull/21']);
  fixture('PENDING'); await coding.sweep!(now);
  const pending = new CodingPrLedgerRepository(sql()).snapshot(null, now);
  assert.deepEqual(pending.map(row => [row.pr, row.state, row.ownerId]), [[ 'synthetic/mixedcase#20', 'approved_pending', workers[0] ], [ 'synthetic/mixedcase#21', 'approved_pending', workers[1] ], [ 'synthetic/mixedcase#22', 'approved_pending', null ]]);
  assert.equal(jobs().length, 0);
  sql().exec("CREATE TRIGGER reject_owner_delivery BEFORE INSERT ON job_queue WHEN NEW.queue='mailbox' BEGIN SELECT RAISE(ABORT,'synthetic rejection'); END");
  fixture('SUCCESS'); await coding.sweep!(now + 1000);
  assert.equal(jobs().length, 0);
  assert.equal(sql().prepare('SELECT count(*) AS n FROM pack_coding_pr_ledger WHERE number IN (20,21) AND told_at IS NULL AND terminal_event_json IS NOT NULL').get().n, 2);
  proof.rejected = { ledger: new CodingPrLedgerRepository(sql()).snapshot(null, now + 1000), jobs: jobs() };
  sql().exec('DROP TRIGGER reject_owner_delivery');
  await close(); await open();
  const reopened = pack(); await reopened.sweep!(now + 2000); await reopened.sweep!(now + 3000);
  const accepted = jobs();
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted.map(job => job.to.sessionId).sort(), [...workers].sort());
  assert.deepEqual(accepted.map(job => job.messageUuid).sort(), [20,21].map(number => `neo-pr-event:synthetic/mixedcase#${number}:head-${number}:approved_green`));
  assert.equal(sql().prepare('SELECT count(*) AS n FROM pack_coding_pr_ledger WHERE number IN (20,21) AND told_at IS NOT NULL AND terminal_event_json IS NULL').get().n, 2);
  assert.equal(new NeoAskTodoRepository(sql()).getTodo('todo-0')?.state, 'doing');
  assert.equal(sql().prepare('SELECT count(*) AS n FROM sdk_messages').get().n, 0);
  proof.pending = pending;
  proof.accepted = { mailbox: accepted, snapshot: await rpc('neo.snapshot', {}), ledger: new CodingPrLedgerRepository(sql()).snapshot(null, now + 3000) };
  proof.upstreamRequests = readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').length;
  proof.verified = true;
  console.log(JSON.stringify({ verified: true, ownerMailboxEvents: accepted.length, duplicateEvents: 0, providerTurns: 0 }));
} finally {
  await close(); globalThis.fetch = network;
  proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/issue-pr-owners.json'), JSON.stringify(proof, null, 2));
}
