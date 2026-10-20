import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { seedWorkFeedDeleteCorpus, storedWorkFeedDigest } from '../../../packages/daemon/tests/helpers/work-feed-delete-corpus.ts';

const [portText, runText, bodyCharsText = '8192'] = process.argv.slice(2);
const port = Number(portText);
const bodyChars = Number(bodyCharsText);
assert(port > 0 && port !== 8399 && runText);
assert(bodyChars > 0 && bodyChars <= 16000);
const run = resolve(runText);
assert(process.env.NODE_ENV === 'test');
assert(process.env.HOME === join(run, 'home'));
assert(process.env.HYPERNEO_DATA_DIR === join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'requires a fresh synthetic database');
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'home'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
const db = app.db.getDatabase();
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
let timer: ReturnType<typeof setInterval> | undefined;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
try {
  await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('connect failed')); });
  seedWorkFeedDeleteCorpus(db, 30000, bodyChars);
  const before = storedWorkFeedDigest(db);
  await pause(200);
  const sql: { text: string; calls: number; maxMs: number }[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((text: string) => {
    const statement = prepare(text);
    if (!text.includes('message_search_content') || !/^\s*(DELETE|SELECT)/i.test(text)) return statement;
    const observation = { text, calls: 0, maxMs: 0 };
    sql.push(observation);
    return new Proxy(statement, { get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const started = performance.now();
        try { return Reflect.apply(value, target, args); }
        finally { observation.calls++; observation.maxMs = Math.max(observation.maxMs, performance.now() - started); }
      };
    } });
  }) as typeof db.prepare;
  const latencies: number[] = [];
  const rpc = () => new Promise<void>((done, fail) => {
    const id = crypto.randomUUID();
    const started = performance.now();
    const timeout = setTimeout(() => fail(new Error('session.get timed out')), 60000);
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId !== id) return;
      clearTimeout(timeout);
      if (message.error) return fail(new Error(JSON.stringify(message.error)));
      latencies.push(performance.now() - started);
      done();
    };
    ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'session.get', data: { sessionId: 'stored-0' }, timestamp: new Date().toISOString() }));
  });
  let maxLagMs = 0;
  let last = performance.now();
  timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
  const job = app.jobQueue.enqueue({ queue: 'work.feed.claude', payload: { scope: 'claude' }, runAt: Date.now() });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await rpc();
    if (['completed', 'dead'].includes(app.jobQueue.getJob(job.id)!.status)) break;
    await pause(10);
  }
  await pause(30);
  clearInterval(timer);
  timer = undefined;
  db.prepare = prepare;
  const remaining = db.prepare("SELECT kind, COUNT(*) AS n FROM message_search_content GROUP BY kind").all();
  const after = storedWorkFeedDigest(db);
  const report = { surface: 'real daemon work.feed.claude maintenance job with concurrent session.get RPC', turns: 30000, bodyChars, job: app.jobQueue.getJob(job.id), maxLagMs, maxRpcMs: Math.max(...latencies), rpcCount: latencies.length, sql, remaining, storedBefore: before, storedAfter: after, runtime: Bun.version };
  writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
  assert.equal(report.job?.status, 'completed');
  assert.equal(before, after, 'stored messages/tool results changed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_search_content WHERE kind = 'claude'").get()?.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_search_content WHERE kind = 'codex'").get()?.n, 3000);
  assert(maxLagMs < 1000, `event-loop block ${maxLagMs.toFixed(1)}ms exceeds 1 s`);
  assert(sql.every((query) => query.maxMs < 250), 'search-content query exceeded 250 ms');
} finally {
  if (timer) clearInterval(timer);
  ws.close();
  await app.cleanup();
}
