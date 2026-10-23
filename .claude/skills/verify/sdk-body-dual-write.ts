import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SDKMessageRepository } from '../../../packages/daemon/src/storage/repositories/sdk-message-repository.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const [portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(port > 0 && port !== 8399);
assert(process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const dbPath = join(run, 'data/daemon.db');
const seed = JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8'));
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let maxLagMs = 0;
let last = performance.now();
const timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
const pause = () => new Promise((done) => setTimeout(done, 25));
const queries: { sql: string; method: string; elapsedMs: number }[] = [];
const calls: { method: string; elapsedMs: number; data: unknown }[] = [];
const phases: Record<string, number> = {};
const start = async () => {
  last = performance.now();
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
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
        finally { queries.push({ sql, method: String(key), elapsedMs: performance.now() - at }); }
      };
    } });
  }) as typeof db.prepare;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  return { db, prepare };
};
const rpc = async (method: string, data: unknown, includeEvents = false) => {
  const id = crypto.randomUUID();
  const at = performance.now();
  const events: unknown[] = [];
  const reply = await new Promise<Record<string, unknown>>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 30000);
    ws!.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'EVENT') events.push({ method: message.method, data: message.data });
      if (message.requestId !== id && message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) fail(new Error(JSON.stringify(message.error)));
      else if (includeEvents) setTimeout(() => done({ reply: message.data, events }), 25);
      else done(message.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  calls.push({ method, elapsedMs: performance.now() - at, data: reply });
  return reply;
};
const stop = async () => { ws?.close(); ws = undefined; await app?.cleanup(); app = undefined; };
try {
  const first = await start();
  await pause(); phases.startupLagMs = maxLagMs; maxLagMs = 0; last = performance.now();
  const repo = new SDKMessageRepository(first.db);
  const full = '完整工具结果-'.repeat(100000);
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    ids.push(repo.saveUserMessageCore('synthetic-live', { type: 'user', uuid: `dual-${i}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-tool', content: full }] } } as SDKMessage).id);
    await pause();
  }
  const resultId = 'proof-recovery';
  assert(await app!.db.saveSDKMessage('synthetic-live', { type: 'result', uuid: resultId, subtype: 'success', result: 'complete' } as SDKMessage));
  repo.markResultRecoveryIntercepted('synthetic-live', resultId, true);
  repo.markResultInternalCompactionTurn('synthetic-live', resultId);
  const recovery = first.prepare('SELECT m.sdk_message AS original,b.sdk_message AS body FROM sdk_messages m JOIN sdk_message_bodies b USING(seq) WHERE m.sdk_uuid=?').get(resultId) as { original: string; body: string };
  assert.equal(recovery.original, recovery.body);
  assert.equal(JSON.parse(recovery.body).recovery_billing_terminal, 1);
  const created = await rpc('session.create', { workspacePath: run, title: 'Synthetic dual-write proof' });
  const sid = created.sessionId;
  assert.equal(typeof sid, 'string');
  const text = 'RPC dual-write token';
  const sent = await rpc('message.send', { sessionId: sid, content: text, deliveryMode: 'defer' });
  assert(sent.messageId);
  let body: { original: string; body: string } | null = null;
  for (let attempt = 0; attempt < 100 && !body; attempt++) {
    body = first.prepare('SELECT m.sdk_message AS original,b.sdk_message AS body FROM sdk_messages m JOIN sdk_message_bodies b USING(seq) WHERE m.sdk_uuid=?').get(sent.messageId) as typeof body;
    if (!body) await new Promise((done) => setTimeout(done, 100));
  }
  assert(body, 'Mailbox input never materialized into SDK storage');
  const readFeed = () => rpc('liveQuery.subscribe', { queryName: 'messages.bySession', subscriptionId: 'dual-body-proof', params: [sid, 200] }, true);
  const feed = await readFeed();
  writeFileSync(join(run, 'evidence/rpc-before-restart.json'), JSON.stringify(feed, null, 2));
  assert.equal(body.body, body.original);
  assert(body.body.includes(text));
  assert(JSON.stringify(feed).includes(text));
  const beforeDelete = first.prepare('SELECT b.sdk_message FROM sdk_message_bodies b JOIN sdk_messages m USING(seq) WHERE m.id=?').get(ids[1]) as { sdk_message: string };
  first.db.prepare('DELETE FROM sdk_messages WHERE id=?').run(ids[0]);
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies b LEFT JOIN sdk_messages m USING(seq) WHERE m.seq IS NULL').get().n, 0);
  const remaining = first.prepare('SELECT b.sdk_message FROM sdk_message_bodies b JOIN sdk_messages m USING(seq) WHERE m.id=?').get(ids[1]) as { sdk_message: string };
  assert.equal(remaining.sdk_message, beforeDelete.sdk_message);
  assert.equal(JSON.parse(remaining.sdk_message).message.content[0].content, full);
  const mirrorHash = () => {
    const hash = createHash('sha256');
    for (const row of first.prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').iterate() as Iterable<{ sdk_message: string }>) hash.update(row.sdk_message);
    return hash.digest('hex');
  };
  await pause(); phases.operationsLagMs = maxLagMs;
  const initialHash = mirrorHash();
  const legacyHash = createHash('sha256');
  for (const row of first.prepare('SELECT sdk_message FROM sdk_messages WHERE seq<=? ORDER BY seq').iterate(seed.rows) as Iterable<{ sdk_message: string }>) legacyHash.update(row.sdk_message);
  assert.equal(legacyHash.digest('hex'), seed.bodyHash);
  await stop();
  maxLagMs = 0; last = performance.now();
  const second = await start();
  await pause(); phases.restartLagMs = maxLagMs;
  const after = await readFeed();
  writeFileSync(join(run, 'evidence/rpc-after-restart.json'), JSON.stringify(after, null, 2));
  const snapshot = (value: Record<string, unknown>) => {
    const event = (value.events as { method: string; data: { rows: unknown; metadata: unknown } }[]).find((entry) => entry.method === 'liveQuery.snapshot');
    assert(event);
    return { rows: event.data.rows, metadata: event.data.metadata };
  };
  assert.deepEqual(snapshot(after), snapshot(feed));
  const afterHash = createHash('sha256');
  for (const row of second.prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').iterate() as Iterable<{ sdk_message: string }>) afterHash.update(row.sdk_message);
  assert.equal(afterHash.digest('hex'), initialHash);
  const counts = second.prepare('SELECT (SELECT COUNT(*) FROM sdk_messages) AS messages,(SELECT COUNT(*) FROM sdk_message_bodies) AS bodies').get();
  const report = { syntheticOnly: true, corpusRows: seed.rows, normalizedSeed: 1, fullToolResultCharacters: full.length, retainedToolResultUnchanged: true, legacyBodyHash: seed.bodyHash, mirrorHash: initialHash, restartFeedIdentical: true, counts, phases, maxQueryMs: Math.max(...queries.map((q) => q.elapsedMs)), queries, calls };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, queries: queries.length, calls: calls.length }));
  assert(Math.max(...Object.values(phases)) < 1000);
  assert(report.maxQueryMs < 250);
} finally { clearInterval(timer); await stop(); }
