process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { codingSessionStrategy, planCodingSessionDispatch } from '../../../packages/daemon/src/lib/neo/packs/coding/session-strategy.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const repo = 'synthetic/sessions';
const address = { pack: 'coding', scope: { kind: 'repo', key: repo }, key: 'sessionStrategy' };
const ref = (id: string) => ({ adapter: 'hyperneo', id });
const busy = [{ ref: ref('dev'), name: 'dev', state: 'busy' as const }];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in synthetic session strategy proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    let ws: WebSocket | undefined;
    try {
      await app.spaceRuntimeService.ready(); await app.jobProcessor.stop(); assert(![8399, 8499].includes(app.server.port));
      ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
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
      const plan = (target: string) => {
        const strategy = codingSessionStrategy(app.db.getDatabase(), target);
        const result = planCodingSessionDispatch({ strategy, workType: 'dev', pool: busy });
        evidence.push({ phase, surface: 'session strategy planner', repo: target, strategy, result });
        return result;
      };
      if (phase === 'initial') {
        assert.deepEqual(await rpc('pack.preferences.get', address), { preference: null });
        assert.deepEqual(plan(repo), { verb: 'start', name: 'dev-2' });
        assert.deepEqual(await rpc('pack.preferences.get', address), { preference: null });
        assert.equal((await rpc('pack.preferences.set', { ...address, value: 'per_feature' }) as { ok: boolean }).ok, false);
        assert.deepEqual(await rpc('pack.preferences.set', { ...address, value: 'per_pr' }), { ok: true });
        assert.deepEqual(plan(repo), { verb: 'start' });
      } else {
        const saved = await rpc('pack.preferences.get', address) as { preference: { value: unknown; setBy: string } };
        assert.equal(saved.preference.value, 'per_pr');
        assert.equal(saved.preference.setBy, 'human');
        assert.deepEqual(plan(repo), { verb: 'start' });
        assert.deepEqual(plan('synthetic/unanswered'), { verb: 'start', name: 'dev-2' });
      }
    } finally { ws?.close(); await app.cleanup(); }
  }
  console.log(`PASS: sessionStrategy is long_lived until answered without saving, a human per_pr choice persists across restart, and the planner follows it. Evidence: ${run}/evidence/session-strategy.json`);
} finally {
  writeFileSync(join(run, 'evidence/session-strategy.json'), JSON.stringify(evidence, null, 2));
  globalThis.fetch = network;
}
