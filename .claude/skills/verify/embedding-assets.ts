import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
const mode = process.argv[3] ?? 'recover';
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'])
  assert(!process.env[key]);
for (const name of ['bin', 'home', 'evidence']) mkdirSync(join(run, name), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const evidence: Record<string, unknown> = {
  platform: process.platform,
  arch: process.arch,
  runtime: Bun.version,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  mode,
  surface: 'isolated daemon embedding worker and work.find semantic-search RPC',
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
let heldBinding: string | undefined;
const originalNow = Date.now;
const require = createRequire(new URL('../../../packages/daemon/package.json', import.meta.url));
const binding = resolve(dirname(require.resolve('onnxruntime-node')), '../bin/napi-v6', process.platform, process.arch, 'onnxruntime_binding.node');
const NativeWorker = globalThis.Worker;
try {
  if (mode !== 'installed' && existsSync(binding)) {
    assert(realpathSync(binding).startsWith(resolve('node_modules') + '/'));
    heldBinding = binding + '.verify-' + crypto.randomUUID();
    renameSync(binding, heldBinding);
    evidence.maskedInstalledBinding = true;
  }
  if (mode === 'fault') {
    const fixture = join(run, 'embed-worker.ts');
    const entry = pathToFileURL(resolve('packages/daemon/src/storage/repositories/agent-memory-embed-worker.ts')).href;
    writeFileSync(fixture, 'import { appendFileSync } from "node:fs"; const original=fetch; globalThis.fetch=async(url,opts)=>{ if(String(url).startsWith("https://registry.npmjs.org/")){appendFileSync(' + JSON.stringify(join(run, 'evidence/fetches.jsonl')) + ',JSON.stringify({url:String(url)})+String.fromCharCode(10));return new Response("corrupt-runtime");}return original(url,opts);};await import(' + JSON.stringify(entry) + ');');
    globalThis.Worker = function(url: string | URL, options?: WorkerOptions) {
      return new NativeWorker(String(url).endsWith('/agent-memory-embed-worker.ts') ? pathToFileURL(fixture).href : url, options);
    } as unknown as typeof Worker;
  }
  app = await createDaemonApp({
    config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }),
    disableWorktrees: true,
    disableGoalProcessing: true,
    verbose: false,
  });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  evidence.port = app.server.port;
  socket = new WebSocket('ws://127.0.0.1:' + app.server.port + '/ws');
  await new Promise((resolve, reject) => { socket!.onopen = resolve; socket!.onerror = reject; });
  const call = (method: string, data: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error(method + ' timed out')), 120_000);
    socket!.onmessage = event => {
      const value = JSON.parse(String(event.data));
      if (value.requestId !== id && value.id !== id) return;
      clearTimeout(timer);
      if (value.error) reject(new Error(JSON.stringify(value.error)));
      else resolve(value.data);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  evidence.health = await call('system.health', {});
  if (mode === 'fault') {
    const errors: string[] = [];
    for (let index = 0; index < 10; index++) {
      try { await app.db.getEmbedder().embedQuery('checksum refusal'); }
      catch (error) { errors.push(String(error)); }
    }
    evidence.errors = errors;
    assert.equal(errors.length, 10);
    assert(errors.every(error => error.includes('Checksum mismatch')));
    const fetches = () => readFileSync(join(run, 'evidence/fetches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(fetches().length, 1);
    Date.now = () => originalNow() + 31_000;
    for (let index = 0; index < 5; index++) {
      try { await app.db.getEmbedder().embedQuery('retry after backoff'); }
      catch (error) { errors.push(String(error)); }
    }
    evidence.fetches = fetches();
    assert.equal(fetches().length, 2);
    assert.equal(errors.length, 15);
    assert.equal(new Set(errors).size, 1);
    evidence.passed = true;
  } else {
  const text = 'Scientists study the moon and collect rocks in space.';
  const vector = Float32Array.from(await app.db.getEmbedder().embedPassage(text));
  assert.equal(vector.length, 384);
  assert(vector.every(Number.isFinite));
  const norm = Math.hypot(...vector);
  assert(Math.abs(norm - 1) < 0.0001);
  evidence.vector = Array.from(vector);
  const db = app.db.getDatabase();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?)').run('embedding-proof', 'Synthetic sample', run, now, now, 'active', JSON.stringify({ model: 'default', provider: 'anthropic' }), '{}');
  const id = Number(db.prepare('INSERT INTO message_search_content(kind,source_id,message_id,session_id,message_type,title,body,timestamp) VALUES (?,?,?,?,?,?,?,?)').run('message', 'proof-source', 'proof-message', 'embedding-proof', 'user', 'Synthetic sample', text, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO message_search_vectors(content_id,model,dimensions,embedding,embedded_at) VALUES (?,?,?,?,?)').run(id, app.db.getEmbedder().model, 384, new Uint8Array(vector.buffer), Date.now());
  evidence.search = await call('operation.invoke', { name: 'work.find', input: { text: 'lunar geology', adapters: ['hyperneo'], localOnly: true } });
  assert(JSON.stringify(evidence.search).includes('embedding-proof'));
  assert(JSON.stringify(evidence.search).includes('semantic'));
  evidence.passed = true;
  }
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  socket?.close();
  try { await app?.cleanup(); }
  finally {
    Date.now = originalNow;
    globalThis.Worker = NativeWorker;
    if (heldBinding) renameSync(heldBinding, binding);
    writeFileSync(join(run, 'evidence/embedding-assets.json'), JSON.stringify(evidence, null, 2));
  }
}
