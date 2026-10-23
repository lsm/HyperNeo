import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'));
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No external HTTP in this proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let release!: () => void, arrived!: () => void;
const gate = new Promise<void>(done => { release = done; });
const started = new Promise<void>(done => { arrived = done; });
let requests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  requests++; arrived(); await gate;
  const path = new URL(request.url).pathname;
  if (path === '/failure') return new Response('Synthetic unavailable', { status: 503 });
  if (path === '/conditional') return new Response(null, { status: 304, headers: { etag: '"local"' } });
  return Response.json([{ id: 7 }], { headers: { etag: '"local"' } });
} });
assert.notEqual(server.port, 8399);
const subject = { credentialId: 'opaque-synthetic-only', url: 'https://api.github.com/repos/synthetic/ledger/pulls/7/reviews?page=1', accept: 'application/vnd.github+json', apiVersion: '2022-11-28', headOid: 'a'.repeat(40) };
const evidence: Record<string, unknown> = { productionWired: false, apiSavingsClaimed: false };
try {
  let saved: unknown;
  for (const phase of ['initial', 'restarted']) {
    app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
    const db = app.db.getDatabase(); createCodingPackTables(db);
    const facts = new CodingPrLedgerRepository(db).pollFacts;
    const snapshot = () => db.prepare('SELECT * FROM pack_coding_poll_facts').all();
    if (phase === 'initial') {
      facts.record(subject, { value: [{ id: 1 }], etag: '"stored"', next: null }, 100, 0);
      saved = snapshot();
      const request = () => network(`http://127.0.0.1:${server.port}/page`);
      const first = facts.acquire(subject, null, request);
      await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error('Synthetic HTTP did not start')), 5000); started.then(() => { clearTimeout(timer); done(); }); });
      const second = new CodingPrLedgerRepository(db).pollFacts.acquire(subject, null, request);
      const third = facts.acquire(subject, null, request);
      release();
      const responses = await Promise.all([first, second, third]);
      assert.equal(requests, 1);
      responses[0].headers.set('x-local', 'only-first');
      assert.equal(responses[1].headers.get('x-local'), null);
      for (const response of responses) assert.deepEqual(await response.json(), [{ id: 7 }]);
      evidence.concurrent = { callers: 3, upstreamRequests: requests, separateBodiesAndHeaders: true };
      assert.deepEqual(await (await facts.acquire(subject, null, request)).json(), [{ id: 7 }]);
      assert.equal(requests, 2);
      for (const [path, status] of [['failure', 503], ['conditional', 304]] as const) {
        const before = requests;
        const request = () => network(`http://127.0.0.1:${server.port}/${path}`);
        const responses = await Promise.all([facts.acquire(subject, '"local"', request), facts.acquire(subject, '"local"', request)]);
        for (const response of responses) { assert.equal(response.status, status); await response.text(); }
        assert.equal(requests - before, 1);
      }
      assert.deepEqual(snapshot(), saved);
      evidence.statusesPreserved = [503, 304]; evidence.sequentialRetryRequests = 2;
    } else {
      assert.deepEqual(snapshot(), saved);
      evidence.storedDataUnchangedAfterRestart = true;
    }
    await app.cleanup(); app = undefined;
  }
  evidence.verified = true;
  console.log('PASS: three real HTTP callers share one acquisition, cloned bodies/statuses remain usable, sequential requests retry, stored observations survive daemon restart unchanged. Public polling wiring remains pending.');
} finally {
  release(); await app?.cleanup(); await server.stop(true); globalThis.fetch = network;
  evidence.ownedResourcesClosed = true;
  writeFileSync(join(run, 'evidence/coalescing.json'), JSON.stringify(evidence, null, 2));
}
