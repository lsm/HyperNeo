import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'data')); mkdirSync(join(run, 'evidence'));
const path = join(run, 'data/daemon.db'), core = new DatabaseCore(path);
await core.initialize();
const old = core.getDb();
old.exec(`CREATE TABLE pack_coding_poll_facts (subject TEXT PRIMARY KEY, fact_revision INTEGER NOT NULL, observation_revision INTEGER NOT NULL, value_json TEXT, etag TEXT, next_url TEXT, observed_at INTEGER, attempted_at INTEGER NOT NULL, reason TEXT)`);
old.prepare('INSERT INTO pack_coding_poll_facts VALUES (?,?,?,?,?,?,?,?,?)').run('["synthetic-legacy"]', 3, 5, ' { "kept" : true } ', '"old"', null, 100, 110, 'failed');
const legacy = old.prepare('SELECT * FROM pack_coding_poll_facts').all(); core.close();
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No external HTTP in this proof'); }) as typeof fetch;
let requests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  requests++;
  const endpoint = new URL(request.url).pathname;
  if (endpoint === '/failure') return new Response('Synthetic unavailable', { status: 503 });
  if (endpoint === '/conditional') { assert.equal(request.headers.get('if-none-match'), '"page"'); return new Response(null, { status: 304, headers: { etag: '"new-page"', 'x-ratelimit-remaining': '90' } }); }
  return Response.json([{ id: 7 }], { headers: { etag: '"page"', 'x-ratelimit-remaining': '100', authorization: 'SYNTHETIC_OMIT_THIS_HEADER', 'set-cookie': 'SYNTHETIC_OMIT_COOKIE' } });
} });
assert.notEqual(server.port, 8399);
const subject = { credentialId: 'opaque-synthetic-only', url: 'https://api.github.com/repos/synthetic/ledger/pulls?page=1', accept: 'application/vnd.github+json', apiVersion: '2022-11-28' };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
const evidence: Record<string, unknown> = { publicPollingExercised: false, apiSavingsClaimed: false };
const request = (endpoint = '/page') => () => network(`http://127.0.0.1:${server.port}${endpoint}`, endpoint === '/conditional' ? { headers: { 'If-None-Match': '"page"' } } : undefined);
try {
  for (const phase of ['initial', 'restarted']) {
    app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: path }), verbose: false });
    await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
    const db = app.db.getDatabase(); createCodingPackTables(db);
    const rows = db.prepare('SELECT * FROM pack_coding_poll_facts WHERE subject=?').all('["synthetic-legacy"]');
    assert.deepEqual(rows, legacy.map(row => ({ ...row, http_json: null })));
    const facts = new CodingPrLedgerRepository(db).pollFacts;
    if (phase === 'initial') {
      evidence.runtime = { commit: BUILD_METADATA.commit, pid: process.pid, port: app.server.port };
      for (let n = 0; n < 3; n++) assert.deepEqual(await (await facts.collect(subject, 'cycle-one', null, request(), () => 100)).json(), [{ id: 7 }]);
      assert.equal(requests, 1);
      evidence.sameCycle = { sequentialCallers: 3, upstreamRequests: requests };
      const conditional = await facts.collect(subject, 'cycle-two', '"page"', request('/conditional'), () => 110);
      assert.equal(conditional.status, 304);
      const cached = await facts.collect(subject, 'cycle-two', '"new-page"', request(), () => 111);
      assert.deepEqual(await cached.json(), [{ id: 7 }]); assert.equal(requests, 2);
      assert.equal(cached.headers.get('x-ratelimit-remaining'), '90'); assert.equal(cached.headers.get('authorization'), null);
      assert.equal(facts.read(subject, 111, 100).factRevision, 1);
      const failed = await facts.collect(subject, 'cycle-three', null, request('/failure'), () => 120);
      assert.equal(failed.status, 503); await failed.text();
      assert.equal(facts.read(subject, 120, 100).page.status, 'unknown');
      const overlapSubject = { ...subject, url: `${subject.url}&overlap=1` }, beforeOverlap = requests;
      const peer = new CodingPrLedgerRepository(db).pollFacts;
      const overlap = await Promise.all([facts.collect(overlapSubject, 'overlap-a', null, request(), () => 125), peer.collect(overlapSubject, 'overlap-b', null, request(), () => 125)]);
      assert.deepEqual(await Promise.all(overlap.map(response => response.json())), [[{ id: 7 }], [{ id: 7 }]]);
      assert.equal(requests - beforeOverlap, 1); assert.equal(facts.read(overlapSubject, 125, Infinity).observationRevision, 1);
      evidence.overlappingCycles = { consumersAccepted: 2, upstreamRequests: 1, observations: 1 };
      const beforeFresh = requests;
      await Promise.all([facts.collect(overlapSubject, 'overlap-a', null, request(), () => 126), peer.collect(overlapSubject, 'overlap-c', null, request(), () => 126)]);
      assert.equal(requests - beforeFresh, 1);
      evidence.freshCycleBesideCoveredCycle = { refreshRequests: 1 };

      evidence.validation = { valid304: true, rateHeadersPreserved: true, metadataOnlyFactRevision: 1, failureUnknown: true };
    } else {
      assert.equal(facts.read(subject, 120, 100).page.status, 'unknown');
      assert.deepEqual(await (await facts.collect(subject, 'cycle-four', null, request(), () => 130)).json(), [{ id: 7 }]);
      assert.equal(facts.read(subject, 130, 100).factRevision, 1);
      evidence.restarted = { failedPageRemainedUnknown: true, recoveredWithoutFalseFactChange: true };
    }
    assert(!JSON.stringify(db.prepare('SELECT * FROM pack_coding_poll_facts').all()).includes('SYNTHETIC_OMIT'));
    await app.cleanup(); app = undefined;
  }
  evidence.migration = { oldRowsAndRawValueBytesUnchanged: true, newMetadataNullableAndNotBackfilled: true };
  evidence.unsafeHeadersOmitted = true; evidence.verified = true;
  console.log('PASS: additive old-schema migration preserves rows/value bytes; local HTTP pages reuse same-cycle coverage, validate 304, preserve rate headers, reject failures and survive daemon restart without false fact changes. This collector-only proof leaves public polling to its separate journey.');
} finally {
  await app?.cleanup(); await server.stop(true); globalThis.fetch = network;
  evidence.ownedResourcesClosed = true;
  writeFileSync(join(run, 'evidence/poll-http.json'), JSON.stringify(evidence, null, 2));
}
