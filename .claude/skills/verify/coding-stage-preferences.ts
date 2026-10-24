import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const repo = 'synthetic/preferences';
const place = { machine: 'fixture', name: 'Fixture' };
const standard = { adapter: 'hyperneo', place, model: 'claude-opus-5-5' };
const preferred = { adapter: 'codex-desktop', place, model: 'gpt-6', effort: 'high' };
const address = (key: string) => ({ pack: 'coding', scope: { kind: 'repo', key: repo }, key });
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in synthetic preference proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    let ws: WebSocket | undefined;
    try {
      await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
      ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
      await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
      const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
        const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
        ws!.onmessage = event => {
          const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
          clearTimeout(timer); evidence.push({ phase, name, input, reply });
          if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
        };
        ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
      });
      const plan = () => rpc('neo.coding.write.plan', { repo, candidates: [standard, preferred] });
      if (phase === 'initial') {
        assert.deepEqual(await rpc('pack.preferences.list', {}), { preferences: [] });
        assert.deepEqual(await plan(), { ok: true, target: standard, fallback: [] });
        assert.deepEqual(await rpc('pack.preferences.get', address('write.model')), { preference: null });
        for (const stage of ['write', 'review', 'verify']) {
          for (const [field, value] of Object.entries({ harness: preferred.adapter, model: preferred.model, effort: preferred.effort }))
            assert.deepEqual(await rpc('pack.preferences.set', { ...address(`${stage}.${field}`), value }), { ok: true });
        }
        assert.deepEqual(await plan(), { ok: true, target: preferred, fallback: [] });
        assert.equal((await rpc('pack.preferences.list', { pack: 'coding' }) as { preferences: unknown[] }).preferences.length, 9);
        for (const value of [true, 'x'.repeat(201)])
          assert.equal((await rpc('pack.preferences.set', { ...address('write.model'), value }) as { ok: boolean }).ok, false);
        assert.deepEqual(await rpc('pack.preferences.set', { ...address('write.model'), value: 'unavailable-model' }), { ok: true });
        assert.deepEqual(await plan(), { ok: true, target: preferred, fallback: ['Preferred model "unavailable-model" is unavailable for this selection; using "gpt-6".'] });
        assert.deepEqual(await rpc('pack.preferences.set', { ...address('write.model'), value: preferred.model }), { ok: true });
      } else {
        assert.deepEqual(await plan(), { ok: true, target: preferred, fallback: [] });
        const settings = await rpc('pack.preferences.list', { pack: 'coding' }) as { preferences: { key: string; setBy: string; value: unknown }[] };
        assert.equal(settings.preferences.length, 9);
        assert(settings.preferences.every(item => item.setBy === 'human'));
        assert.deepEqual(settings.preferences.filter(item => item.key.endsWith('.model')).map(item => item.value), [preferred.model, preferred.model, preferred.model]);
        const fallback = await rpc('neo.coding.write.plan', { repo, candidates: [standard] }) as { target: unknown; fallback: string[] };
        assert.deepEqual(fallback.target, standard);
        assert.equal(fallback.fallback.length, 3);
        const untouched = await rpc('neo.coding.write.plan', { repo: 'synthetic/unanswered', candidates: [standard, preferred] });
        assert.deepEqual(untouched, { ok: true, target: standard, fallback: [] });
        evidence.push({ phase, settings, fallback });
      }
    } finally { ws?.close(); await app.cleanup(); }
  }
  console.log(`PASS: real RPC plans preferred/default Write targets, explains unavailable settings, rejects invalid values and preserves all nine human preferences across restart. Evidence: ${run}/evidence/stage-preferences.json`);
} finally {
  writeFileSync(join(run, 'evidence/stage-preferences.json'), JSON.stringify(evidence, null, 2));
  globalThis.fetch = network;
}
