import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv[2]);
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
  surface: 'isolated daemon embedding worker and work.find semantic-search RPC',
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let socket: WebSocket | undefined;
try {
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
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  socket?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/embedding-assets.json'), JSON.stringify(evidence, null, 2));
}
