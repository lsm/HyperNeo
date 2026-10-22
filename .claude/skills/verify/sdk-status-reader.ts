import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const [mode, run] = process.argv.slice(2);
assert(['baseline', 'verify'].includes(mode));
assert(run?.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await mkdir(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), port: 0, disableWorktrees: true, disableGoalProcessing: true }, standalone: false, verbose: false });
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
const evidence: Record<string, unknown> = { mode, url, runtime: process.version };
try {
  const session = await rpc('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic status read', config: { queryMode: 'manual' } }) as { sessionId: string };
  const sessionId = session.sessionId;
  const params = { sessionId, status: 'consumed', limit: 20 };
  await rpc('session.messages.byStatus', params);
  await wait(200);
  const large = 'A'.repeat(4 * 1024 * 1024);
  const expected: string[] = [];
  for (let i = 0; i < 24; i++) {
    const text = `Complete text ${i} 🦊\n`;
    expected.push(text);
    app.db.saveUserMessage(sessionId, { type: 'user', uuid: `synthetic-${i}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }, ...Array.from({ length: 3 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: large } }))] } } as SDKMessage, 'consumed');
    await wait(0);
  }
  app.db.saveSDKMessage(sessionId, { type: 'user', uuid: 'complete-tool', parent_tool_use_id: null, isReplay: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-tool', content: 'tool-result-kept-forever\n'.repeat(50_000) }] } } as SDKMessage);
  const raw = app.db.getDatabase();
  const hash = () => {
    const h = createHash('sha256'); let count = 0, bytes = 0;
    for (const row of raw.prepare('SELECT COALESCE(b.sdk_message,m.sdk_message) AS body FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq').iterate() as Iterable<{ body: string }>) { h.update(row.body); count++; bytes += Buffer.byteLength(row.body); }
    return { sha256: h.digest('hex'), count, bytes };
  };
  evidence.beforeBodies = hash();
  console.log('Synthetic corpus ready', JSON.stringify(evidence.beforeBodies));
  probe = spawn('bun', ['-e', `const ws=new WebSocket(${JSON.stringify(url)});let sent=0,at=0,stopped=false;const samples=[];const send=()=>{if(stopped){console.log(JSON.stringify({samples}));ws.close();return;}at=performance.now();ws.send(JSON.stringify({id:String(++sent),method:'system.health',data:{},type:'REQ',sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));};ws.onopen=()=>{console.log('READY');send();};ws.onmessage=e=>{const r=JSON.parse(e.data);if((r.requestId??r.id)===String(sent)){if(r.error)throw new Error(JSON.stringify(r.error));samples.push(performance.now()-at);setTimeout(send,10);}};process.stdin.on('data',()=>{stopped=true;});setTimeout(()=>{process.exit(2);},60000).unref();`], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  probe.stdout!.on('data', (d) => { probeOutput += String(d); });
  probe.stderr!.on('data', (d) => { probeErrors += String(d); });
  const probeExit = new Promise((resolve, reject) => { probe!.once('exit', resolve); probe!.once('error', reject); });
  for (let n = 0; n < 250 && !probeOutput.includes('READY'); n++) await wait(20);
  assert(probeOutput.includes('READY'), probeErrors);
  let last = performance.now(), maxLagMs = 0;
  timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
  await wait(30);
  const calls: { ms: number; replyHash: string }[] = [];
  for (let n = 0; n < 3; n++) {
    const at = performance.now();
    const reply = await rpc('session.messages.byStatus', params) as { messages: { text: string }[]; total: number };
    calls.push({ ms: performance.now() - at, replyHash: createHash('sha256').update(JSON.stringify(reply)).digest('hex') });
    console.log('Status RPC', n, calls.at(-1));
    assert.equal(reply.total, 24); assert.deepEqual(reply.messages.map((m) => m.text), expected.slice(0,20));
    await wait(30);
  }
  clearInterval(timer); timer = undefined;
  probe.stdin!.end('stop'); assert.equal(await probeExit, 0, probeErrors);
  const samples = JSON.parse(probeOutput.trim().split('\n').at(-1)!).samples as number[];
  assert(samples.length > 0, 'Health probe returned no observations');
  evidence.calls = calls; evidence.maxLagMs = maxLagMs; evidence.healthReplies = samples.length; evidence.maxHealthMs = Math.max(...samples);
  evidence.afterBodies = hash(); assert.deepEqual(evidence.afterBodies, evidence.beforeBodies);
  evidence.dbBytes = (await stat(join(run, 'data/daemon.db'))).size;
  evidence.rssBytes = process.memoryUsage().rss;
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ mode, maxLagMs, maxHealthMs: evidence.maxHealthMs, calls, bodies: evidence.afterBodies }));
  if (mode === 'baseline') assert(maxLagMs > 100, 'Synthetic baseline did not show a main-thread stall; inconclusive');
  else { assert(maxLagMs < 1000); assert(Number(evidence.maxHealthMs) < 250); }
} finally {
  if (timer) clearInterval(timer);
  probe?.kill(); ws.close(); await app.cleanup();
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
