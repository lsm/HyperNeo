import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [mode, runText, portText, rowsText = '200000'] = process.argv.slice(2);
const run = resolve(runText), port = Number(portText), path = join(run, 'data/daemon.db');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
assert(['seed', 'serve', 'verify'].includes(mode));
mkdirSync(join(run, 'evidence'), { recursive: true });
const pause = (ms = 25) => new Promise<void>(done => setTimeout(done, ms));
const doneKey = 'sdk_message_columns_backfilled_v2', prefix = 'sdk_message_columns_backfill_v2:';
if (mode === 'seed') {
  assert(!existsSync(path), 'Fresh synthetic database required');
  const core = new DatabaseCore(path); await core.initialize(); const db = core.getDb();
  const count = Number(rowsText), hash = createHash('sha256');
  db.prepare(`INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata)
    VALUES ('synthetic-backfill','Synthetic backfill',?,datetime('now'),datetime('now'),'active','{}','{}')`).run(run);
  const insert = db.prepare(`INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,timestamp,send_status,replacement_metadata_normalized)
    VALUES (?,'synthetic-backfill','user',?,'2026-10-23T00:00:00Z','consumed',1)`);
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const body = JSON.stringify({ type: 'user', uuid: `synthetic-${i}`, inputKind: 'task', isReplay: false,
        message: { role: 'user', content: [{ type: 'text', text: 'synthetic '.repeat(200) }] } });
      insert.run(`synthetic-${i}`, body); hash.update(body);
    }
    db.prepare('DELETE FROM migration_markers WHERE key=?').run(doneKey);
  })();
  writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ rows: count, hash: hash.digest('hex') }));
  core.close();
} else if (mode === 'serve') {
  const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
  const { getConfig } = await import('../../../packages/daemon/src/config.ts');
  const app = await createDaemonApp({ config: getConfig({ host: '127.0.0.1', port, dbPath: path }), verbose: false, standalone: true });
  await app.jobProcessor.stop();
  process.on('SIGTERM', () => { void app.cleanup().then(() => process.exit(0)); });
  writeFileSync(join(run, 'evidence/listening.json'), JSON.stringify({ port: app.server.port }));
} else {
  assert(existsSync(join(run, 'evidence/seed.json')));
  const evidence: Record<string, unknown> = { startup: [], interrupted: null, resumed: null };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let ws: WebSocket | undefined;
  const pending = new Map<string, { done: (value: any) => void; fail: (error: Error) => void }>();
  const rpc = (method: string, data = {}) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => { pending.delete(id); fail(new Error(`RPC deadline: ${method}`)); }, 10000); pending.set(id, { done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  async function connect() {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC unavailable')); });
    ws.onmessage = (event) => { const m = JSON.parse(String(event.data)); const id = pending.has(m.requestId) ? m.requestId : m.id; const waiter = pending.get(id); if (!waiter) return; pending.delete(id); m.error ? waiter.fail(new Error(JSON.stringify(m.error))) : waiter.done(m.data); };
    ws.onclose = () => { for (const p of pending.values()) p.fail(new Error('Owned daemon disconnected')); pending.clear(); };
  }
  const probe = new Database(path, { readonly: true });
  const progress = () => {
    const cursor = probe.prepare('SELECT key FROM migration_markers WHERE key GLOB ?').get(`${prefix}*`) as { key: string } | null;
    return { through: cursor ? Number(cursor.key.slice(prefix.length)) : 0,
      complete: Boolean(probe.prepare('SELECT 1 FROM migration_markers WHERE key=?').get(doneKey)) };
  };
  async function start(label: string) {
    const file = openSync(join(run, `evidence/${label}.log`), 'w'); const began = performance.now();
    child = Bun.spawn([process.execPath, import.meta.path, 'serve', run, String(port)],
      { env: { ...process.env }, stdin: 'ignore', stdout: file, stderr: file }); closeSync(file);
    let response: Response | undefined;
    while (performance.now() - began < 5000) {
      try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }); if (response.status === 200) break; } catch {}
      await pause();
    }
    const result = { label, healthStatus: response?.status ?? null, elapsedMs: performance.now() - began, progress: progress(), health: response?.status === 200 ? await response.json() : null };
    (evidence.startup as unknown[]).push(result);
    assert.equal(result.healthStatus, 200, 'REPRO: long data backfill blocks HTTP health startup');
    assert.equal(result.progress.complete, false, 'Health must serve while backfill is pending');
    return result;
  }
  async function stop(signal: 'SIGKILL' | 'SIGTERM') { ws?.close(); ws = undefined; child?.kill(signal); await child?.exited; child = undefined; }
  try {
    assert(!progress().complete);
    await start('first'); await connect();
    const health = await rpc('system.health');
    assert(['pending', 'running'].includes(health.dataMigration.state));
    evidence.healthDuringBackfill = health;
    const system = await rpc('state.global.snapshot', { includeSessions: false });
    evidence.globalSystemDuringBackfill = system.system.health;
    assert(['pending', 'running'].includes(system.system.health.dataMigration.state));
    const readBegan = performance.now();
    await assert.rejects(rpc('message.sdkMessages', { sessionId: 'synthetic-backfill', limit: 2 }), /being prepared/);
    evidence.historyPreparingReplyMs = performance.now() - readBegan;
    assert(performance.now() - readBegan < 5000, 'Preparation reply must precede client timeout');
    const created = await rpc('session.create', { workspacePath: run, title: 'Synthetic new session' });
    const fresh = await rpc('message.sdkMessages', { sessionId: created.sessionId, limit: 2 });
    evidence.newSessionDuringBackfill = { sessionId: created.sessionId, page: fresh };
    assert.equal((await rpc('system.health')).status, 'ok');
    evidence.historyReadRefusedAsPreparing = true;
    const until = Date.now() + 30000;
    while (progress().through === 0) { assert(Date.now() < until, 'No persisted progress'); await pause(); }
    await stop('SIGKILL'); const interrupted = progress(); evidence.interrupted = interrupted;
    assert(interrupted.through > 0 && !interrupted.complete);
    const second = await start('restart'); assert(second.progress.through >= interrupted.through); await connect();
    const finishBy = Date.now() + 120000;
    while (!progress().complete) {
      assert(Date.now() < finishBy, 'Background backfill did not complete');
      assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200); await pause(100);
    }
    evidence.resumed = progress();
    const completed = await rpc('system.health');
    assert.equal(completed.dataMigration.state, 'complete');
    const restored = await rpc('message.sdkMessages', { sessionId: 'synthetic-backfill', limit: 2 });
    assert.equal(restored.sdkMessages.length, 2);
    evidence.historyAfterBackfill = { count: restored.sdkMessages.length, hasMore: restored.hasMore };
    evidence.healthAfterBackfill = completed;
    assert(progress().through === 0, 'Completed pass retires only its cursor');
    const hash = createHash('sha256'); let after = 0, count = 0;
    for (;;) {
      const page = probe.prepare('SELECT m.seq,COALESCE(b.sdk_message,m.sdk_message) AS sdk_message FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq WHERE m.session_id=? AND m.seq>? ORDER BY m.seq LIMIT 512').all('synthetic-backfill', after) as { seq: number; sdk_message: string }[];
      if (!page.length) break;
      for (const row of page) { hash.update(row.sdk_message); after = row.seq; count++; }
    }
    assert.deepEqual({ rows: count, hash: hash.digest('hex') }, JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8')));
    assert.equal((probe.prepare("SELECT count(*) AS n FROM sdk_messages WHERE session_id='synthetic-backfill' AND user_status_eligible=1").get() as { n: number }).n, count);
    evidence.verified = true;
  } finally {
    await stop('SIGKILL'); probe.close();
    writeFileSync(join(run, 'evidence/startup.json'), JSON.stringify(evidence, null, 2));
  }
}
