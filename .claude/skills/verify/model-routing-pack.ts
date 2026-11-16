import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { createModelRoutingPack } from '../../../packages/daemon/src/lib/neo/packs/model-routing/pack.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'KIMI_API_KEY'])
  assert.equal(process.env[key], undefined, `${key} must be unset`);
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'fresh synthetic DB required');
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];

const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService?.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { authorization: `Bearer ${await readLocalCredential()}` },
  } as unknown as string[]);
  await new Promise<void>((done, fail) => {
    ws!.onopen = () => done();
    ws!.onerror = () => fail(new Error('connection failed'));
  });
  const call = (method: string, data: unknown) =>
    new Promise<any>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
      ws!.onmessage = (event) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        evidence.push({ method, data, reply });
        done(reply);
      };
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  const invoke = async (name: string, input: unknown) => (await call('operation.invoke', { name, input })).data;
  const preference = (key: string, value: unknown) => ({ pack: 'model-routing', scope: { kind: 'global', key: '' }, key, value });

  const enable = await call('settings.global.update', { updates: { neo: { packs: ['coding', 'delegation', 'model-routing'] } } });
  assert.equal(enable.error, undefined, JSON.stringify(enable.error));
  assert.deepEqual(app.settingsManager.getGlobalSettings().neo?.packs, ['coding', 'delegation', 'model-routing']);

  const opus = { provider: 'anthropic', model: 'claude-opus-4-1', harness: 'hyperneo' };
  const nowhere = { provider: 'not-installed', model: 'x' };
  assert.equal((await invoke('pack.preferences.set', preference('routes', [{ kind: 'coding.write', lines: [{ ...opus, stopAtPercent: 120 }] }]))).ok, false);
  assert.equal((await invoke('pack.preferences.set', preference('routes', [{ kind: 'coding.write', lines: [nowhere, opus] }]))).ok, true);
  assert.equal((await invoke('pack.preferences.set', preference('rules', [{ line: opus, never: { kinds: ['coding.review'] } }]))).ok, true);
  assert.deepEqual((await invoke('pack.preferences.get', preference('routes', undefined))).preference.value, [{ kind: 'coding.write', lines: [nowhere, opus] }]);

  const pack = createModelRoutingPack({ database: () => app.db.getDatabase(), provider: (id) => getProviderRegistry().get(id) });
  const anthropic = getProviderRegistry().get('anthropic');
  const observed = {
    anthropicRegistered: anthropic !== undefined,
    anthropicAvailable: anthropic ? await anthropic.isAvailable() : null,
    write: await pack.rankLines!('coding.write', [opus, nowhere], { repo: 'synthetic/app' }),
    review: await pack.rankLines!('coding.review', [opus], {}),
  };
  evidence.push({ observed });
  assert.equal(observed.anthropicRegistered, false, 'a fresh test daemon enables no provider');
  assert.deepEqual(observed.write, {
    ranked: [],
    skipped: [
      { line: nowhere, reason: 'not configured' },
      { line: opus, reason: 'not configured' },
    ],
    exhausted: true,
  });
  assert.deepEqual(observed.review.skipped, [{ line: opus, reason: 'not configured' }]);
  console.log(JSON.stringify(observed, null, 2));
} finally {
  ws?.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
console.log(`PASS: enabled through settings, routes and rules saved and validated, ranking read the saved routes and the real provider registry. Evidence: ${run}/evidence/observed.json`);
