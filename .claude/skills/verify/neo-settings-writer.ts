import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SettingsRepository } from '../../../packages/daemon/src/storage/repositories/settings-repository.ts';
import { MessageHub, WebSocketClientTransport, type GlobalSettings } from '../../../packages/shared/src/mod.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws` });
hub.registerTransport(transport);
const main = app.db.getDatabase();
const prepare = main.prepare.bind(main);
const peerDb = new Database(app.db.getDbPath());
const peer = new SettingsRepository(peerDb);
const gateway = app.db.gateway;
const gatewayRun = gateway.run.bind(gateway);
const report: Record<string, unknown> = { mode, port: app.server.port, races: [] };
let competitor: (() => void) | undefined;
let mainWrites = 0, recording = false;
let lock: ReturnType<typeof spawn> | undefined;
const settingsEvents: GlobalSettings[] = [];
const unsubscribe = hub.onEvent('state.settings', (data: { settings: GlobalSettings }) => settingsEvents.push(data.settings));
const compete = () => { const write = competitor; competitor = undefined; write?.(); };
main.prepare = ((sql: string) => {
  if (recording && /INSERT(?: OR REPLACE)? INTO global_settings/i.test(sql)) { mainWrites++; compete(); }
  return prepare(sql);
}) as typeof main.prepare;
gateway.run = async (op, args) => { if (recording && op.name === 'settings.global.write') compete(); return gatewayRun(op, args); };
const rpc = <R>(name: string, input: unknown) => hub.request<R>('operation.invoke', { name, input });
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  setModelsCache(new Map([['global', [{ id: 'synthetic-model', provider: 'anthropic', available: true, thinkingModes: 'none', name: 'Synthetic' }]]]));
  const preference = { model: 'synthetic-model', provider: 'anthropic', thinkingLevel: 'off' };
  const cases = [
    ['neo.session.mute', { key: 'synthetic-muted', muted: true }, 'mute'],
    ['neo.rule.save', { add: ['Keep the complete synthetic rule.'] }, 'rules'],
    ['neo.preferences.set', preference, 'preferences'],
  ] as const;
  for (const [name, input, kind] of cases) {
    peer.updateGlobalSettings({ neo: { autoDispatch: true, standingRules: [], mutedSessions: [] } });
    competitor = () => peer.updateGlobalSettings({ neo: { ...peer.getGlobalSettings().neo, autoDispatch: false, packs: ['synthetic-concurrent-pack'] }, autoScroll: false });
    recording = true;
    const reply = await rpc<{ ok: boolean }>(name, input);
    recording = false;
    assert.equal(competitor, undefined, 'the competing commit must actually run');
    assert.equal(reply.ok, true);
    const stored = peer.getGlobalSettings();
    (report.races as unknown[]).push({ name, reply, persisted: stored.neo, autoScroll: stored.autoScroll });
    assert.equal(stored.neo?.autoDispatch, mode === 'before', 'a Neo edit must retain the concurrent UI edit');
    assert.equal(stored.autoScroll, false);
    if (kind === 'mute') assert.deepEqual(stored.neo?.mutedSessions, ['synthetic-muted']);
    if (kind === 'rules') assert.deepEqual(stored.neo?.standingRules, ['Keep the complete synthetic rule.']);
    if (kind === 'preferences') assert.deepEqual(stored.neo?.preferences, preference);
    if (mode === 'verify') assert.deepEqual(stored.neo?.packs, ['synthetic-concurrent-pack']);
  }
  report.mainWrites = mainWrites;
  assert.equal(mainWrites, mode === 'before' ? 3 : 0);
  if (mode === 'verify') {
    recording = true;
    await Promise.all([
      rpc('neo.session.mute', { key: 'concurrent-a', muted: true }),
      rpc('neo.session.mute', { key: 'concurrent-b', muted: true }),
      rpc('neo.rule.save', { add: ['First concurrent rule.'] }),
      rpc('neo.rule.save', { add: ['Second concurrent rule.'] }),
      hub.request('settings.global.update', { updates: { neo: { autoDispatch: true, packs: ['later-pack'] }, autoScroll: true } }),
    ]);
    const current = peer.getGlobalSettings();
    assert.deepEqual(new Set(current.neo?.mutedSessions), new Set(['concurrent-a', 'concurrent-b']));
    assert.deepEqual(new Set(current.neo?.standingRules), new Set(['First concurrent rule.', 'Second concurrent rule.']));
    assert.deepEqual(current.neo?.preferences, preference);
    assert.equal(current.neo?.autoDispatch, true);
    assert.equal(current.autoScroll, true);
    const refused = await rpc<{ ok: boolean }>('neo.rule.save', { remove: ['not saved'] });
    assert.equal(refused.ok, false);
    assert.deepEqual(peer.getGlobalSettings(), current);
    report.concurrent = current;
    const snapshot = await rpc<{ standingRules: string[]; preferences: unknown }>('neo.snapshot', {});
    assert.deepEqual(new Set(snapshot.standingRules), new Set(current.neo?.standingRules));
    assert(settingsEvents.some((event) => event.neo?.preferences?.model === 'synthetic-model'));
    report.snapshot = snapshot;
    report.settingsEvents = settingsEvents.length;
    let maxLagMs = 0, last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
    try {
      lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", app.db.getDbPath()], { stdio: ['ignore', 'pipe', 'pipe'] });
      const released = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', (code) => code === 0 ? done() : fail(new Error('lock holder failed'))); });
      await new Promise<void>((done) => lock!.stdout!.once('data', () => done()));
      const start = performance.now();
      const held = rpc('neo.session.mute', { key: 'held-lock', muted: true });
      const healthStart = performance.now();
      await hub.request('system.health', {});
      const healthMs = performance.now() - healthStart;
      await held;
      const writeMs = performance.now() - start;
      await released;
      lock = undefined;
      report.contention = { writeMs, healthMs, maxLagMs, affectedWriteUnder250ms: writeMs < 250 };
      assert(writeMs > 1000);
      assert(healthMs < 250);
      assert(maxLagMs < 250);
    } finally { clearInterval(timer); }
    assert.equal(mainWrites, 0);
    recording = false;
  }
  report.verified = true;
} catch (error) { report.error = String(error); throw error; }
finally {
  report.mainWrites = mainWrites;
  main.prepare = prepare;
  gateway.run = gatewayRun;
  lock?.kill();
  unsubscribe();
  setModelsCache(new Map());
  await transport.close();
  peerDb.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/neo-settings-writer.json'), JSON.stringify(report, null, 2));
}
