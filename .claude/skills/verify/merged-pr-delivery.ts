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

const run = resolve(process.argv[2]), repo = 'synthetic/terminal', worker = 'synthetic-terminal-owner';
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const part of ['bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
const fetchBefore = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in terminal proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, neo: ReturnType<typeof createNeoService> | undefined;
let readFails = false;
let ledger: CodingPrLedgerRepository, pack: ReturnType<typeof createCodingPack>;
const evidence: Record<string, unknown> = { verified: false, providerTurns: 0, recipientConsumptionVerified: false };
const sql = () => app!.db.getDatabase();
const pending = () => sql().prepare('SELECT number, state, terminal_event_json, told_at FROM pack_coding_pr_ledger ORDER BY number').all() as { number: number; state: string; terminal_event_json: string | null; told_at: number | null }[];
const jobs = () => sql().prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY json_extract(payload, '$.messageUuid')").all().map((row: { payload: string }) => JSON.parse(row.payload));
let closedAt = 0;
const nodes = () => [8548, 8549].map(number => ({ number, title: `Synthetic ${number}`, headRefName: `synthetic-${number}`, headRefOid: `head-${number}`, isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, state: number === 8548 ? 'MERGED' : 'CLOSED', closedAt: new Date(closedAt).toISOString() }));
const raw = () => ({ data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false }, nodes: [] }, done: { nodes: nodes() } } } });
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  app.db.updateGlobalSettings({ neo: { packs: [] } });
  neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  ledger = new CodingPrLedgerRepository(sql());
  pack = createCodingPack({ database: sql, readPrs: async () => [], readClaudeOwners: async () => [],
    todoPrs: new CodingTodoPrRepository(sql()), prLedger: ledger, prEvents: new CodingPrEventRepository(sql()),
    prSweep: new CodingPrSweepRepository(sql()), projectRepos: () => [repo], readLedgerRepo: async () => { if (readFails) throw new Error('synthetic GitHub reader unavailable'); return raw(); },
    prSweepDeps: { tell: (ref, key, text) => neo!.sendToRef(ref, key, text), wake: (key, text) => neo!.wakeNeo(key, text) } });
}
async function close() { await neo?.dispose(); neo = undefined; await app?.cleanup(); app = undefined; }
try {
  await open();
  closedAt = Date.now() + 1;
  for (const id of ['synthetic-terminal-neo', worker]) await app!.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  neo!.repo.reserveBinding({ sessionId: 'synthetic-terminal-neo', projectId: null, kind: 'neo' });
  const activation = sql().prepare('SELECT activated_at FROM pack_coding_pr_event_state').get() as { activated_at: number };
  const observation = [
    { repo, number: 1, title: 'Historical', branch: 'historical', head: 'old', state: 'merged' as const, closedAt: activation.activated_at - 1 },
    ...nodes().map(node => ({ repo, number: node.number, title: node.title, branch: node.headRefName, head: node.headRefOid, state: (node.state === 'MERGED' ? 'merged' : 'closed') as 'merged' | 'closed', closedAt })),
  ];
  await ledger!.write('replace', repo, observation, closedAt + 1);
  assert.equal(pending().filter(row => row.terminal_event_json).length, 2);
  assert.equal(jobs().length, 0); evidence.afterLostReturn = pending();
  await close(); await open();
  assert.equal((sql().prepare('SELECT activated_at FROM pack_coding_pr_event_state').get() as { activated_at: number }).activated_at, activation.activated_at);
  await ledger!.write('observeSessions', [{ ref: { adapter: 'hyperneo', id: worker }, status: 'done', lastActivityAt: closedAt, remotes: [`git@github.com:${repo}.git`], branches: ['synthetic-8548', 'synthetic-8549'], openedPrs: [] }], closedAt + 2);
  sql().exec("CREATE TRIGGER reject_terminal_mail BEFORE INSERT ON job_queue WHEN NEW.queue='mailbox' BEGIN SELECT RAISE(ABORT,'synthetic recipient rejection'); END");
  await pack!.sweep!(closedAt + 3);
  assert.equal(jobs().length, 0); assert.equal(pending().filter(row => row.terminal_event_json).length, 2);
  evidence.rejected = pending();
  await close(); await open();
  sql().exec('DROP TRIGGER reject_terminal_mail');
  readFails = true;
  const failedReads = await Promise.allSettled([pack!.sweep!(closedAt + 4), pack!.sweep!(closedAt + 5)]);
  assert(failedReads.every(result => result.status === 'rejected' && String(result.reason).includes('synthetic GitHub reader unavailable')));
  readFails = false;
  assert.equal(jobs().length, 2); assert(pending().every(row => row.terminal_event_json === null));
  assert(pending().filter(row => row.number !== 1).every(row => row.told_at !== null));
  assert(jobs().every(job => job.to.sessionId === worker));
  const accepted = jobs(); evidence.accepted = { ledger: pending(), mailbox: accepted };
  sql().prepare("UPDATE job_queue SET run_at=? WHERE queue='mailbox'").run(Date.now() + 86400000);
  await close(); await open();
  await pack!.sweep!(closedAt + 6);
  assert.deepEqual(jobs(), accepted); assert.equal(sql().prepare('SELECT count(*) AS count FROM sdk_messages').get().count, 0);
  evidence.afterRestart = { ledger: pending(), mailbox: jobs() }; evidence.verified = true;
  console.log(JSON.stringify({ verified: true, ownerMailboxEvents: jobs().length, repeatDuplicates: 0, providerTurns: 0 }));
} finally {
  await close(); globalThis.fetch = fetchBefore; evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/merged-pr-delivery.json'), JSON.stringify(evidence, null, 2));
}
