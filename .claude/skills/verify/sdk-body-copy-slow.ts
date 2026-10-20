import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, portText, runText] = process.argv.slice(2);
assert(mode === 'verify' || mode === 'reproduce');
const port = Number(portText), run = resolve(runText), dbPath = join(run, 'data/daemon.db');
assert.equal(process.env.NODE_ENV, 'test'); assert(port > 0 && port !== 8399);
assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(dbPath)); mkdirSync(join(run, 'evidence'), { recursive: true });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (path: string) => import(pathToFileURL(join(root, 'packages/daemon/src', path)).href);
const [{ DatabaseCore }, { Database }, { SDKMessageRepository }, { createDaemonApp }, { getConfig }, logger] = await Promise.all([
  load('storage/database-core.ts'), load('storage/sqlite-compat.ts'), load('storage/repositories/sdk-message-repository.ts'), load('app.ts'), load('config.ts'), load('lib/logger.ts'),
]);
const copySourceHash = createHash('sha256').update(readFileSync(join(root, 'packages/daemon/src/storage/sdk-message-body-copy.ts'))).digest('hex');
const core = new DatabaseCore(dbPath); await core.initialize(); const seed = core.getDb();
seed.exec('PRAGMA foreign_keys=OFF');
seed.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('synthetic-slow','Slow chunk',?,datetime('now'),datetime('now'),'active','{}','{}')").run(run);
const repo = new SDKMessageRepository(seed);
for (let n = 0; n < 5; n++) repo.saveSDKMessage('synthetic-slow', { type: 'user', uuid: `slow-${n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'complete-result-'.repeat(100000) }] } });
core.close();
const digest = () => {
  const db = new Database(dbPath, { readonly: true }), hash = createHash('sha256'); let rows = 0;
  try { for (const row of db.prepare('SELECT m.seq,COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq').iterate() as Iterable<{ seq: number; body: string }>) { hash.update(`${row.seq}:${Buffer.byteLength(row.body)}:`).update(row.body); rows++; } return { hash: hash.digest('hex'), rows }; }
  finally { db.close(); }
};
const before = digest(), logs: Record<string, unknown>[] = [];
const unsubscribe = logger.subscribeToStructuredLogs((event: { message: string }) => {
  const prefix = 'SDK body copy: ';
  if (event.message.startsWith(prefix)) logs.push(JSON.parse(event.message.slice(prefix.length)));
  else if (event.message.includes('SDK body copy deferred')) logs.push({ phase: 'deferred', message: event.message });
});
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
let injected = false, maxLagMs = 0, last = performance.now();
const heartbeat = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10), replies: number[] = [];
try {
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false }); logger.configureLogger({ level: logger.LogLevel.INFO });
  const db = app.db.getDatabase(), original = db.prepare.bind(db);
  db.prepare = (sql: string, ...args: unknown[]) => {
    const statement = original(sql, ...args);
    if (!sql.startsWith("UPDATE sdk_messages SET sdk_message=''")) return statement;
    return new Proxy(statement, { get(target, name) {
      const value = Reflect.get(target, name, target);
      if (name !== 'run') return typeof value === 'function' ? value.bind(target) : value;
      return (...params: unknown[]) => { const result = value.apply(target, params); if (!injected) { injected = true; const until = performance.now() + 300; while (performance.now() < until) {} } return result; };
    } });
  };
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WebSocket failed')); });
  const deadline = Date.now() + 75000;
  while (!logs.some((entry) => entry.phase === 'complete') && Date.now() < deadline) {
    const id = crypto.randomUUID(), at = performance.now();
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('health timeout')), 5000);
      ws!.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(String(reply.error))); else done(); };
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'system.health', data: {}, timestamp: new Date().toISOString(), version: '1.0.0' }));
    }); replies.push(performance.now() - at); await new Promise((done) => setTimeout(done, 25));
  }
} finally { clearInterval(heartbeat); ws?.close(); await app?.cleanup(); unsubscribe(); }
const after = digest(), verifications = logs.filter((entry) => entry.phase === 'backup_verified').length;
const report = { mode, copySourceHash, before, after, injectedMs: 300, verifications, pauses: logs.filter((entry) => entry.phase === 'slow_chunk_pause').length, deferred: logs.filter((entry) => entry.phase === 'deferred').length, healthReplies: replies.length, maxHealthMs: Math.max(...replies), maxLagMs, logs };
writeFileSync(join(run, 'evidence/slow-chunk.json'), JSON.stringify(report, null, 2));
assert(injected); assert(logs.some((entry) => entry.phase === 'complete')); assert.deepEqual(after, before);
if (mode === 'verify') { assert.equal(verifications, 1); assert.equal(report.pauses, 1); assert.equal(report.deferred, 0); }
else { assert.equal(verifications, 2); assert.equal(report.pauses, 0); assert.equal(report.deferred, 1); }
console.log(JSON.stringify({ ...report, logs: undefined, note: '300 ms synchronous stall was deliberately injected, not a physical disk performance measurement' }));
