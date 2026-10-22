import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { WorkerAgentMemoryEmbedder } from '../../../packages/daemon/src/storage/repositories/agent-memory-worker-embedder.ts';
import { installWorkSearchWait } from './work-search-wait.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import type { PlaceGroup } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { SDKBunWorkerBridge } from '../../../packages/daemon/tests/helpers/sdk-bun-worker-bridge.ts';

const run = resolve(process.argv[2]);
const waitMs = Number(process.argv[3] ?? 1200);
const bridge = process.argv[4] === 'bridge';
const priority = process.argv[5] === 'priority';
const recovery = process.argv[5] === 'recovery';
const fanout = process.argv[5] === 'fanout' || recovery;
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) assert(!process.env[key], key);
for (const directory of ['home', 'data', 'bin', 'evidence']) mkdirSync(join(run, directory), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
symlinkSync(process.execPath, join(run, 'bin/bun'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
if (fanout) {
  mkdirSync(join(run, 'home/.codex'), { recursive: true });
  mkdirSync(join(run, 'home/.claude/projects'), { recursive: true });
  const state = new Database(join(run, 'home/.codex/state_5.sqlite'));
  state.exec('CREATE TABLE projects(id TEXT,name TEXT,updated_at_ms INTEGER); CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT); CREATE TABLE threads(id TEXT,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)');
  state.close();
}
const NativeWorker = globalThis.Worker;
const warm = WorkerAgentMemoryEmbedder.prototype.warm;
WorkerAgentMemoryEmbedder.prototype.warm = () => {};
const fixtureWorker = pathToFileURL(join(run, 'reader.ts')).href;
writeFileSync(join(run, 'reader.ts'), `import { installWorkSearchWait } from ${JSON.stringify(pathToFileURL(resolve('.claude/skills/verify/work-search-wait.ts')).href)}; installWorkSearchWait(${JSON.stringify(run)}, ${waitMs}, 'worker', ${priority}); const pending=[]; globalThis.onmessage=e=>pending.push(e); await import(${JSON.stringify(pathToFileURL(resolve('packages/daemon/src/storage/sdk-status-worker.ts')).href)}); const dispatch=globalThis.onmessage; for(const event of pending) dispatch(event);`);
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    if (bridge && String(url).endsWith('/sdk-status-worker.ts'))
      return new SDKBunWorkerBridge(fixtureWorker) as unknown as Worker;
    super(String(url).endsWith('/sdk-status-worker.ts') ? fixtureWorker : url, options);
  }
};
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, verbose: false });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
hub.registerTransport(transport);
let timer: ReturnType<typeof setInterval> | undefined;
let probe: ReturnType<typeof spawn> | undefined;
const evidence: Record<string, unknown> = { waitMs, limitation: 'The explicit executing-thread wait models slow storage; it does not reproduce or attribute the live 4.3s physical disk cause. No-delay control is separate.' };
try {
  await transport.initialize();
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { title: 'Synthetic vector history', workspacePath: join(run, 'home'), config: { queryMode: 'manual' } });
  const embedder = app.db.getEmbedder();
  const vector = Float32Array.from({ length: embedder.dimensions }, (_, i) => i === 0 ? 1 : 0);
  embedder.embedQuery = async () => vector;
  const db = app.db.getDatabase();
  const insert = db.prepare(`INSERT INTO message_search_content(kind,source_id,message_id,session_id,message_type,title,body,timestamp) VALUES ('message',?,?,?,'assistant','Retained history',?,?)`);
  const save = db.prepare(`INSERT INTO message_search_vectors(content_id,model,dimensions,embedding,embedded_at) VALUES (?,?,?,?,1)`);
  const body = 'Complete synthetic retained history. '.repeat(120);
  for (let offset = 0; offset < 10020; offset += 1000) {
    db.transaction(() => {
      for (let i = offset; i < Math.min(10020, offset + 1000); i++) {
        const id = insert.run(`retained-${i}`, `message-${i}`, sessionId, body, i).lastInsertRowid;
        save.run(id, embedder.model, vector.length, new Uint8Array(vector.buffer));
      }
    })();
    await Bun.sleep(0);
  }
  if (fanout) {
    const id = db.prepare("INSERT INTO message_search_content(kind,source_id,message_id,session_id,message_type,title,body,timestamp) VALUES ('claude','synthetic-claude','claude-message','synthetic-claude','assistant','Retained Claude history',?,1)").run(body).lastInsertRowid;
    save.run(id, embedder.model, vector.length, new Uint8Array(vector.buffer));
  }
  const hash = () => {
    const digest = createHash('sha256');
    for (const row of db.prepare(`SELECT m.id,m.body,v.embedding FROM message_search_content m JOIN message_search_vectors v ON v.content_id=m.id ORDER BY m.id`).iterate() as Iterable<{ id: number; body: string; embedding: Uint8Array }>) digest.update(String(row.id)).update(row.body).update(row.embedding);
    return digest.digest('hex');
  };
  const before = hash();
  await hub.request('session.messages.byStatus', { sessionId, status: 'consumed', limit: 1 });
  const expected = app.db.getSDKMessageRepo().searchWorkChats('unmatched quokka', 200, { model: embedder.model, vector }, ['message', 'task']);
  assert.equal(expected[0].sessionId, sessionId);
  installWorkSearchWait(run, waitMs, 'main', priority);
  let output = '', errors = '';
  if (waitMs) {
    probe = spawn(process.execPath, ['-e', `import {existsSync} from 'node:fs';const ws=new WebSocket('ws://127.0.0.1:${app.server.port}/ws');let at;ws.onopen=()=>{console.log('READY');const t=setInterval(()=>{if(existsSync(${JSON.stringify(join(run, 'read-started'))})){clearInterval(t);at=performance.now();ws.send(JSON.stringify({id:'health',type:'REQ',method:'system.health',data:{},sessionId:'global',version:'1.0.0',timestamp:new Date().toISOString()}));}},1);};ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.requestId==='health'){console.log(JSON.stringify({ms:performance.now()-at,data:r.data}));ws.close();}};`], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    probe.stdout!.on('data', data => { output += data; });
    probe.stderr!.on('data', data => { errors += data; });
    for (let i = 0; !output.includes('READY') && i < 200; i++) await Bun.sleep(10);
    assert(output.includes('READY'), errors);
  }
  let previous = performance.now(), lagMs = 0;
  timer = setInterval(() => { const now = performance.now(); lagMs = Math.max(lagMs, now - previous - 10); previous = now; }, 10);
  await Bun.sleep(20);
  const started = performance.now();
  const requestSearch = (text: string) => hub.request<{ places: PlaceGroup[]; unreachable: { source: string; reason: string }[] }>('operation.invoke', { name: 'work.find', input: { text, localOnly: true, adapters: fanout ? ['hyperneo', 'codex-desktop', 'claude-code'] : ['hyperneo'], limit: 20 } });
  const firstSearch = requestSearch('unmatched quokka');
  const retries: Awaited<ReturnType<typeof requestSearch>>[] = [];
  let rejectedAt = 0;
  const order: string[] = [];
  const sdkMs: Record<string, number> = {};
  let queued: Promise<unknown>[] = [];
  if (priority) {
    for (let i = 0; !existsSync(join(run, 'read-started')) && i < 200; i++) await Bun.sleep(5);
    queued = [requestSearch('unmatched wombat').then(() => order.push('search'))];
    await Bun.sleep(50);
    queued.push(hub.request('session.messages.byStatus', { sessionId, status: 'consumed', limit: 1 }).then(() => { order.push('status'); sdkMs.status = performance.now() - started; }));
    queued.push(hub.request('message.sdkMessages', { sessionId, limit: 1 }).then(() => { order.push('page'); sdkMs.page = performance.now() - started; }));
  }
  if (recovery) {
    for (let i = 0; !existsSync(join(run, 'read-started')) && i < 200; i++) await Bun.sleep(5);
    retries.push(await requestSearch('unmatched wombat'));
    rejectedAt = performance.now();
  }
  const found = await firstSearch;
  const rpcMs = performance.now() - started;
  if (recovery) retries.push(await requestSearch('unmatched wombat'));
  const retryAfterMs = recovery ? performance.now() - rejectedAt : null;
  await Bun.sleep(20);
  clearInterval(timer);
  timer = undefined;
  for (let i = 0; waitMs && output.trim().split('\n').length < 2 && i < 200; i++) await Bun.sleep(10);
  const health = waitMs ? JSON.parse(output.trim().split('\n').at(-1)!) : null;
  const ids = found.places.flatMap(place => place.work.map(work => work.ref.id));
  await Promise.all(queued);
  Object.assign(evidence, { rpcMs, lagMs, result: found, bridge, order, sdkMs, retries, retryAfterMs });
  if (priority) assert(Object.values(sdkMs).every(ms => ms < waitMs * 1.5), 'SDK reads queued behind the second search');
  assert(ids.includes(sessionId), JSON.stringify(found));
  const observed = found.places.flatMap(place => place.work).find(work => work.ref.id === sessionId)!;
  assert.equal(observed.hits, expected[0].hits);
  assert.equal(observed.score, expected[0].score);
  assert.equal(observed.lastHitAt, expected[0].lastHitAt);
  assert.deepEqual(observed.snippets?.map(({ match, at, role, text, handle }) => ({ match, at, role, text, messageId: handle.messageId, sessionId: handle.sessionId })), expected[0].snippets);
  const after = hash();
  const reads = readFileSync(join(run, 'evidence/vector-reads.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  Object.assign(evidence, { sessionId, retainedRows: fanout ? 10021 : 10020, before, after, rpcMs, lagMs, health, reads, result: found, runtime: Bun.version });
  console.log(JSON.stringify(evidence, null, 2));
  assert.equal(before, after);
  if (fanout) { assert.deepEqual(found.unreachable, []); assert(ids.includes('synthetic-claude'), 'Claude search result lost from fanout'); }
  if (recovery) { assert(retries[0].unreachable.some(r => r.reason.includes('queue full'))); assert(retryAfterMs! < 2000); assert.deepEqual(retries[1].unreachable, []); const ids = retries[1].places.flatMap(g => g.work.map(w => w.ref.id)); assert(ids.includes(sessionId) && ids.includes('synthetic-claude')); }
  assert(lagMs < 1000, 'work.find blocked the event loop >=1s');
  if (waitMs) { assert.equal(health.data.status, 'ok'); assert(health.ms < 250, 'Independent health blocked behind work.find'); }
  else { assert(rpcMs < 250, 'Natural work.find exceeded250ms'); assert(reads.every(r => r.sqlMs < 250)); }
} finally {
  if (timer) clearInterval(timer);
  probe?.kill();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
  globalThis.Worker = NativeWorker;
  WorkerAgentMemoryEmbedder.prototype.warm = warm;
}
