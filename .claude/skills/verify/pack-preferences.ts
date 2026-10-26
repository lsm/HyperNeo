import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { getNeoPackPreference } from '../../../packages/daemon/src/lib/neo/preferences.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'requires a fresh synthetic database');
mkdirSync(join(run, 'evidence'), { recursive: true });
const snapshots: unknown[] = [];
for (const phase of ['initial', 'restart']) {
  const app = await createDaemonApp({
    config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false,
  });
  let ws: WebSocket | undefined;
  try {
    await app.spaceRuntimeService.ready();
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((done, fail) => {
      ws!.onopen = () => done();
      ws!.onerror = () => fail(new Error('RPC connection failed'));
    });
    const health = await new Promise<unknown>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error('health timeout')), 10000);
      ws!.onmessage = (event) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        if (reply.error) fail(new Error(JSON.stringify(reply.error)));
        else done(reply.data);
      };
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'system.health',
        data: {}, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    const db = app.db.getDatabase();
    const rows = db.prepare('SELECT * FROM neo_pack_preferences ORDER BY pack, scope_key, key').all();
    assert.equal(rows.length, phase === 'initial' ? 1 : 2);
    assert.deepEqual(getNeoPackPreference(db, 'coding', { kind: 'global', key: '' }, 'watchedRepos')?.value, []);
    const scope = { kind: 'repo' as const, key: 'synthetic/repo' };
    const saved = getNeoPackPreference(db, 'coding', scope, 'mergePolicy');
    assert.equal(saved?.value, phase === 'initial' ? undefined : 'human');
    assert.equal(saved?.setBy, phase === 'initial' ? undefined : 'human');
    if (phase === 'restart') assert.equal(saved?.setAt, 123);
    assert.equal(getNeoPackPreference(db, 'coding', { kind: 'repo', key: 'synthetic/new' }, 'mergePolicy'), null);
    snapshots.push({ phase, health, rows, saved });
    if (phase === 'initial') db.prepare(`INSERT INTO neo_pack_preferences
      (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
      VALUES ('coding', 'repo', 'synthetic/repo', 'mergePolicy', '"human"', 'human', 123)`).run();
  } finally {
    ws?.close();
    await app.cleanup();
  }
}
const report = { surface: 'isolated daemon startup, WebSocket health, persisted core lookup across restart', snapshots };
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
