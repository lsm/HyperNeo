import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { MESSAGES_BY_SESSION_SQL, BACKGROUND_TASK_METADATA_SQL, mapMessageRow, mapThinMessageRow } from '../../../packages/daemon/src/lib/live-query/queries/messages.ts';
import { expandSessionMessages } from '../../../packages/daemon/src/lib/live-query/queries/message-children.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';

const [mode, run] = process.argv.slice(2);
assert(['baseline', 'verify'].includes(mode)); assert(run?.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await mkdir(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), port: 0, disableWorktrees: true, disableGoalProcessing: true, sqlQueryObservability: { slowThresholdMs: 250, summaryIntervalMs: 300000, maxQueryGroups: 500, summaryQueryLimit: 10 } }, standalone: false, verbose: false });
assert.notEqual(app.server.port, 8399);
const url = `ws://127.0.0.1:${app.server.port}/ws`, ws = new WebSocket(url);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const events: { method: string; data: Record<string, unknown> }[] = [];
ws.onmessage = ({ data }) => { const reply = JSON.parse(String(data)); if (reply.type === 'EVENT') events.push(reply); const id = reply.requestId ?? reply.id, p = pending.get(id); if (!p) return; pending.delete(id); reply.error ? p.reject(new Error(JSON.stringify(reply.error))) : p.resolve(reply.data); };
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('RPC socket failed')); });
const rpc = (method: string, data: unknown = {}) => new Promise<unknown>((resolve, reject) => { const id = crypto.randomUUID(), timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout ${method}`)); }, 60000); pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } }); ws.send(JSON.stringify({ id, method, data, type: 'REQ', sessionId: 'global', version: '1.0.0', timestamp: new Date().toISOString() })); });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence: Record<string, unknown> = { mode, runtime: Bun.version, url, seedExcludedFromMeasurement: true };
const workerMetrics: unknown[] = [], cloneMetrics: unknown[] = [], mainQueries: { sql: string; ms: number }[] = [];
let measuring = false, probe: ReturnType<typeof spawn> | undefined, probeOutput = '', probeErrors = '', timer: ReturnType<typeof setInterval> | undefined;
const OriginalWorker = globalThis.Worker;
let selectedWorker: Worker | undefined;
globalThis.Worker = function(url: string | URL, options?: WorkerOptions) { const worker = new OriginalWorker(url, options); if (String(url).endsWith('/sdk-status-worker.ts')) { selectedWorker = worker; const post = worker.postMessage.bind(worker); worker.postMessage = ((message: unknown) => { const at = performance.now(); post(message); if (measuring) cloneMetrics.push({ kind: 'argument', bytes: Buffer.byteLength(JSON.stringify(message)), postMs: performance.now() - at }); }) as typeof worker.postMessage; worker.addEventListener('message', ({ data }) => { if (measuring && data.result) cloneMetrics.push({ kind: 'reply', bytes: Buffer.byteLength(JSON.stringify(data.result)), replyAndQueueMs: Date.now() - data.finishedAt }); }); } return worker; } as unknown as typeof Worker;
const offLogs = subscribeToStructuredLogs((event) => { if (event.module === 'hyperneo:daemon:sqlite.worker' || event.metadata?.workerKind === 'sdk-status') workerMetrics.push(event.metadata); });
try {
  const { sessionId } = await rpc('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic live read', config: { queryMode: 'manual' } }) as { sessionId: string };
  await rpc('message.sdkMessages', { sessionId, limit: 20 });
  const large = 'complete tool output 🦊\n'.repeat(500000);
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) { const saved = app.db.saveUserMessage(sessionId, { type: 'user', uuid: `live-${i}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: large }] } } as SDKMessage, 'consumed'); ids.push(saved); await wait(0); }
  app.db.saveSDKMessage(sessionId, { type: 'assistant', uuid: 'parent', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'live-child', name: 'Bash', input: {} }] } } as SDKMessage);
  for (let i = 0; i < 5; i++) app.db.saveUserMessage(sessionId, { type: 'user', uuid: `child-${i}`, parent_tool_use_id: 'live-child', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `child-tool-${i}`, content: large }] } } as SDKMessage, 'consumed');
  app.db.saveSDKMessage(sessionId, { type: 'system', subtype: 'task_started', uuid: 'background', task_id: 'live-task' } as SDKMessage);
  const raw = app.db.getDatabase();
  const hash = () => { const h = createHash('sha256'); let count = 0, bytes = 0; for (const row of raw.prepare('SELECT COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq').iterate() as Iterable<{ body: string }>) { h.update(row.body); count++; bytes += Buffer.byteLength(row.body); } return { sha256: h.digest('hex'), count, bytes }; };
  const reference = (compact: boolean) => { const map = compact ? mapThinMessageRow : mapMessageRow; return { rows: expandSessionMessages(raw.prepare(MESSAGES_BY_SESSION_SQL).all(sessionId, 30) as Record<string, unknown>[], [sessionId, 30], raw).map(map), metadata: { backgroundTaskMessages: (raw.prepare(BACKGROUND_TASK_METADATA_SQL).all(...Array(7).fill(sessionId)) as Record<string, unknown>[]).map(map).reverse() } }; };
  const expected = JSON.parse(JSON.stringify(reference(false))), expectedCompact = JSON.parse(JSON.stringify(reference(true)));
  assert(expected.rows.some((row: { uuid: string }) => row.uuid === 'child-0'));
  assert(expected.metadata.backgroundTaskMessages.some((row: { uuid: string }) => row.uuid === 'background'));
  evidence.beforeBodies = hash(); app.db.getSDKMessageRepo().flushMessageSearchIndex(); Bun.gc(true); await wait(100); Bun.gc(true);
  const prepare = raw.prepare.bind(raw);
  raw.prepare = ((sql: string) => { const stmt = prepare(sql); return new Proxy(stmt, { get(target, key) { const value = Reflect.get(target, key); if (!['get', 'all', 'run'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value; return (...args: unknown[]) => { const at = performance.now(); try { return value.apply(target, args); } finally { if (measuring) mainQueries.push({ sql, ms: performance.now() - at }); } }; } }); }) as typeof raw.prepare;
  probe = spawn('bun', ['-e', `const ws=new WebSocket(${JSON.stringify(url)});let sent=0,at=0,stopped=false;const samples=[];const send=()=>{if(stopped){console.log(JSON.stringify({samples}));ws.close();return;}at=performance.now();ws.send(JSON.stringify({id:String(++sent),method:'system.health',data:{},type:'REQ',sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if((r.requestId??r.id)===String(sent)){if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);}};process.stdin.on('data',()=>{stopped=true;});setTimeout(()=>process.exit(2),120000).unref();`], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  probe.stdout!.on('data', (data) => { probeOutput += String(data); }); probe.stderr!.on('data', (data) => { probeErrors += String(data); });
  const probeExit = new Promise((resolve, reject) => { probe!.once('exit', resolve); probe!.once('error', reject); });
  for (let i = 0; i < 250 && !probeOutput.includes('READY'); i++) await wait(20);
  assert(probeOutput.includes('READY'), probeErrors);
  let last = performance.now(), maxLagMs = 0, peakRssBytes = process.memoryUsage().rss;
  timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 10);
  await wait(30); measuring = true;
  const calls: unknown[] = [];
  for (const [id, queryName, expectedReply] of [['full', 'messages.bySession', expected], ['compact', 'messages.bySession.compact', expectedCompact]] as const) {
    const at = performance.now(); await rpc('liveQuery.subscribe', { queryName, subscriptionId: id, params: [sessionId, 30] });
    const snapshot = events.find((event) => event.method === 'liveQuery.snapshot' && event.data.subscriptionId === id);
    assert(snapshot, 'No initial snapshot before subscribe acknowledgement'); assert.deepEqual(snapshot.data.rows, expectedReply.rows); assert.deepEqual(snapshot.data.metadata, expectedReply.metadata);
    calls.push({ queryName, ms: performance.now() - at, replyBytes: Buffer.byteLength(JSON.stringify(snapshot.data)), sha256: createHash('sha256').update(JSON.stringify(snapshot.data.rows)).digest('hex') });
    await rpc('liveQuery.unsubscribe', { subscriptionId: id }); await wait(30);
  }
  clearInterval(timer); timer = undefined; measuring = false;
  probe.stdin!.end('stop'); assert.equal(await probeExit, 0, probeErrors); const { samples } = JSON.parse(probeOutput.trim().split('\n').at(-1)!);
  assert(samples.length > 0); evidence.calls = calls; evidence.maxLagMs = maxLagMs; evidence.maxHealthMs = Math.max(...samples); evidence.healthReplies = samples.length;
  evidence.peakRssBytes = peakRssBytes; evidence.rssAfter = process.memoryUsage().rss; evidence.dbBytes = (await stat(join(run, 'data/daemon.db'))).size; evidence.walBytes = await stat(join(run, 'data/daemon.db-wal')).then((s) => s.size, () => 0);
  evidence.mainQueries = mainQueries; evidence.workerMetrics = workerMetrics; evidence.cloneMetrics = cloneMetrics;
  if (mode === 'verify') {
    assert(selectedWorker); const failed = rpc('liveQuery.subscribe', { queryName: 'messages.bySession', subscriptionId: 'death', params: [sessionId, 30] }).then(() => { throw new Error('Terminated read unexpectedly succeeded'); }, (error) => String(error));
    setTimeout(() => selectedWorker!.terminate(), 10); await wait(100); const at = performance.now(); assert.equal((await rpc('system.health') as { status: string }).status, 'ok'); evidence.deathHealthMs = performance.now() - at;
    evidence.workerDeath = await failed; assert(String(evidence.workerDeath).includes('SDK reader timeout'));
    await rpc('liveQuery.subscribe', { queryName: 'messages.bySession', subscriptionId: 'death', params: [sessionId, 30] }); await rpc('liveQuery.unsubscribe', { subscriptionId: 'death' }); evidence.recoveredAfterDeath = true;
  }
  evidence.afterBodies = hash(); assert.deepEqual(evidence.afterBodies, evidence.beforeBodies);
  evidence.verified = true;
  console.log(JSON.stringify({ mode, maxLagMs, maxHealthMs: evidence.maxHealthMs, calls, bodies: evidence.afterBodies }));
  if (mode === 'baseline') assert(maxLagMs > 100, 'No observed baseline main-thread stall; inconclusive'); else assert(maxLagMs < 1000);
} finally {
  if (timer) clearInterval(timer); probe?.kill(); ws.close(); const at = performance.now(); await app.cleanup(); evidence.shutdownMs = performance.now() - at; globalThis.Worker = OriginalWorker; offLogs(); await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
