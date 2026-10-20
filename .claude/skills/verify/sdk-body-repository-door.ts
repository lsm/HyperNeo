import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [mode, portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(['reproduce', 'verify'].includes(mode));
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const queries: { sql: string; elapsedMs: number; plan?: unknown }[] = [];
const calls: { method: string; elapsedMs: number }[] = [];
let maxLagMs = 0;
let last = performance.now();
let measuring = true;
const timer = setInterval(() => {
  const now = performance.now();
  if (measuring) maxLagMs = Math.max(maxLagMs, now - last - 10);
  last = now;
}, 10);
const pause = () => new Promise((done) => setTimeout(done, 25));
const start = async () => {
  last = performance.now();
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (!['get', 'all', 'run'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
      return (...params: unknown[]) => {
        const at = performance.now();
        try { return value.apply(target, params); }
        finally { if (measuring) queries.push({ sql, elapsedMs: performance.now() - at, plan: sql.includes('body_selection') ? prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) : undefined }); }
      };
    } });
  }) as typeof db.prepare;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  return prepare;
};
const rpc = async (method: string, data: unknown) => {
  const id = crypto.randomUUID();
  const at = performance.now();
  const result = await new Promise<unknown>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 30000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.requestId !== id && reply.id !== id) return;
      clearTimeout(timeout);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  calls.push({ method, elapsedMs: performance.now() - at });
  return result;
};
const stop = async () => { ws?.close(); ws = undefined; await app?.cleanup(); app = undefined; };
try {
  let prepare = await start();
  await pause();
  const startupLagMs = maxLagMs;
  maxLagMs = 0;
  const params = { sessionId: 'synthetic-live', limit: 200 };
  const baseline = await rpc('message.sdkMessages', params);
  const keyBaseline = await rpc('message.sdkMessage', { sessionId: params.sessionId, messageUuid: 'parent' });
  measuring = false;
  const hash = () => {
    const digest = createHash('sha256');
    for (const row of prepare(`SELECT COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.rowid ORDER BY m.rowid`).iterate() as Iterable<{ body: string }>) digest.update(row.body);
    return digest.digest('hex');
  };
  const beforeHash = hash();
  prepare(`UPDATE sdk_messages SET sdk_message='' WHERE rowid IN
    (SELECT m.rowid FROM sdk_messages m JOIN sdk_message_bodies b ON b.seq=m.rowid
      WHERE m.session_id='synthetic-live' ORDER BY m.timestamp DESC,m.rowid DESC LIMIT 500)`).run();
  last = performance.now(); measuring = true;
  let failure: string | undefined;
  let after: unknown;
  try { after = await rpc('message.sdkMessages', params); } catch (error) { failure = String(error); }
  if (mode === 'reproduce') {
    assert(failure || JSON.stringify(after) !== JSON.stringify(baseline), 'Old behavior did not reproduce');
    writeFileSync(join(run, 'evidence/reproduction.json'), JSON.stringify({ failure, baselinePresent: !!baseline, after }, null, 2));
    console.log(JSON.stringify({ reproduced: true, failure }));
  } else {
    assert.equal(failure, undefined);
    assert.deepEqual(after, baseline);
    assert.deepEqual(await rpc('message.sdkMessage', { sessionId: params.sessionId, messageUuid: 'parent' }), keyBaseline);
    await pause();
    const requestLagMs = maxLagMs;
    await stop();
    maxLagMs = 0;
    prepare = await start();
    await pause();
    const restartLagMs = maxLagMs;
    maxLagMs = 0;
    assert.deepEqual(await rpc('message.sdkMessages', params), baseline);
    assert.deepEqual(await rpc('message.sdkMessage', { sessionId: params.sessionId, messageUuid: 'parent' }), keyBaseline);
    await pause();
    const restartedRequestLagMs = maxLagMs;
    measuring = false;
    const afterHash = hash();
    assert.equal(afterHash, beforeHash);
    const observed = { rows: prepare('SELECT COUNT(*) AS n FROM sdk_messages').get(), startupLagMs, restartLagMs, requestLagMs, restartedRequestLagMs, maxQueryMs: Math.max(...queries.map((query) => query.elapsedMs)), calls, queries, beforeHash, afterHash, replacement_metadata_normalized: 1, baseline, after };
    assert(Math.max(startupLagMs, restartLagMs, requestLagMs, restartedRequestLagMs) < 1000);
    assert(observed.maxQueryMs < 250);
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
    console.log(JSON.stringify({ ...observed, baseline: undefined, after: undefined, queries: undefined }));
  }
} finally { clearInterval(timer); await stop(); }
