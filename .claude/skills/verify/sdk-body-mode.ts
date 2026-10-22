import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [scenario, portText, runText, sourceText] = process.argv.slice(2);
const port = Number(portText), run = resolve(runText);
assert(['old', 'laptop', 'mixed'].includes(scenario));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
mkdirSync(join(run, 'evidence'), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { DatabaseCore } = await import('../../../packages/daemon/src/storage/database-core.ts');
const { configureLogger, LogLevel, subscribeToStructuredLogs } = await import('../../../packages/daemon/src/lib/logger.ts');
const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const dbPath = join(run, 'data/daemon.db');
const tool = '完整合成工具结果'.repeat(20000);
const pause = (ms = 25) => new Promise<void>((done) => setTimeout(done, ms));
const logs: { level: string; message: string }[] = [];
const modes: string[] = [];
let serving = false, probing = false, maxServingQueryMs = 0;
const slowQueries: Record<string, unknown>[] = [];
configureLogger({ level: LogLevel.WARN });
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.message.includes('SDK body startup mode selected')) logs.push({ level: event.level, message: event.message });
  const metadata = event.metadata as Record<string, unknown> | undefined;
  if (typeof metadata?.durationMs === 'number') {
    maxQueryMs = Math.max(maxQueryMs, metadata.durationMs);
    if (serving && !probing) maxServingQueryMs = Math.max(maxServingQueryMs, metadata.durationMs);
    slowQueries.push({ serving, probing, ...metadata });
    slowQueries.sort((a, b) => Number(b.durationMs) - Number(a.durationMs));
    slowQueries.length = Math.min(slowQueries.length, 10);
  }
});
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let last = performance.now(), maxLagMs = 0, maxQueryMs = 0;
const lagSamples: { lagMs: number; phase: string }[] = [];
const timer = setInterval(() => { const now = performance.now(); const lagMs = now - last - 10; maxLagMs = Math.max(maxLagMs, lagMs); if (lagMs > 100) lagSamples.push({ lagMs, phase: probing ? 'digest-probe' : serving ? 'serving' : 'startup-or-shutdown' }); last = now; }, 10);
const timings: number[] = [];
async function rpc(method: string, data = {}) {
  const id = crypto.randomUUID(), at = performance.now();
  const reply = await new Promise<Record<string, unknown>>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 10000);
    ws!.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.requestId !== id && message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) fail(new Error(JSON.stringify(message.error))); else done(message.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  timings.push(performance.now() - at);
  return reply;
}
async function digest(db: InstanceType<typeof Database>) {
  const side = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sdk_message_bodies'").get());
  const hash = createHash('sha256'); let rows = 0;
  const sql = side ? 'SELECT m.seq,COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq WHERE m.seq>? ORDER BY m.seq LIMIT 256' : 'SELECT seq,sdk_message AS body FROM sdk_messages WHERE seq>? ORDER BY seq LIMIT 256';
  let through = 0;
  for (;;) {
    probing = true;
    const page = db.prepare(sql).all(through) as { seq: number; body: string }[];
    for (const row of page) {
      hash.update(`${row.seq}:${Buffer.byteLength(row.body)}:`); hash.update(row.body); rows++;
      through = row.seq;
    }
    probing = false;
    if (!page.length) break;
    await pause(0);
  }
  probing = false;
  return { rows, hash: hash.digest('hex') };
}
async function stop() { serving = false; ws?.close(); ws = undefined; await app?.cleanup(); app = undefined; }
const startupMs: number[] = [];
async function start() {
  const begin = performance.now(), logAt = logs.length;
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port, dbPath }),
    sqlQueryObservability: { slowThresholdMs: 1, summaryIntervalMs: 300000, maxQueryGroups: 500, summaryQueryLimit: 10 } }, verbose: false });
  startupMs.push(performance.now() - begin);
  await pause(0);
  serving = true;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connect failed')); });
  assert.equal((await rpc('system.health')).status, 'ok');
  const deadline = Date.now() + 120000;
  for (;;) {
    const selected = logs.slice(logAt).find((event) => !event.message.includes('coverage_pending'));
    if (selected) { modes.push(selected.message); break; }
    assert(Date.now() < deadline, `Final startup mode not visible at WARN: ${JSON.stringify(logs.slice(logAt))}`);
    assert.equal((await rpc('system.health')).status, 'ok');
    await pause();
  }
}
function exercise(prefix: string) {
  const repo = app!.db.getSDKMessageRepo(), db = app!.db.getDatabase();
  repo.saveSDKMessage('mode-proof', { type: 'user', uuid: `${prefix}-tool`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: tool }] } });
  repo.saveUserMessage('mode-proof', { type: 'user', uuid: `${prefix}-input`, isSynthetic: true, message: { role: 'user', content: tool } }, 'consumed', 'system');
  assert(repo.normalizeDeliveryMessageForMailbox('mode-proof', `${prefix}-input`));
  repo.saveSDKMessage('mode-proof', { type: 'result', uuid: `${prefix}-result`, subtype: 'success', result: tool });
  repo.markResultRecoveryIntercepted('mode-proof', `${prefix}-result`, true);
  repo.markResultInternalCompactionTurn('mode-proof', `${prefix}-result`);
  const action = { type: 'hyperneo_action', uuid: `${prefix}-action`, session_id: 'mode-proof', action: 'sdk_resume_choice', resolved: false, timestamp: 1792454400000 };
  const id = repo.saveHyperNeoActionMessage('mode-proof', action);
  repo.updateHyperNeoActionMessage(id, { ...action, resolved: true });
  repo.updateHyperNeoActionMessageByUuid('mode-proof', action.uuid, { ...action, resolved: true, chosenOption: 'leave_as_is' });
  const rows = db.prepare("SELECT m.sdk_message AS legacy,b.sdk_message AS side FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq WHERE m.sdk_uuid LIKE ?").all(`${prefix}-%`) as { legacy: string; side: string }[];
  assert.equal(rows.length, 4);
  assert(rows.every((row) => row.side && JSON.parse(row.side)));
  assert((repo.getMessageByUuid('mode-proof', `${prefix}-result`) as { result: string }).result === tool);
  return rows;
}
try {
  const SeedCore = scenario === 'old' ? (await import(pathToFileURL(join(resolve(sourceText), 'packages/daemon/src/storage/database-core.ts')).href)).DatabaseCore : DatabaseCore;
  const core = new SeedCore(dbPath); await core.initialize();
  const seed = core.getDb(); seed.exec('PRAGMA foreign_keys=OFF');
  seed.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES ('mode-proof','Synthetic mode proof',?,datetime('now'),datetime('now'),'active','{}','{}')").run(run);
  const insert = seed.prepare("INSERT INTO sdk_messages(id,session_id,message_type,sdk_uuid,sdk_message,timestamp,send_status,replacement_metadata_normalized) VALUES (?,'mode-proof',?,?,?,'2026-10-20T00:00:00Z','consumed',1)");
  seed.transaction(() => {
    for (let n = 0; n < (scenario === 'old' ? 60000 : 5000); n++) {
      const id = `seed-${n}`;
      const body = JSON.stringify(n % 100 === 0 ? { type: 'user', uuid: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'synthetic-old-tool-result-'.repeat(2400) }] } } : { type: 'assistant', uuid: id, message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic-old-text-'.repeat(320) }] } });
      insert.run(id, n % 100 === 0 ? 'user' : 'assistant', id, body);
    }
  })();
  if (scenario !== 'old') {
    const { backfillSdkMessageColumns } = await import('../../../packages/daemon/src/storage/schema/m413-sdk-message-columns.ts');
    seed.exec("DELETE FROM migration_markers WHERE key='sdk_message_columns_backfilled_v2'");
    await backfillSdkMessageColumns(seed, () => {});
    seed.exec('INSERT INTO sdk_message_bodies SELECT seq,sdk_message FROM sdk_messages');
    seed.exec("INSERT INTO migration_markers VALUES ('sdk_message_bodies_copy_v1:complete',1)");
    if (scenario === 'mixed') seed.exec('DELETE FROM sdk_message_bodies WHERE seq%2=0');
  }
  const before = await digest(seed); core.close();
  last = performance.now(); maxLagMs = 0; lagSamples.length = 0;
  const copyBegin = performance.now();
  await start();
  const db = app!.db.getDatabase();
  assert(modes[0].includes(scenario === 'laptop' ? 'side-only' : 'dual-write'));
  assert.deepEqual(await digest(db), before);
  const initialPage = JSON.stringify(await rpc('message.sdkMessages', { sessionId: 'mode-proof', limit: 2 }));
  assert(initialPage.includes(`seed-${scenario === 'old' ? 59999 : 4999}`));
  if (scenario === 'old') assert(!db.prepare("SELECT 1 FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'").get(), 'Exercise writes while the old-schema copy is still pending');
  const initialRows = exercise('initial');
  assert(initialRows.every((row) => scenario === 'laptop' ? row.legacy === '' : row.legacy === row.side));
  const deadline = Date.now() + 120000;
  while (!db.prepare("SELECT 1 FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'").get()) {
    assert(Date.now() < deadline, 'Copy did not complete');
    assert.equal((await rpc('system.health')).status, 'ok');
    await pause(10);
  }
  const copyElapsedMs = performance.now() - copyBegin;
  if (scenario === 'mixed') {
    const page = await rpc('message.sdkMessages', { sessionId: 'mode-proof', limit: 8 });
    assert(JSON.stringify(page).includes(tool));
    db.exec('INSERT OR IGNORE INTO sdk_message_bodies SELECT seq,sdk_message FROM sdk_messages');
  }
  const afterCopyRows = exercise('same-run');
  assert(afterCopyRows.every((row) => scenario === 'laptop' ? row.legacy === '' : row.legacy === row.side));
  const beforeRestart = await digest(db);
  const missing = db.prepare('SELECT COUNT(*) AS n FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq WHERE b.seq IS NULL').get();
  assert.deepEqual(missing, { n: 0 });
  await stop(); await start();
  assert(modes[1].includes('side-only'));
  assert.deepEqual(await digest(app!.db.getDatabase()), beforeRestart);
  assert(exercise('next-start').every((row) => row.legacy === ''));
  for (let n = 0; n < 25; n++) {
    assert.equal((await rpc('system.health')).status, 'ok');
    assert(JSON.stringify(await rpc('message.sdkMessages', { sessionId: 'mode-proof', limit: 12 })).includes(tool));
    await pause(10);
  }
  const observed = { scenario, before, beforeRestart, modes, startupMs, copyElapsedMs, maxLagMs, lagSamples, maxQueryMs, maxServingQueryMs, slowQueries, rpcReplies: timings.length, maxRpcMs: Math.max(...timings), missing, logs };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify({ ...observed, logs: logs.length }));
} finally { clearInterval(timer); unsubscribe(); await stop(); }
