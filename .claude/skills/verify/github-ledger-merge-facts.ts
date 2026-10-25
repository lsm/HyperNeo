import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'bin')); mkdirSync(join(run, 'evidence'));
copyFileSync(fileURLToPath(new URL('./github-ledger-gh.ts', import.meta.url)), join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
writeFileSync(join(run, 'fixture.json'), JSON.stringify({ scenario: 'merged', phase: 'initial', now: Date.now() }));
const repo = 'synthetic/ledger', number = 7, source = 'github-pr-detail';
const value = { state: 'MERGED', mergeCommit: 'c'.repeat(40) } as const;
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No real HTTP in this proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, unknown> = { deployConsumerExercised: false, quotaReduction: 0 };
const count = () => existsSync(join(run, 'evidence/requests.jsonl')) ? readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
try {
  for (const phase of ['initial', 'reopened']) {
    app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
    const db = app.db.getDatabase(); createCodingPackTables(db);
    const ledger = new CodingPrLedgerRepository(db), facts = ledger.mergeFacts;
    if (phase === 'initial') {
      const missing = facts.read(repo, number, 100, 10); assert.equal(missing.merge.status, 'unknown');
      assert((await facts.observeCurrent(repo, number, { value, source }, 100, 0)).accepted);
      const known = facts.read(repo, number, 100, 10); assert.equal(known.merge.status, 'known');
      assert((await facts.observeCurrent(repo, number, { reason: 'failed' }, 110, known.observationRevision)).accepted);
      const failed = facts.read(repo, number, 110, 10); assert.equal(failed.merge.status, 'unknown');
      assert((await facts.observeCurrent(repo, number, { value, source }, 120, failed.observationRevision)).accepted);
      const recovered = facts.read(repo, number, 120, 10); assert.equal(recovered.factRevision, known.factRevision);
      const stale = facts.read(repo, number, 131, 10); assert.equal(stale.merge.status, 'unknown');
      evidence.local = { missing, known, failed, recovered, stale };
      evidence.expected = recovered;
    } else {
      const recovered = facts.read(repo, number, 120, 10); assert.deepEqual(recovered, evidence.expected);
      assert.equal((await facts.observeCurrent(repo, number, { value: { state: 'OPEN', mergeCommit: null }, source }, 140, 1)).accepted, false);
      assert.deepEqual(facts.read(repo, number, 120, 10), recovered);
      const before = count(); for (let i = 0; i < 10; i++) facts.read(repo, number, 120, 10);
      assert.equal(count(), before); evidence.reopened = recovered; evidence.localReadRequests = count() - before;
      const row = db.prepare('SELECT value_json FROM pack_coding_merge_facts WHERE repo = ? AND number = ?').get(repo, number) as { value_json: string };
      assert.deepEqual(JSON.parse(row.value_json), value);
    }
    ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
    await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
    const detail = await new Promise<unknown>((done, fail) => {
      const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10_000);
      ws!.onmessage = event => {
        const msg = JSON.parse(String(event.data)); if (msg.id !== id && msg.requestId !== id) return;
        clearTimeout(timer); if (msg.error) fail(new Error(JSON.stringify(msg.error))); else done(msg.data);
      };
      ws!.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', data: { name: 'neo.github.read', input: { url: `https://github.com/${repo}/pull/${number}` } }, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    assert.deepEqual(detail, { ok: true, kind: 'pr', url: `https://github.com/${repo}/pull/${number}`, state: 'MERGED', checks: 'passing', review: 'approved', blockers: [], title: 'Synthetic shared fact' });
    evidence[phase] = { publicDetail: detail, upstreamRequests: count() };
    ws.close(); ws = undefined; await app.cleanup(); app = undefined;
  }
  evidence.verified = true;
  console.log('PASS: isolated daemon local merge facts survive reopen, refuse stale writers and expose unknown coverage; existing public detail stays compatible. Deploy reader wiring has a separate journey.');
} finally {
  writeFileSync(join(run, 'evidence/merge-facts.json'), JSON.stringify(evidence, null, 2));
  ws?.close(); await app?.cleanup(); globalThis.fetch = network;
}
