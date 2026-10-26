import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { prepareWorkerSandbox, releaseWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
const workspace = join(run, 'workspace');
mkdirSync(join(workspace, '.git'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const env = await prepareWorkerSandbox(workspace);
const originalSpawn = Bun.spawn;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  const sessionId = 'synthetic-cleanup-diagnostic';
  const now = new Date().toISOString();
  await app.db.createSession({ id: sessionId, title: 'Synthetic cleanup diagnostic', workspacePath: workspace, createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const archive = () => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('archive timed out')), 30000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); ws!.removeEventListener('message', receive); done(reply);
    };
    ws!.addEventListener('message', receive);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'session.archive', data: { sessionId, confirmed: true }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  Bun.spawn = ((args, options) => {
    if (Array.isArray(args) && args.includes('worker-runtime-cleanup')) {
      args = [...args];
      args[args.indexOf('/bin/sh') + 2] = "printf 'synthetic cleanup mount diagnostic' >&2; exit 23";
    }
    return originalSpawn(args, options);
  }) as typeof Bun.spawn;
  let failed: Record<string, unknown>;
  try { failed = await archive(); } finally { Bun.spawn = originalSpawn; }
  const observed = { reply: failed, status: app.db.getSession(sessionId)?.status, tempRetained: existsSync(env.TMPDIR), cacheRetained: existsSync(env.XDG_CACHE_HOME) };
  writeFileSync(join(run, 'evidence/cleanup-diagnostic-rpc.json'), JSON.stringify(observed, null, 2));
  assert(JSON.stringify(failed.error).includes('synthetic cleanup mount diagnostic'), 'Archive RPC must preserve cleanup stderr');
  assert(JSON.stringify(failed.error).includes('23'), 'Archive RPC must identify the cleanup exit status');
  assert(observed.status !== 'archived' && observed.tempRetained && observed.cacheRetained);
  const retried = await archive();
  assert(!retried.error, JSON.stringify(retried));
  assert.equal(app.db.getSession(sessionId)?.status, 'archived');
  assert(!existsSync(env.TMPDIR) && !existsSync(env.XDG_CACHE_HOME));
  writeFileSync(join(run, 'evidence/cleanup-diagnostic-retry.json'), JSON.stringify(retried, null, 2));
  console.log('PASS actual archive RPC preserves helper stderr/exit status, remains unarchived on failure, and retries successfully');
} finally {
  Bun.spawn = originalSpawn;
  ws?.close();
  await app?.cleanup();
  await releaseWorkerSandbox(workspace);
}
process.exit(0);
