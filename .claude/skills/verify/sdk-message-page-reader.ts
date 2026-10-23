import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { capSdkMessage } from '../../../packages/daemon/src/lib/rpc-handlers/message-output-cap.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';

const [mode, run] = process.argv.slice(2);
assert(['baseline', 'verify'].includes(mode));
assert(run?.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await mkdir(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), sqlQueryObservability: { slowThresholdMs: 250, summaryIntervalMs: 300000, maxQueryGroups: 500, summaryQueryLimit: 10 }, port: 0, disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
const url = `ws://127.0.0.1:${app.server.port}/ws`;
assert.notEqual(app.server.port, 8399);
const ws = new WebSocket(url);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
ws.onmessage = ({ data }) => { const reply = JSON.parse(String(data)); const id = reply.requestId ?? reply.id; const p = pending.get(id); if (!p) return; pending.delete(id); reply.error ? p.reject(new Error(JSON.stringify(reply.error))) : p.resolve(reply.data); };
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('RPC socket failed')); });
const rpc = (method: string, data: unknown = {}) => new Promise<unknown>((resolve, reject) => { const id = crypto.randomUUID(); const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout ${method}`)); }, 60_000); pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } }); ws.send(JSON.stringify({ id, method, data, type: 'REQ', sessionId: 'global', version: '1.0.0', timestamp: new Date().toISOString() })); });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let probe: ReturnType<typeof spawn> | undefined;
let probeOutput = '', probeErrors = '';
let timer: ReturnType<typeof setInterval> | undefined;
const evidence: Record<string, unknown> = { mode, url, runtime: Bun.version };
let measuring = false;
const workerMetrics: unknown[] = [], mainQueries: { sql: string; ms: number }[] = [];
const cloneMetrics: unknown[] = [];
const OriginalWorker = globalThis.Worker;
let selectedWorker: Worker | undefined;
globalThis.Worker = function(url: string | URL, options?: WorkerOptions) {
  const worker = new OriginalWorker(url, options);
  if (String(url).endsWith('/sdk-status-worker.ts')) {
    selectedWorker = worker;
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: unknown) => { const at = performance.now(); post(message); if (measuring) cloneMetrics.push({ kind: 'argument', bytes: Buffer.byteLength(JSON.stringify(message)), postMs: performance.now() - at }); }) as typeof worker.postMessage;
    worker.addEventListener('message', ({ data }) => { if (measuring && data.result) cloneMetrics.push({ kind: 'reply', bytes: Buffer.byteLength(JSON.stringify(data.result)), replyAndQueueMs: Date.now() - data.finishedAt }); });
  }
  return worker;
} as unknown as typeof Worker;
const unsubscribe = subscribeToStructuredLogs((event) => { if (event.module === 'hyperneo:daemon:sqlite.worker' || event.metadata?.workerKind === 'sdk-status') workerMetrics.push(event.metadata); });
try {
  const session = await rpc('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic status read', config: { queryMode: 'manual' } }) as { sessionId: string };
  const sessionId = session.sessionId;
  const params = { sessionId, limit: 20 };
  const coldAt = performance.now();
  await rpc('message.sdkMessages', params);
  evidence.coldEmptyReadMs = performance.now() - coldAt;
  await wait(200);
  const large = 'complete tool output 🦊\n'.repeat(500_000);
  for (let i = 0; i < 24; i++) {
    await app.db.saveUserMessage(sessionId, { type:'user',uuid:`page-${i}`,parent_tool_use_id:null,message:{role:'user',content:[{type:'tool_result',tool_use_id:`tool-${i}`,content:large}]} } as SDKMessage, 'consumed');
    await wait(0);
  }
  await app.db.saveSDKMessage(sessionId,{type:'assistant',uuid:'parent',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:'page-child',name:'Bash',input:{}}]}} as SDKMessage);
  for(let i=0;i<5;i++) await app.db.saveUserMessage(sessionId,{type:'user',uuid:`child-${i}`,parent_tool_use_id:'page-child',message:{role:'user',content:[{type:'tool_result',tool_use_id:`child-tool-${i}`,content:large}]}} as SDKMessage,'consumed');
  await app.db.saveSDKMessage(sessionId,{type:'system',subtype:'task_started',uuid:'background',task_id:'page-task'} as SDKMessage);
  const raw = app.db.getDatabase();
  raw.prepare('UPDATE sdk_messages SET timestamp=? WHERE session_id=?').run('2026-10-21T12:00:00.000Z',sessionId);
  raw.exec('CREATE TABLE sdk_status_probe_counter(value INTEGER); INSERT INTO sdk_status_probe_counter VALUES(0)');
  const hash = () => {
    const h = createHash('sha256'); let count = 0, bytes = 0;
    for (const row of raw.prepare('SELECT COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq').iterate() as Iterable<{ body: string }>) { h.update(row.body); count++; bytes += Buffer.byteLength(row.body); }
    return { sha256: h.digest('hex'), count, bytes };
  };
  const expected = (query:Record<string,unknown>) => {
    const {messages,hasMore}=app.db.getSDKMessageRepo().getSDKMessages(sessionId,query.limit as number,query.before as number,query.since as number,query.beforeRowid as number,query.sinceRowid as number);
    return {sdkMessages:messages.map(capSdkMessage),hasMore,backgroundTaskMessages:app.db.getSDKMessageRepo().getBackgroundTaskMessages(sessionId).map(capSdkMessage)};
  };
  const latest=expected(params);
  assert(latest.sdkMessages.some((m)=>m.uuid==='child-0'),'child fixture must be reached');
  assert(latest.backgroundTaskMessages.some((m)=>m.uuid==='background'),'background fixture must be reached');
  const first=latest.sdkMessages[0] as {timestamp:number;rowid:number};
  const queries=[params,{...params,before:first.timestamp,beforeRowid:first.rowid},{...params,since:first.timestamp,sinceRowid:first.rowid}];
  queries.push(params);
  const expectations=queries.map(q=>JSON.parse(JSON.stringify(expected(q))));
  evidence.beforeBodies = hash();
  app.db.getSDKMessageRepo().flushMessageSearchIndex();
  Bun.gc(true);
  await wait(100);
  Bun.gc(true);
  const prepare = raw.prepare.bind(raw);
  raw.prepare = ((sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (!['get','all','run'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
      return (...values: unknown[]) => { const at = performance.now(); try { return value.apply(target, values); } finally { if (measuring) mainQueries.push({ sql, ms: performance.now()-at }); } };
    } });
  }) as typeof raw.prepare;
  console.log('Synthetic corpus ready', JSON.stringify(evidence.beforeBodies));
  probe = spawn('bun', ['-e', `import {Database} from ${JSON.stringify(new URL('../../../packages/daemon/src/storage/sqlite-compat.ts', import.meta.url).href)}; const db=new Database(${JSON.stringify(join(run,'data/daemon.db'))});db.exec('PRAGMA busy_timeout=1000;PRAGMA wal_autocheckpoint=0');let writes=0;const ws=new WebSocket(${JSON.stringify(url)});let sent=0,at=0,stopped=false;const samples=[];const send=()=>{if(stopped){db.close();console.log(JSON.stringify({samples,writes}));ws.close();return;}db.exec('BEGIN IMMEDIATE;UPDATE sdk_status_probe_counter SET value=value+1');const until=performance.now()+20;while(performance.now()<until){}db.exec('COMMIT');writes++;at=performance.now();ws.send(JSON.stringify({id:String(++sent),method:'system.health',data:{},type:'REQ',sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if((r.requestId??r.id)===String(sent)){if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);}};process.stdin.on('data',()=>{stopped=true;});setTimeout(()=>{process.exit(2);},60000).unref();`], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  probe.stdout!.on('data', (d) => { probeOutput += String(d); });
  probe.stderr!.on('data', (d) => { probeErrors += String(d); });
  const probeExit = new Promise((resolve, reject) => { probe!.once('exit', resolve); probe!.once('error', reject); });
  for (let n = 0; n < 250 && !probeOutput.includes('READY'); n++) await wait(20);
  assert(probeOutput.includes('READY'), probeErrors);
  let last = performance.now(), maxLagMs = 0;
  const rssBefore = process.memoryUsage().rss; let peakRssBytes = rssBefore;
  timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 10);
  await wait(30);
  measuring = true;
  const calls: { ms: number; replyHash: string }[] = [];
  for (let n = 0; n < queries.length; n++) {
    const at = performance.now();
    const reply = await rpc('message.sdkMessages', queries[n]);
    calls.push({ms:performance.now()-at,replyHash:createHash('sha256').update(JSON.stringify(reply)).digest('hex')});
    console.log('Page RPC',n,calls.at(-1));
    assert.deepEqual(reply,expectations[n]);
    await wait(30);
  }
  clearInterval(timer); timer = undefined;
  measuring = false;
  probe.stdin!.end('stop'); assert.equal(await probeExit, 0, probeErrors);
  const probeReport = JSON.parse(probeOutput.trim().split('\n').at(-1)!);
  const samples = probeReport.samples as number[]; evidence.competingWrites = probeReport.writes;
  evidence.walBytes = await stat(join(run, 'data/daemon.db-wal')).then((s) => s.size, () => 0);
  assert(samples.length > 0, 'Health probe returned no observations');
  evidence.calls = calls; evidence.maxLagMs = maxLagMs; evidence.healthReplies = samples.length; evidence.maxHealthMs = Math.max(...samples);
  evidence.rssBefore = rssBefore; evidence.peakRssBytes = peakRssBytes; evidence.rssAfterRequests = process.memoryUsage().rss;
  evidence.dbBytes = (await stat(join(run, 'data/daemon.db'))).size;
  evidence.rssBytes = process.memoryUsage().rss;
  evidence.mainQueries = mainQueries; evidence.workerMetrics = workerMetrics; evidence.cloneMetrics = cloneMetrics;
  if (mode === 'verify') {
    const interrupted = rpc('message.sdkMessages', params).then(() => { throw new Error('Injected worker failure returned success'); }, (error) => String(error));
    setTimeout(() => { selectedWorker!.terminate(); }, 10);
    await wait(100);
    const healthAt = performance.now();
    assert.equal((await rpc('system.health') as { status: string }).status, 'ok');
    evidence.deathHealthMs = performance.now() - healthAt; assert(Number(evidence.deathHealthMs) < 250);
    evidence.workerDeath = await interrupted;
    assert(String(evidence.workerDeath).includes('SDK reader timeout'));
    const recovered=await rpc('message.sdkMessages',params);
    assert.deepEqual(recovered,expectations[0]);
    evidence.recoveredAfterDeath = true;
  }
  evidence.afterBodies = hash(); assert.deepEqual(evidence.afterBodies, evidence.beforeBodies);
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ mode, maxLagMs, maxHealthMs: evidence.maxHealthMs, calls, bodies: evidence.afterBodies }));
  if (mode === 'baseline') assert(maxLagMs > 100, 'Synthetic baseline did not show a main-thread stall; inconclusive');
  else { assert(maxLagMs < 1000); assert(Number(evidence.maxHealthMs) < 250); }
} finally {
  if (timer) clearInterval(timer);
  probe?.kill(); ws.close(); const closeAt = performance.now(); await app.cleanup(); evidence.shutdownMs = performance.now() - closeAt;
  unsubscribe(); globalThis.Worker = OriginalWorker;
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
