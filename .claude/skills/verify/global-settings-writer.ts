import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { ProviderCredentialManager } from '../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws` });
hub.registerTransport(transport);
const main = app.db.getDatabase();
const prepare = main.prepare.bind(main);
let targetSqlOnMain = 0;
main.prepare = ((sql: string) => {
  if (/INSERT OR REPLACE INTO global_settings/i.test(sql)) {
    targetSqlOnMain++;
    throw new Error('global_settings write reached daemon main connection');
  }
  return prepare(sql);
}) as typeof main.prepare;
let maxLoopLagMs = 0;
let lastTick = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  maxLoopLagMs = Math.max(maxLoopLagMs, now - lastTick - 10);
  lastTick = now;
}, 10);
const changes: unknown[] = [];
app.reactiveDb.on('change:global_settings', (event) => changes.push(event));
try {
  await transport.connect();
  const start = performance.now();
  const reply = await hub.request<{ success: boolean; settings: { showArchived: boolean } }>(
    'settings.global.update', { updates: { showArchived: true } }
  );
  evidence.rpcMs = performance.now() - start;
  evidence.reply = reply;
  assert.equal(reply.success, true);
  assert.equal(reply.settings.showArchived, true);
  const row = prepare('SELECT settings FROM global_settings WHERE id = 1').get() as { settings: string };
  assert.equal(JSON.parse(row.settings).showArchived, true);
  const second = await hub.request<{ settings: { showArchived: boolean; outputStyle: string } }>(
    'settings.global.update', { updates: { outputStyle: 'synthetic-style' } }
  );
  assert.equal(second.settings.showArchived, true);
  assert.equal(second.settings.outputStyle, 'synthetic-style');
  evidence.persisted = JSON.parse((prepare('SELECT settings FROM global_settings WHERE id = 1').get() as { settings: string }).settings);
  assert.equal(changes.length, 2, 'each committed RPC write must announce one change');
  const storeApiKey = ProviderCredentialManager.prototype.storeApiKey;
  ProviderCredentialManager.prototype.storeApiKey = async () => {
    throw new Error('synthetic credential-store failure');
  };
  try {
    await assert.rejects(hub.request('settings.global.update', { updates: {
      showArchived: false,
      voice: { endpoint: 'https://synthetic.invalid/transcribe', apiKey: 'synthetic-only' },
    } }), /synthetic credential-store failure/);
    assert.equal(app.settingsManager.getGlobalSettings().showArchived, true);
    evidence.rollback = 'prior settings restored before failure reply';
  } finally {
    ProviderCredentialManager.prototype.storeApiKey = storeApiKey;
  }
  main.exec('BEGIN IMMEDIATE');
  let settled = false;
  const heldStart = performance.now();
  const held = hub.request('settings.global.update', { updates: { autoScroll: false, neo: { standingRules: 'caller-must-not-own' } } });
  void held.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(settled, false, 'worker must wait for writer lock');
    const healthStart = performance.now();
    const health = await hub.request('system.health', {});
    evidence.healthMs = performance.now() - healthStart;
    assert(health);
  } finally {
    try {
      prepare("UPDATE global_settings SET settings = json_set(settings, '$.neo.standingRules', ?) WHERE id = 1").run('writer-current-rule');
    } finally {
      main.exec('COMMIT');
    }
  }
  await held;
  assert.equal(app.settingsManager.getGlobalSettings().neo?.standingRules, 'writer-current-rule');
  evidence.preservedWriterCurrentRule = true;
  evidence.heldWriteMs = performance.now() - heldStart;
  evidence.heldWriteLatencyTargetPassed = Number(evidence.heldWriteMs) < 250;
  evidence.maxLoopLagMs = maxLoopLagMs;
  assert(maxLoopLagMs < 1000);
  assert(Number(evidence.healthMs) < 250);
  assert.equal(app.settingsManager.getGlobalSettings().autoScroll, false);
  evidence.result = 'pass';
} catch (error) {
  evidence.result = 'fail';
  evidence.error = String(error);
  throw error;
} finally {
  clearInterval(timer);
  evidence.targetSqlOnMain = targetSqlOnMain;
  main.prepare = prepare;
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/global-settings-writer.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, reply: undefined, persisted: undefined }, null, 2));
}
assert.equal(targetSqlOnMain, 0);
