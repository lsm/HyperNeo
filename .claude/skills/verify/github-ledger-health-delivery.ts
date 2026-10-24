import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

const run = resolve(process.argv[2]), repo = 'synthetic/health', session = 'synthetic-health-recipient';
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in health delivery proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, neo: ReturnType<typeof createNeoService> | undefined;
let complete = false;
const proof: Record<string, unknown> = { verified: false, providerTurns: 0, recipientConsumptionVerified: false };
const sql = () => app!.db.getDatabase();
const notices = () => JSON.parse(sql().prepare('SELECT health_json FROM pack_coding_repo_health WHERE repo=?').get(repo).health_json).notices ?? [];
const jobs = () => sql().prepare("SELECT id,payload FROM job_queue WHERE queue='mailbox' ORDER BY id").all();
const history = () => sql().prepare('SELECT * FROM pack_coding_poll_facts').all();
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399); app.db.updateGlobalSettings({ neo: { packs: [] } });
  neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
}
async function close() { await neo?.dispose(); neo = undefined; await app?.cleanup(); app = undefined; }
async function cycle(at: number) {
  const db = sql();
  const pack = createCodingPack({
    database: () => db, readPrs: async () => [], readClaudeOwners: async () => [],
    todoPrs: new CodingTodoPrRepository(db), prLedger: new CodingPrLedgerRepository(db),
    prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db), projectRepos: () => [repo],
    prSweepDeps: { tell: async () => true, wake: (key, text) => neo!.wakeNeo(key, text) },
    readLedgerRepo: async () => complete ? { data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false }, nodes: [] }, done: { nodes: [] } } } } : null,
  });
  await pack.sweep!(at);
}
try {
  await open(); proof.runtime = { commit: BUILD_METADATA.commit, pid: process.pid, port: app!.server.port };
  await app!.db.createSession({ id: session, title: 'Synthetic recipient', workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  neo!.repo.reserveBinding({ sessionId: session, projectId: null, kind: 'neo' });
  sql().exec("INSERT INTO pack_coding_poll_facts (subject,fact_revision,observation_revision,value_json,attempted_at) VALUES ('[\"protected-history\"]',3,5,'[]',1)");
  const protectedRows = history();
  sql().exec("CREATE TRIGGER reject_health_delivery BEFORE INSERT ON job_queue WHEN NEW.queue='mailbox' BEGIN SELECT RAISE(ABORT,'synthetic mailbox rejection'); END");
  for (const at of [1, 2, 3]) await cycle(at);
  assert.equal(notices().length, 1, 'third miss must persist a pending incident notice');
  assert.equal(notices()[0].acceptedAt, null); assert.equal(jobs().length, 0);
  complete = true; await cycle(4);
  assert.equal(notices().length, 2); assert(notices().every((notice: { acceptedAt: number | null }) => notice.acceptedAt === null));
  const pending = notices(); proof.rejected = { notices: pending, jobs: jobs() };
  sql().exec('DROP TRIGGER reject_health_delivery'); await close(); await open();
  assert.deepEqual(notices(), pending); await cycle(5);
  const accepted = notices(); assert(accepted.every((notice: { acceptedAt: number | null }) => notice.acceptedAt === 5));
  assert.equal(jobs().length, 2);
  const payloads = jobs().map((job: { payload: string }) => JSON.parse(job.payload));
  assert.deepEqual(payloads.map((payload: { messageUuid: string }) => payload.messageUuid), accepted.map((notice: { key: string }) => notice.key));
  proof.accepted = { notices: accepted, jobs: jobs() };
  await cycle(6); assert.deepEqual(notices(), accepted); assert.equal(jobs().length, 2);
  sql().prepare("UPDATE job_queue SET run_at=? WHERE queue='mailbox'").run(Date.now() + 86400000);
  await close(); await open(); await cycle(7);
  assert.deepEqual(notices(), accepted); assert.equal(jobs().length, 2); assert.deepEqual(history(), protectedRows);
  assert.equal(sql().prepare('SELECT count(*) AS count FROM sdk_messages WHERE session_id=?').get(session).count, 0);
  proof.afterRestart = { notices: notices(), jobs: jobs(), protectedHistory: history() }; proof.verified = true;
  console.log(JSON.stringify({ verified: true, realWakeAndMailbox: true, rejectedThenAccepted: true, restartVerified: true, providerTurns: 0 }));
} finally {
  await close(); globalThis.fetch = network; proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/health-delivery.json'), JSON.stringify(proof, null, 2));
}
