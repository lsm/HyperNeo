import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[k], undefined);
for (const dir of ['bin', 'data', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in health-state Build proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
const proof: Record<string, unknown> = { verified: false, producerWired: false, neoConcernDeliveryWired: false, simulatedCycleOutcomes: true };
const sql = () => app!.db.getDatabase();
const historical = (db: Database) => db.prepare('SELECT * FROM pack_coding_poll_facts').all();
const path = join(run, 'data/daemon.db');
const seed = new Database(path);
createTables(seed); runMigrations(seed, () => {}); createCodingPackTables(seed);
seed.exec('DROP TABLE IF EXISTS pack_coding_repo_health');
seed.exec("DELETE FROM migration_markers WHERE key='migration_454'");
seed.exec("INSERT INTO pack_coding_poll_facts (subject,fact_revision,observation_revision,value_json,observed_at,attempted_at) VALUES ('[\"synthetic-protected-history\"]',7,9,'[]',100,200)");
const oldRows = historical(seed); seed.close();
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: path }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399); app.db.updateGlobalSettings({ neo: { packs: [] } });
}
try {
  await open(); proof.runtime = { commit: BUILD_METADATA.commit, pid: process.pid, port: app!.server.port };
  proof.migration = sql().prepare("SELECT * FROM migration_markers WHERE key='migration_454'").get();
  assert(proof.migration, 'old schema must gain the new health migration');
  assert.deepEqual(sql().prepare('SELECT * FROM pack_coding_repo_health').all(), []);
  assert.deepEqual(historical(sql()), oldRows);
  let ledger = new CodingPrLedgerRepository(sql());
  assert.equal(ledger.health.read('synthetic/missing'), null);
  for (const [at, outcome] of [[100, 'not_reached'], [200, 'partial'], [300, 'failed']] as const) await ledger.write('recordHealth', 'synthetic/unreached', { at, outcome });
  const incident = ledger.health.read('synthetic/unreached')!;
  assert.equal(incident.misses, 3); assert.equal(incident.completeAt, null); assert.equal(incident.incident!.resolvedAt, null);
  await ledger.write('recordHealth', 'synthetic/unreached', { at: 400, outcome: 'cooldown', retryAt: 1000 });
  const before = ledger.health.read('synthetic/unreached')!;
  assert.equal(before.misses, 3); assert.equal(before.nextRetryAt, 1000); assert.deepEqual(before.incident, incident.incident);
  await ledger.write('recordHealth', 'synthetic/empty', { at: 100, outcome: 'complete' });
  assert.equal(ledger.health.read('synthetic/empty')!.completeAt, 100);
  proof.beforeRestart = { unreached: before, empty: ledger.health.read('synthetic/empty') };
  await app!.cleanup(); app = undefined; await open(); ledger = new CodingPrLedgerRepository(sql());
  assert.deepEqual(ledger.health.read('synthetic/unreached'), before);
  for (const at of [400, 399]) await ledger.write('recordHealth', 'synthetic/unreached', { at, outcome: 'complete' });
  assert.deepEqual(ledger.health.read('synthetic/unreached'), before);
  await ledger.write('recordHealth', 'synthetic/unreached', { at: 500, outcome: 'complete' });
  const recovered = ledger.health.read('synthetic/unreached')!;
  assert.equal(recovered.misses, 0); assert.equal(recovered.incident!.key, before.incident!.key); assert.equal(recovered.incident!.resolvedAt, 500);
  for (const at of [600, 700, 800]) await ledger.write('recordHealth', 'synthetic/unreached', { at, outcome: 'not_reached' });
  const next = ledger.health.read('synthetic/unreached')!; assert.notEqual(next.incident!.key, recovered.incident!.key);
  assert.deepEqual(historical(sql()), oldRows);
  proof.afterRestart = { recovered, next, protectedHistory: historical(sql()) }; proof.verified = true;
  console.log(JSON.stringify({ verified: true, producerWired: false, migrationApplied: true, historyPreserved: true }));
} finally {
  await app?.cleanup(); globalThis.fetch = network; proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/health-state.json'), JSON.stringify(proof, null, 2));
}
