import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [mode, portText, runText, sourceText] = process.argv.slice(2);
const port = Number(portText), run = resolve(runText), source = resolve(sourceText ?? '.');
assert(['reproduce', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
mkdirSync(join(run, 'evidence'), { recursive: true });
const load = (path: string) => import(pathToFileURL(join(source, path)).href);
const { createDaemonApp } = await load('packages/daemon/src/app.ts');
const { getConfig } = await load('packages/daemon/src/config.ts');
const { Database } = await load('packages/daemon/src/storage/sqlite-compat.ts');
const { configureLogger, LogLevel, subscribeToStructuredLogs } = await load('packages/daemon/src/lib/logger.ts');
const dbPath = join(run, 'data/daemon.db');
let app: Awaited<ReturnType<typeof createDaemonApp>>, ws: WebSocket | undefined;
let maxLagMs = 0, last = performance.now(), measuring = true;
const timer = setInterval(() => {
  const now = performance.now();
  if (measuring) maxLagMs = Math.max(maxLagMs, now - last - 10);
  last = now;
}, 10);
const pause = (ms = 25) => new Promise((done) => setTimeout(done, ms));
const timings: { method: string; elapsedMs: number }[] = [];
async function rpc(method: string, data = {}) {
  const id = crypto.randomUUID(), at = performance.now();
  const reply = await new Promise<Record<string, unknown>>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 10000);
    ws!.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId !== id && message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) fail(new Error(JSON.stringify(message.error)));
      else done(message.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  timings.push({ method, elapsedMs: performance.now() - at });
  return reply;
}
const toolResult = '完整工具结果'.repeat(50000);
try {
  const start = performance.now();
  app = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port, dbPath }), verbose: false });
  const startupMs = performance.now() - start;
  const db = app.db.getDatabase(), repo = app.db.getSDKMessageRepo();
  const deadline = Date.now() + 15000;
  while (!db.prepare("SELECT 1 FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'").get()) {
    assert(Date.now() < deadline, 'Fresh empty copy did not settle');
    await pause();
  }
  measuring = false;
  db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('side-proof','Side body proof',?,datetime('now'),datetime('now'),'active','{}','{}')").run(run);
  for (let n = 0; n < 5000; n++) repo.saveSDKMessage('side-proof', {
    type: 'assistant', uuid: `small-${n}`, message: { role: 'assistant', content: [{ type: 'text', text: `Synthetic message ${n}` }] },
  });
  repo.saveSDKMessage('side-proof', { type: 'user', uuid: 'tool', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: toolResult }] } });
  repo.saveUserMessage('side-proof', { type: 'user', uuid: 'input', isSynthetic: true, message: { role: 'user', content: toolResult } }, 'consumed', 'system');
  assert(repo.normalizeDeliveryMessageForMailbox('side-proof', 'input'));
  repo.saveSDKMessage('side-proof', { type: 'result', uuid: 'result', subtype: 'success', result: toolResult });
  repo.markResultRecoveryIntercepted('side-proof', 'result', true);
  repo.markResultInternalCompactionTurn('side-proof', 'result');
  const action = { type: 'hyperneo_action', uuid: 'action', session_id: 'side-proof', action: 'sdk_resume_choice', resolved: false, timestamp: 1792454400000 };
  const actionId = repo.saveHyperNeoActionMessage('side-proof', action);
  repo.updateHyperNeoActionMessage(actionId, { ...action, resolved: true });
  repo.updateHyperNeoActionMessageByUuid('side-proof', 'action', { ...action, resolved: true, chosenOption: 'leave_as_is' });
  const legacyRows = (db.prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_message<>''").get() as { n: number }).n;
  const count = (db.prepare('SELECT COUNT(*) AS n FROM sdk_messages').get() as { n: number }).n;
  const hash = createHash('sha256');
  for (const row of db.prepare('SELECT seq,sdk_message FROM sdk_message_bodies ORDER BY seq').iterate() as Iterable<{ seq: number; sdk_message: string }>) {
    hash.update(`${row.seq}:${Buffer.byteLength(row.sdk_message)}:`); hash.update(row.sdk_message);
  }
  const fullBodyHash = hash.digest('hex');
  measuring = true; last = performance.now();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  for (let n = 0; n < 25; n++) {
    assert.equal((await rpc('system.health')).status, 'ok');
    const rows = await rpc('message.sdkMessages', { sessionId: 'side-proof', limit: 6 });
    const serialized = JSON.stringify(rows);
    assert(serialized.includes(toolResult));
    assert(serialized.includes('recovery_intercepted'));
    await pause(10);
  }
  ws.close(); ws = undefined;
  await app.cleanup(); app = undefined;
  const guardDb = new Database(dbPath);
  guardDb.exec("DELETE FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'");
  guardDb.close();
  configureLogger({ level: LogLevel.WARN });
  const refusalLogs: { level: string; message: string }[] = [];
  const unsubscribe = subscribeToStructuredLogs((event: { level: string; message: string }) => {
    if (event.message.includes('side-only startup refused')) refusalLogs.push({ level: event.level, message: event.message });
  });
  let refused = false, refusal = '';
  try { app = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port, dbPath }), verbose: false }); }
  catch (error) { refusal = String(error); refused = refusal.includes('side-only startup refused'); }
  unsubscribe();
  const observation = { mode, source, startupMs, legacyRows, count, fullBodyHash, maxLagMs, maxRpcMs: Math.max(...timings.map((t) => t.elapsedMs)), timings, refused, refusal, refusalLogs };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observation, null, 2));
  if (mode === 'verify') { assert.equal(legacyRows, 0); assert(refused); assert(refusalLogs.some((event) => event.level === 'error')); }
  else { assert(legacyRows > 0); assert(!refused); }
  console.log(JSON.stringify({ ...observation, timings: timings.length }));
} finally { clearInterval(timer); ws?.close(); await app?.cleanup(); }
