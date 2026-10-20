import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, portText, runText, sourceRoot] = process.argv.slice(2);
assert(mode === 'verify' || mode === 'reproduce');
const port = Number(portText), run = resolve(runText), dbPath = join(run, 'data/daemon.db');
assert.equal(process.env.NODE_ENV, 'test');
assert(port > 0 && port !== 8399);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(dbPath));
const root = sourceRoot ? resolve(sourceRoot) : resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (path: string) => import(pathToFileURL(join(root, 'packages/daemon/src', path)).href);
const [{ DatabaseCore }, { Database }, { SDKMessageRepository }, { reserveSdkBodyBackupPath, sdkBodyBackupChannel }, { createDaemonApp }, { getConfig }, logger] = await Promise.all([
  load('storage/database-core.ts'), load('storage/sqlite-compat.ts'), load('storage/repositories/sdk-message-repository.ts'), load('storage/sdk-message-body-backup.ts'), load('app.ts'), load('config.ts'), load('lib/logger.ts'),
]);
mkdirSync(join(run, 'home'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const pause = (ms = 10) => new Promise((done) => setTimeout(done, ms));
const logs: { message: string; level: string }[] = [];
logger.configureLogger({ level: logger.LogLevel.INFO });
const unsubscribe = logger.subscribeToStructuredLogs((event: { message: string; level: string }) => logs.push({ message: event.message, level: event.level }));
const core = new DatabaseCore(dbPath);
await core.initialize();
const db = core.getDb();
db.exec('PRAGMA foreign_keys=OFF');
db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('synthetic-lifecycle','Lifecycle probe',?,datetime('now'),datetime('now'),'active','{}','{}')").run(run);
const repository = new SDKMessageRepository(db);
for (let n = 0; n < 5; n++) repository.saveSDKMessage('synthetic-lifecycle', {
  type: 'user', uuid: `lifecycle-${n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'complete-result-'.repeat(100000) }] },
});
const backupPath = await reserveSdkBodyBackupPath(db, dbPath, new AbortController().signal);
const channel = sdkBodyBackupChannel(dbPath, backupPath, new AbortController().signal);
try { await channel.verify(false); } finally { channel.close(); }
const manifestPath = `${backupPath}.verified.json`, manifest = readFileSync(manifestPath, 'utf8');
let ready!: () => void;
const delayed = new Promise<void>((done) => { ready = done; }).then(() => core.startSdkMessageBodyCopy());
core.close();
logs.length = 0;
ready(); await delayed; await pause(100);
const lateLogs = logs.filter((event) => event.message.includes('SDK body copy'));
try { core.close(); } catch {}
const digest = () => {
  const connection = new Database(dbPath, { readonly: true }), hash = createHash('sha256');
  let rows = 0;
  try {
    for (const row of connection.prepare('SELECT m.seq,COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq').iterate() as Iterable<{ seq: number; body: string }>) {
      hash.update(`${row.seq}:${Buffer.byteLength(row.body)}:`).update(row.body); rows++;
    }
    return { hash: hash.digest('hex'), rows };
  } finally { connection.close(); }
};
const before = digest();
logs.length = 0;
writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), hash: 'synthetic-invalid-digest' }));
let app: { cleanup(): Promise<void> } | undefined, ws: WebSocket | undefined;
let last = performance.now(), maxLagMs = 0;
const heartbeat = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
const replies: number[] = [];
try {
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
  logger.configureLogger({ level: logger.LogLevel.INFO });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WebSocket failed')); });
  const started = performance.now();
  while (performance.now() - started < 65000) {
    const id = crypto.randomUUID(), at = performance.now();
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('health timeout')), 5000);
      ws!.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(String(reply.error))); else done(); };
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'system.health', data: {}, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    replies.push(performance.now() - at);
    await pause(100);
  }
} finally {
  clearInterval(heartbeat); ws?.close(); await app?.cleanup(); unsubscribe(); writeFileSync(manifestPath, manifest);
}
const after = digest(), stopped = logs.filter((event) => event.message.includes('operator action'));
const deferred = logs.filter((event) => event.message.includes('SDK body copy deferred'));
const diskChecks = logs.filter((event) => event.message.includes('"phase":"disk_check_passed"'));
const report = { mode, root, before, after, lateLogs, terminalErrors: stopped, deferredAttempts: deferred.length, diskChecks: diskChecks.length, observationMs: 65000, healthReplies: replies.length, maxHealthMs: Math.max(...replies), maxLagMs, backupPath };
writeFileSync(join(run, 'evidence/lifecycle.json'), JSON.stringify(report, null, 2));
writeFileSync(join(run, 'evidence/lifecycle-logs.json'), JSON.stringify(logs));
assert.deepEqual(after, before);
assert(replies.length > 100);
if (mode === 'verify') {
  assert.equal(lateLogs.length, 0); assert.equal(deferred.length, 0); assert.equal(stopped.length, 1); assert.equal(stopped[0].level, 'error'); assert.equal(diskChecks.length, 1); assert(maxLagMs < 1000); assert(report.maxHealthMs < 250);
} else {
  assert(lateLogs.some((event) => event.message.includes('deferred'))); assert(deferred.length >= 2); assert(diskChecks.length >= 2); assert.equal(stopped.length, 0);
}
console.log(JSON.stringify(report));
